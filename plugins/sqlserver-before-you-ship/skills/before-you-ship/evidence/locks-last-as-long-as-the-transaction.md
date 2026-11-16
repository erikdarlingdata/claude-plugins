# Locks last as long as the transaction: evidence

The card: [Locks last as long as the transaction](../cards/locks-last-as-long-as-the-transaction.md)

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
