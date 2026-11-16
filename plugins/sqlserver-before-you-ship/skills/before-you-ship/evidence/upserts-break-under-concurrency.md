# Upserts break under concurrency: evidence

The card: [Upserts break under concurrency](../cards/upserts-break-under-concurrency.md)

Swart's preferred shape when updates are the common case, reformatted:

```sql
SET XACT_ABORT ON;

BEGIN TRANSACTION;

    UPDATE TOP (1)
        ad
    SET
        ad.Etc = @Etc
    FROM dbo.AccountDetails AS ad
        WITH (UPDLOCK, SERIALIZABLE)
    WHERE ad.Email = @Email;

    IF @@ROWCOUNT = 0
    BEGIN
        INSERT
            dbo.AccountDetails
        (
            Email,
            Etc
        )
        VALUES
        (
            @Email,
            @Etc
        );
    END;

COMMIT TRANSACTION;
```

If inserts are the common case, flip it. The `INSERT` goes first, guarded by a `NOT EXISTS` check, and that check is where the hints go. The `UPDATE` only runs when [@@ROWCOUNT](https://learn.microsoft.com/en-us/sql/t-sql/functions/rowcount-transact-sql) comes back zero:

```sql
SET XACT_ABORT ON;

BEGIN TRANSACTION;

    INSERT
        dbo.AccountDetails
    (
        Email,
        Etc
    )
    SELECT
        @Email,
        @Etc
    WHERE NOT EXISTS
    (
        SELECT
            1/0
        FROM dbo.AccountDetails AS ad
            WITH (UPDLOCK, SERIALIZABLE) /*The hints go on the existence check*/
        WHERE ad.Email = @Email
    );

    IF @@ROWCOUNT = 0
    BEGIN
        UPDATE TOP (1)
            ad
        SET
            ad.Etc = @Etc
        FROM dbo.AccountDetails AS ad
        WHERE ad.Email = @Email;
    END;

COMMIT TRANSACTION;
```

With 20 sessions racing to upsert the same brand-new email every 20 ms for 15 seconds, this version had no primary key violations or deadlocks, with optimized locking and [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) (Read Committed Snapshot Isolation) on or off. Without the hints, it threw 26 violations under the default read committed, 886 with RCSI on, and 1,979 with optimized locking and RCSI both on. Under RCSI, the `NOT EXISTS` check reads the last committed version, so it can't see another session's insert that hasn't committed yet.

Either way, test with many sessions hitting it at once before you trust it, because every broken pattern passes a single-threaded test.

Optimized locking on **SQL Server 2025** doesn't change the fix. With it on, the `UPDLOCK`, `SERIALIZABLE` versions and `MERGE` with `HOLDLOCK` had no violations or deadlocks, with or without RCSI.

It makes one broken pattern worse. With RCSI on as well, lock after qualification lets an unhinted `UPDATE` judge rows by their last committed version. So it finds nothing to update while another session's insert is still uncommitted. An `UPDATE`-then-`INSERT` with no hints that almost never failed otherwise threw 195 to 1,829 primary key violations per four-second test.

Sources, all by Michael J. Swart: [Mythbusting: Concurrent Update/Insert Solutions](https://michaeljswart.com/2011/09/mythbusting-concurrent-updateinsert-solutions/) (2011), [SQL Server UPSERT Patterns and Antipatterns](https://michaeljswart.com/2017/07/sql-server-upsert-patterns-and-antipatterns/) (2017), [UPSERT Requires a Unique Index](https://michaeljswart.com/2022/03/upsert-requires-a-unique-index/) (2022).
