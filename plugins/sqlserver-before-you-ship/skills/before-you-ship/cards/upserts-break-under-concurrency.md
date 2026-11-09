# Upserts break under concurrency

Where it sits in the chart: A query > No NOLOCK > It changes data > "Is it an upsert?" (Update it if it's there, insert it if it isn't)

An upsert updates the row if it's there and inserts it if it isn't. It's an upsert whether you write it as [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql) or as [IF EXISTS](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/exists-transact-sql) then `UPDATE` else `INSERT`. Run single-threaded, every way of writing that works. Run concurrently, nearly all of them fail.

Michael J. Swart tested the usual suspects. `IF EXISTS` then `UPDATE` else `INSERT`, the same thing wrapped in a transaction, and plain `MERGE` all produced primary key violations, so being one statement doesn't save `MERGE`. In his words, it's "not isolated enough."

## What it costs

Two lock hints on the existence check, [UPDLOCK](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table) and `SERIALIZABLE`, so it holds a key-range lock (a lock on a range of key values) until the transaction ends. On a `MERGE`, `HOLDLOCK` (another name for `SERIALIZABLE`) alone is enough, because `MERGE` already reads its target with update locks. `UPDLOCK` alone under read committed (SQL Server's default isolation level) still loses the race, because you can't lock a row that doesn't exist yet without a key-range lock.

## What it risks

`SERIALIZABLE` by itself on a separate existence check swaps primary key violations for deadlocks: both sessions take shared key-range locks, then both try to insert. In Swart's 2011 tests, 82% of calls died as deadlock victims. On separate statements it takes both hints together.

## How fast it works

Immediately: the violations stop when the hinted version deploys. Pick the shape for your workload, update-first if the row usually exists and insert-first if it usually doesn't, so the common case takes one statement. Swart's advice is to pay "very close attention to your average use case."

## When it backfires

Unique data isn't a unique index. If you don't declare the key unique, SQL Server takes key-range locks out to infinity. Then concurrent upserts that check with `IF EXISTS`, or update first without [TOP](https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql) (1), deadlock anyway, hints and all.

## Deeper dive

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

## Reading

- [Mythbusting: Concurrent Update/Insert Solutions](https://michaeljswart.com/2011/09/mythbusting-concurrent-updateinsert-solutions/) (Michael J. Swart)
- [SQL Server UPSERT Patterns and Antipatterns](https://michaeljswart.com/2017/07/sql-server-upsert-patterns-and-antipatterns/) (Michael J. Swart)
- [UPSERT Requires a Unique Index](https://michaeljswart.com/2022/03/upsert-requires-a-unique-index/) (Michael J. Swart)
- [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql)
- [IF EXISTS](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/exists-transact-sql)
- [UPDLOCK](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table)
- [TOP](https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql)
- [@@ROWCOUNT](https://learn.microsoft.com/en-us/sql/t-sql/functions/rowcount-transact-sql)
- [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide)
