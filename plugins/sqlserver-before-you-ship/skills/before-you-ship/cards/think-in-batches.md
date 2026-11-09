# Think in batches

Where it sits in the chart: A query > No NOLOCK > It changes data > "Are you doing this row by row?" (Loops, cursors, calling a stored procedure per row)

SQL Server is built to touch millions of rows in one statement. A loop that runs a query per row pays execution and locking overhead every iteration. Outside an explicit transaction, it pays a commit and a log flush (a write to the transaction log on disk) for every row, too. It also hides the real work from the optimizer, so it never gets to plan the job as a whole.

That doesn't mean every big change has to be one statement, either. The middle ground is a loop over batches of a few thousand rows, each one its own short transaction, walking the clustered key. That's set-based work inside every batch, without one giant transaction holding everything.

## What it costs

Rewriting a loop as a set-based statement costs developer time and testing, and nothing at runtime. A batch loop adds a little code around it: a key to walk, and a way to stop it between batches.

## What it risks

One giant statement means one giant transaction: log growth, lock escalation (many row or page locks becoming one table or partition lock), blocking. In the test, the single `UPDATE` grew the log to 328 MB and escalated to a table lock that held up another session's one-row update for as long as 1.1 seconds.

Optimized locking, always on in **Azure SQL Database** and off by default in **SQL Server 2025** (not in **Express**), mostly takes escalation off that list. The log growth and the long transaction stay.

Set-based doesn't have to mean all-at-once. And if the rows you're clearing fill whole partitions of a table that's already partitioned by date, [Move partitions, not rows](move-partitions-not-rows.md) beats any batch size.

## How fast it works

Orders of magnitude are common. The engine runs one execution for the whole job instead of a hundred thousand tiny ones. In a test updating 963,359 rows, one row at a time took seven and a half minutes, batches of 1,000 took 4.6 to 5.1 seconds, and one statement took 1.8.

## When it backfires

Batching on a column with no index. Each batch has to scan to find its next chunk, so the job slows down as it goes. Batch along the clustered key (the columns the table itself is sorted on) or another indexed column. A loop over batches is fine, but a loop over rows is the problem.

Batches that are too big drift back toward the giant statement: at 10,000 rows per batch, 67 to 72 of the 97 batches escalated to a table lock. On a heap (a table with no clustered index), batches small enough to avoid lock escalation leave every emptied page allocated: [Heaps are for staging](heaps-are-for-staging.md).

## Deeper dive

A table to practice on:

```sql
/*Two million orders, clustered on id, with created rising alongside it*/
CREATE TABLE
    dbo.Orders
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    customer_id integer NOT NULL,
    status tinyint NOT NULL,
    created datetime NOT NULL,
    notes char(100) NOT NULL
);

INSERT
    dbo.Orders
WITH
    (TABLOCK)
(
    id,
    customer_id,
    status,
    created,
    notes
)
SELECT
    x.id,
    customer_id = CONVERT(integer, x.id * 7919 % 100000 + 1),
    status = 1,
    created = DATEADD(MINUTE, CONVERT(integer, x.id), CONVERT(datetime, '20220101', 112)),
    notes = 'x'
FROM
(
    SELECT TOP (2000000)
        id = CONVERT(bigint, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;
```

The batch loop is Michael J. Swart's pattern, the same one the course uses. It walks the clustered key, finds where the next batch ends with [TOP](https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql), and updates up to that key, so each batch is its own short transaction:

```sql
/*Walk the clustered key, 1,000 rows per batch, each batch its own transaction*/
SET NOCOUNT ON;

DECLARE
    @LargestKeyProcessed integer = 0,
    @NextBatchMax integer,
    @RC integer = 1;

WHILE @RC > 0
BEGIN
    SELECT
        @NextBatchMax = MAX(x.id)
    FROM
    (
        SELECT TOP (1000)
            o.id
        FROM dbo.Orders AS o
        WHERE o.id > @LargestKeyProcessed
        AND   o.created < '20231101'
        ORDER BY
            o.id
    ) AS x;

    UPDATE
        o
    SET
        o.status = 2
    FROM dbo.Orders AS o
    WHERE o.id > @LargestKeyProcessed
    AND   o.id <= @NextBatchMax
    AND   o.created < '20231101';

    SET @RC = @@ROWCOUNT;
    SET @LargestKeyProcessed = @NextBatchMax;
END;
```

On **SQL Server 2025**, the job updated the 963,359 rows older than the cutoff while a second session updated one unrelated row every 50 ms. One row at a time took 451 seconds, about 2,100 rows a second. One `UPDATE` took 1.8 seconds, grew the log from 8 MB to 328 MB, and escalated to a table lock, so the other session's one-row update waited as long as 1.1 seconds.

Batches of 1,000 took 4.6 to 5.1 seconds and batches of 4,000 took 4.6 to 4.7, with the log topping out at 136 MB and no escalations. At 10,000 rows per batch, 67 to 72 of the 97 batches escalated, and at 50,000 all 20 did. That's still only one batch's worth of table lock at a time, but it's the giant statement's problem coming back.

Batches cost some speed against one statement and are far faster than one row at a time, and a few thousand rows is a good place to start. SQL Server considers escalating once a single statement holds about 5,000 locks on one index, and in this test batches of 5,000 and 6,000 didn't escalate either, with no other session around. Measure with your own table, because wider rows and more indexes change the math.

The log only stays small if it can be reused between batches: in simple recovery that happens at checkpoints, and in full recovery it takes log backups, so a long batch job needs them running.

Each batch commits on its own, so a failure halfway through leaves half the rows changed. [Batching Modification Queries Is Great Until...](https://erikdarling.com/batching-modification-queries-is-great-until/) covers saving the old values so you can put them back, and retrying batches that hit deadlocks.

## Reading

- [All About SQL Server Stored Procedures: Batching Modifications](https://erikdarling.com/all-about-sql-server-stored-procedures-batching-modifications/)
- [Why Large Modifications Are Never Fast In SQL Server](https://erikdarling.com/why-large-modifications-are-never-fast/)
- [Batching Modification Queries Is Great Until...](https://erikdarling.com/batching-modification-queries-is-great-until/)
