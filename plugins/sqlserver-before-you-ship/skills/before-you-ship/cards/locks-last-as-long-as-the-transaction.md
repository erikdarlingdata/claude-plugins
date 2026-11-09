# Locks last as long as the transaction

Where it sits in the chart: A query > No NOLOCK > It changes data > "How long are you holding locks?" (Every lock lasts until the transaction ends)

Modifications take exclusive locks, and those locks stay put until the transaction commits or rolls back, not until the statement finishes. A transaction that updates one table and then runs a slow query against another is still blocking everyone who wants the first table. And nothing in SQL Server decides when a wait is long enough. Unless someone set [LOCK_TIMEOUT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-lock-timeout-transact-sql) (a session setting that caps lock waits), the application's timeout is the only thing that ends the wait.

## What it costs

Keeping transactions short takes some design work. Do the slow reads, the calculations, and the calls out to anything else before `BEGIN TRANSACTION`, not inside it.

## What it risks

Without an index to seek with, a modification reads past every row in the table and waits on any of them someone else locked. That includes rows it was never going to change. And after roughly 5,000 locks on one index or partition, SQL Server tries to escalate to a table or partition lock, retrying every 1,250 locks after that, and once escalation lands, everyone else waits.

Optimized locking (one transaction lock in place of row and page locks) is always on in **Azure SQL Database** and off by default in **SQL Server 2025** (not in **Express**). It mostly stops escalation, but every row a modification changes stays locked until it commits. With [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) (Read Committed Snapshot Isolation) on as well, it adds lock after qualification: a modification checks its `WHERE` clause against the last committed version of each row without locking it, and only locks the rows that qualify, so it stops waiting on locked rows it was never going to change.

## How fast it works

Immediate. Locks release at `COMMIT`, so every second you cut from a transaction comes off every wait queued behind it.

## When it backfires

Splitting work into short transactions that each leave the data half-done. Short is good, but short and inconsistent is a bug. Keep work that must succeed or fail together in one transaction, and make that transaction fast.

## Deeper dive

Two rows, two query windows. In the first, delete a row and leave the transaction open:

```sql
CREATE TABLE
    dbo.TwoRows
(
    id tinyint NOT NULL
       PRIMARY KEY CLUSTERED,
    name varchar(10) NOT NULL
);

INSERT
    dbo.TwoRows
(
    id,
    name
)
VALUES
     (1, 'one'),
     (2, 'two');

BEGIN TRANSACTION;
    DELETE
        tr
    FROM dbo.TwoRows AS tr
    WHERE tr.id = 1;

/*Once you're done with the second window:
ROLLBACK TRANSACTION;
*/
```

In the second window, ask for the other row, then the locked one:

```sql
SELECT
    tr.*
FROM dbo.TwoRows AS tr
WHERE tr.id = 2; /*Fine*/

SELECT
    tr.*
FROM dbo.TwoRows AS tr
WHERE tr.id = 1; /*Waits until the first window commits or rolls back*/
```

The index is what lets both queries seek straight to their own row. Without it, the `SELECT` for row 2 has to scan and runs into locked row 1 on the way. It waits on a row it doesn't even want.

This is the default locking read committed. Under Read Committed Snapshot Isolation (RCSI, the default in **Azure SQL Database**), the second `SELECT` reads the last committed version and doesn't wait.

Optimized locking alone doesn't change that: with it on and RCSI off, the `SELECT` for row 1 still waited on the first window's transaction. With it on, a modification swaps its row and page locks for one transaction lock that still blocks those rows until commit. That mostly stops escalation: in a test, a 100,000-row `UPDATE` on a clustered table held three locks and never escalated.

With RCSI on too, optimized locking adds lock after qualification. A modification checks its `WHERE` clause against the last committed version of each row without locking it, and only takes a lock on the rows that qualify. This update has no index on name to seek with, so it scans past row 1:

```sql
/*Second window, with the first still open*/
UPDATE
    tr
SET
    tr.name = 'two'
FROM dbo.TwoRows AS tr
WHERE tr.name = 'two';
```

With optimized locking and RCSI both on, it finished in 3 ms. With either one off, it waited on row 1 until a 2-second `LOCK_TIMEOUT` ran out. Lock after qualification steps aside for:

- [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql) statements
- [UPDLOCK](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table) and similar hints
- an [OUTPUT](https://learn.microsoft.com/en-us/sql/t-sql/queries/output-clause-transact-sql) clause that returns rows or fills a table variable
- any isolation level other than read committed
- plans that find the rows to change through more than one index at once
- tables with a columnstore index
- statements that assign variables

In the test, adding `OUTPUT` or `UPDLOCK`, or writing it as a `MERGE`, each put the wait back. In a separate test on a 10,000-row table, index intersection and index union plans waited on the locked row, while a nonclustered seek with a key lookup, a self-join, and an [EXISTS](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/exists-transact-sql) against the same table all went right past it. Turning it on takes accelerated database recovery first, with your database's name in both places:

```sql
USE master;

/*Optimized locking needs accelerated database recovery first*/
ALTER DATABASE
    YourDatabase
SET ACCELERATED_DATABASE_RECOVERY = ON;

ALTER DATABASE
    YourDatabase
SET OPTIMIZED_LOCKING = ON;
```

Readers can block writers too. Key lookups can hold shared locks to the end of the statement, and hints like `UPDLOCK` or `SERIALIZABLE` make a `SELECT` lock like a modification. If a read is blocking a write, that's usually why.

## Reading

- [Learn T-SQL With Erik: Transactions and Blocking and Confusion](https://erikdarling.com/learn-t-sql-with-erik-transactions-and-blocking-and-confusion/)
- [WhatsUpLocks, a helper view for seeing who holds which locks](https://go.erikdarling.com/WhatsUpLocks) (GitHub)
- [Optimized locking](https://learn.microsoft.com/en-us/sql/relational-databases/performance/optimized-locking) (Microsoft Learn)
