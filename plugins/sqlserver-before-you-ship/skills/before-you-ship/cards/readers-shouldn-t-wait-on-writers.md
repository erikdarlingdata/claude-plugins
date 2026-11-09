# Readers shouldn't wait on writers

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "Is it waiting on writers?" (Readers blocked by modifications, the reason NOLOCK gets added)

Under SQL Server's default, read committed, a query that wants a row another transaction is changing waits until that transaction finishes. That's the blocking that sends people to [NOLOCK](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table), which stops the waiting by reading data that can get rolled back.

Read Committed Snapshot Isolation ([RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide)) stops it properly: readers get the last committed version of the row and keep going, and writers keep writing. It's a database setting, on by default in **Azure SQL Database**, and most other database engines work this way out of the box.

It fixes readers. Writers still block writers.

## What it costs

Row versions. Every `UPDATE` and `DELETE` copies the old row to the version store. The version store lives in tempdb, or inside the database when Accelerated Database Recovery is on (**SQL Server 2019+**).

Every row inserted or modified while RCSI is on also picks up 14 bytes of row versioning information. In a test, updating every row of a full table grew rows from 220 to 234 bytes and doubled its pages through page splits. Writes get a little slower so reads stop waiting.

## What it risks

Code that relied on the waiting. A query that reads a row and then writes based on what it saw used to wait for the writer and see the new value. Under RCSI, it sees the old value right away.

Find those spots and give them the locking read back with a `READCOMMITTEDLOCK` hint, or `UPDLOCK` when the read is part of a write. When it decides whether to insert, add `SERIALIZABLE`, the way [Upserts break under concurrency](upserts-break-under-concurrency.md) does.

## How fast it works

As soon as the setting takes, which is the hard part. `ALTER DATABASE ... SET READ_COMMITTED_SNAPSHOT ON` waits until no other connection is in the database, idle ones included. Run it at a quiet time, or add `WITH ROLLBACK IMMEDIATE`, which rolls back other sessions' open transactions and disconnects them.

## When it backfires

Long-running transactions. Versions stay until the oldest transaction that can still need them finishes, so one open transaction lets the version store grow until it commits. In a test, 148 MB of versions sat in tempdb for the three minutes a transaction stayed open. They were gone within a minute of the commit. [Transactions you didn't know you opened](transactions-you-didn-t-know-you-opened.md) covers how those happen.

## Deeper dive

A table with a balance to fight over:

```sql
CREATE TABLE
    dbo.Accounts
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    balance decimal(19, 2) NOT NULL,
    filler char(200) NOT NULL
        DEFAULT 'x'
);

INSERT
    dbo.Accounts
WITH
    (TABLOCK)
(
    id,
    balance
)
SELECT TOP (100000)
    id = ROW_NUMBER() OVER (ORDER BY 1/0),
    balance = 100
FROM sys.all_columns AS ac1
CROSS JOIN sys.all_columns AS ac2;
```

Two query windows, under the default read committed. In the first, change a balance and leave the transaction open:

```sql
/*Window 1: change a balance, and keep the transaction open*/
BEGIN TRANSACTION;

UPDATE
    a
SET
    a.balance = 0
FROM dbo.Accounts AS a
WHERE a.id = 1;
```

In the second, read it both ways:

```sql
/*Window 2: the NOLOCK way*/
SELECT
    a.balance
FROM dbo.Accounts AS a WITH (NOLOCK)
WHERE a.id = 1;

/*Window 2 again: a plain read*/
SELECT
    a.balance
FROM dbo.Accounts AS a
WHERE a.id = 1;
```

On **SQL Server 2025**, the `NOLOCK` read came back in 4 ms with a balance of 0.00. The plain read waited until window 1 rolled back, about 3 seconds later in the test:

```sql
/*Window 1: the change failed after all*/
ROLLBACK TRANSACTION;
```

That 0.00 never existed, and `NOLOCK` returned it anyway. Now turn RCSI on from a third window, with your database's name in both places:

```sql
USE master;

/*WITH ROLLBACK IMMEDIATE rolls back and disconnects every other session in the database*/
ALTER DATABASE
    YourDatabase
SET READ_COMMITTED_SNAPSHOT ON
WITH ROLLBACK IMMEDIATE;

SELECT
    d.name,
    d.is_read_committed_snapshot_on
FROM sys.databases AS d
WHERE d.name = N'YourDatabase';
```

Reconnect windows 1 and 2, and run the same steps again. The plain read came back in 4 ms with 100.00, the last committed balance, while window 1 still held its lock. `NOLOCK` still returned the 0.00 that was about to be rolled back. RCSI fixes plain reads, not hinted ones, so the hints have to come out too.

For code that needs the old behavior, ask for the locking read on that one query:

```sql
/*Window 2: the locking read, on purpose*/
SELECT
    a.balance
FROM dbo.Accounts AS a WITH (READCOMMITTEDLOCK)
WHERE a.id = 1;
```

It waited for window 1 again, about 3 seconds in the test, and read the committed value. **SQL Server 2025**'s optimized locking is no substitute for RCSI here: with it on and RCSI off, the plain read still waited for window 1. It needs Accelerated Database Recovery, which versions rows even with RCSI off. Updating every row grew them from 220 to 256 bytes, where RCSI alone grew them to 234, and doubled the pages the same way.

Keeping an eye on the version store:

```sql
SELECT
    database_name = DB_NAME(vs.database_id),
    version_store_mb = vs.reserved_space_kb / 1024.
FROM sys.dm_tran_version_store_space_usage AS vs
WHERE vs.reserved_space_kb > 0
ORDER BY
    vs.reserved_space_kb DESC;

/*The longest-running transactions that can hold versions in place*/
SELECT TOP (5)
    t.session_id,
    t.elapsed_time_seconds
FROM sys.dm_tran_active_snapshot_database_transactions AS t
ORDER BY
    t.elapsed_time_seconds DESC;
```

With nothing left open, the 148 MB of versions from five updates of every row cleared within a minute in the test. With a transaction open in another window, the same 148 MB stayed for as long as it was open. With Accelerated Database Recovery on, the first query shows nothing for the database. Versions go to its persistent version store instead, and [sys.dm_tran_persistent_version_store_stats](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-tran-persistent-version-store-stats) is where to watch them.

From the course: Snapshot Isolation is the opt-in sibling. `ALTER DATABASE ... SET` [ALLOW_SNAPSHOT_ISOLATION](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-set-options) `ON` allows it, and only sessions that run `SET TRANSACTION ISOLATION LEVEL SNAPSHOT` use it. That makes it a way to try specific queries before turning RCSI on for everyone. But every write in the database starts creating row versions as soon as it's allowed.

It reads as of the transaction's first data access rather than each statement's start. When two snapshot transactions update the same row, the second waits for the first, then fails with error 3960 once the first commits.

Neither one removes every reader-writer wait: foreign key validation still takes shared locks, cascades still run at serializable, and some indexed view maintenance still blocks.

## Reading

- [Read Committed Is A Garbage Isolation Level In SQL Server](https://erikdarling.com/read-committed-is-a-garbage-isolation-level/)
- [How To Tell You Need An Optimistic Isolation Level In SQL Server](https://erikdarling.com/how-to-tell-you-need-an-optimistic-isolation-level-in-sql-server/)
- [The Difference Between Read Committed And Read Committed Snapshot Isolation In SQL Server](https://erikdarling.com/the-difference-between-read-committed-and-read-committed-snapshot-isolation-in-sql-server/)
