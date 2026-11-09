# Move partitions, not rows

Where it sits in the chart: A table > A new table > "Will old data get archived or purged in bulk?" (Months of history that age out on a schedule)

If a table will keep months of history and drop the oldest month on a schedule, decide now whether to split it into partitions by date range.

(Partitioning is in every edition since **SQL Server 2016 SP1**.) Partitioned, retiring a month is `ALTER TABLE` ... [SWITCH](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql), which moves a whole partition to another table by changing metadata. Or it's [TRUNCATE](https://learn.microsoft.com/en-us/sql/t-sql/statements/truncate-table-transact-sql) `TABLE ... WITH (PARTITIONS)`, which empties one in place. Loading runs the same way in reverse: fill a staging table, then switch it in.

Not partitioned, it's a giant `DELETE`, batched or not, for the life of the table. That's the job partitioning is for, and converting a big table to partitioned later means rebuilding every index on it.

It's a data management feature, not a performance feature, and partitioning a table to make queries faster usually makes them slower.

## What it costs

Discipline, from the first `CREATE TABLE`. Every index has to be aligned to the partition scheme (partitioned the same way as the table). One non-aligned index blocks `SWITCH` (Msg 7733) and partition `TRUNCATE` (Msg 3756). Queries can pay for alignment, which the posts below get into.

Every unique index, the primary key included, has to carry the partitioning column (Msg 1908), so an ID can't be unique on its own. An enabled foreign key pointing at the table blocks `SWITCH` (Msg 4967). Disabling it lets the switch through, and leaves the key unenforced until it's re-enabled.

And every switch target needs the same columns in the same order, matching indexes, and the same filegroup (the set of data files it's stored in). Switching in also needs a trusted [CHECK constraint](https://learn.microsoft.com/en-us/sql/relational-databases/tables/create-check-constraints) (one SQL Server verified against every existing row) that keeps the staged rows inside the partition's range.

## What it risks

[SPLIT](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-partition-function-transact-sql) and `MERGE` where there's data. Adding or removing a boundary inside rows moves those rows, fully logged in `FULL` recovery. Splitting a 100,000-row month logged 12 to 13 MB, and splitting an empty one under 3 KB. Keep an empty partition at the end, split only empty partitions, and merge only where at least one side is empty.

## How fast it works

Milliseconds, whatever the size. Switching out a 100,000-row month logged about 1 KB, where deleting it logged 12 to 13 MB.

## When it backfires

The schema modification lock (a lock that blocks every other query on the table). `SWITCH` needs one on the whole table, so it waits for any running query or open transaction holding a lock there. Everything else queues behind it, including queries on other partitions. In a test, a reader of a different month waited about 3 seconds behind a plain `SWITCH`, until the blocker finished. Behind one using [WAIT_AT_LOW_PRIORITY](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-index-transact-sql) (**SQL Server 2014+**), it waited 4 ms.

`SPLIT` and `MERGE` need the same lock on every table that uses the partition function (the object that defines the date ranges), even when the partition is empty. They don't accept `WAIT_AT_LOW_PRIORITY`, so give them a short [LOCK_TIMEOUT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-lock-timeout-transact-sql), the way [Some ALTERs are free. Some aren't.](some-alters-are-free-some-aren-t.md) does.

## Deeper dive

A partition function by month, a scheme, and a table on it. The last boundary stays empty on purpose:

```sql
CREATE PARTITION FUNCTION
    pf_sales_monthly (datetime2(0))
AS RANGE RIGHT FOR VALUES
(
    '20240101', '20240201', '20240301',
    '20240401', '20240501', '20240601',
    '20240701' /*Kept empty, so next month's split moves no data*/
);

CREATE PARTITION SCHEME
    ps_sales_monthly
AS PARTITION
    pf_sales_monthly
ALL TO
    ([PRIMARY]);

CREATE TABLE
    dbo.Sales
(
    sale_id bigint IDENTITY(1, 1) NOT NULL,
    sale_date datetime2(0) NOT NULL,
    customer_id integer NOT NULL,
    amount decimal(19, 2) NOT NULL,
    CONSTRAINT Sales_sale_date_sale_id
        PRIMARY KEY CLUSTERED (sale_date, sale_id)
)
ON ps_sales_monthly (sale_date);

/*About 100,000 rows a month, January through June 2024*/
INSERT
    dbo.Sales
WITH
    (TABLOCK)
(
    sale_date,
    customer_id,
    amount
)
SELECT
    sale_date =
        DATEADD
        (
            SECOND,
            ABS(CHECKSUM(NEWID())) % 2419200, /*28 days*/
            DATEADD
            (
                MONTH,
                (x.n - 1) / 100000,
                CONVERT(datetime2(0), '20240101', 112)
            )
        ),
    customer_id = ABS(CHECKSUM(NEWID())) % 10000,
    amount = (ABS(CHECKSUM(NEWID())) % 100000) / 100.
FROM
(
    SELECT TOP (600000)
        n = ROW_NUMBER() OVER (ORDER BY 1/0)
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

SELECT
    p.partition_number,
    p.rows
FROM sys.partitions AS p
WHERE p.object_id = OBJECT_ID(N'dbo.Sales')
AND   p.index_id = 1
ORDER BY
    p.partition_number;
```

That last query is worth keeping around: it's how you see which partitions hold rows before you switch, split, or merge anything.

The measuring stick. Every log figure on this card is `database_transaction_log_bytes_used` inside an open transaction, in a database in `FULL` recovery with a full backup taken (until the first full backup, `FULL` recovery behaves like `SIMPLE`). Here's the `DELETE` this card is trying to save you from:

```sql
/*What a DELETE of January would cost, measured and rolled back*/
BEGIN TRANSACTION;

DELETE
    s
FROM dbo.Sales AS s
WHERE s.sale_date >= '20240101'
AND   s.sale_date <  '20240201';

SELECT
    log_bytes = dtdt.database_transaction_log_bytes_used
FROM sys.dm_tran_database_transactions AS dtdt
WHERE dtdt.database_id = DB_ID()
AND   dtdt.transaction_id = CURRENT_TRANSACTION_ID();

ROLLBACK TRANSACTION;
```

On **SQL Server 2025**, with 100,000 rows a month, that `DELETE` logged 12 to 13 MB.

Retiring the oldest month. `$PARTITION` turns a date into its partition number, so nothing depends on counting boundaries by hand:

```sql
/*Same columns, same order, same clustered index, same filegroup*/
CREATE TABLE
    dbo.SalesArchive
(
    sale_id bigint NOT NULL,
    sale_date datetime2(0) NOT NULL,
    customer_id integer NOT NULL,
    amount decimal(19, 2) NOT NULL,
    CONSTRAINT SalesArchive_sale_date_sale_id
        PRIMARY KEY CLUSTERED (sale_date, sale_id)
);

/*January out*/
ALTER TABLE
    dbo.Sales
SWITCH PARTITION $PARTITION.pf_sales_monthly('20240101')
TO dbo.SalesArchive
WITH
(
    WAIT_AT_LOW_PRIORITY
    (
        MAX_DURATION = 1 MINUTES,
        ABORT_AFTER_WAIT = SELF
    )
);

/*Its boundary goes too: both sides are empty now, so no data moves*/
SET LOCK_TIMEOUT 2000; /*SPLIT and MERGE don't take WAIT_AT_LOW_PRIORITY*/

ALTER PARTITION FUNCTION
    pf_sales_monthly()
MERGE RANGE ('20240101');
GO

SET LOCK_TIMEOUT -1;
GO
```

The switch logged about 1 KB, and the merge about 10 KB. The archive table has no `CHECK` constraint and no [IDENTITY](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-table-transact-sql-identity-property), and switching out needs neither.

Each `SET LOCK_TIMEOUT -1` runs in its own batch, because a lock timeout (error 1222) ends the statement, or the whole batch when `XACT_ABORT` is on. The card [Some ALTERs are free. Some aren't.](some-alters-are-free-some-aren-t.md) has that pattern, and [Index work on a live table](index-work-on-a-live-table.md) covers what `MAX_DURATION` and `ABORT_AFTER_WAIT` do.

[RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) (Read Committed Snapshot Isolation) and optimized locking don't shorten the switch's wait for its schema modification lock, because readers still need a schema stability lock. In a test, a reader of another month waited as long with both on as with neither.

```sql
/*Or, when nobody needs the rows: February, gone (SQL Server 2016+)*/
TRUNCATE TABLE
    dbo.Sales
WITH
    (PARTITIONS ($PARTITION.pf_sales_monthly('20240201')));
```

The `TRUNCATE` logged under 20 KB.

Adding the next month, while the last partition is still empty:

```sql
/*August, added while July is still empty*/
SET LOCK_TIMEOUT 2000;

ALTER PARTITION SCHEME
    ps_sales_monthly
NEXT USED
    [PRIMARY];

ALTER PARTITION FUNCTION
    pf_sales_monthly()
SPLIT RANGE ('20240801');
GO

SET LOCK_TIMEOUT -1;
GO
```

Under 3 KB.

Loading a month goes the other way, through a staging table whose `CHECK` matches the target partition:

```sql
/*July's rows, staged with a CHECK that matches July's partition*/
CREATE TABLE
    dbo.SalesStaging
(
    sale_id bigint NOT NULL,
    sale_date datetime2(0) NOT NULL,
    customer_id integer NOT NULL,
    amount decimal(19, 2) NOT NULL,
    CONSTRAINT SalesStaging_sale_date_sale_id
        PRIMARY KEY CLUSTERED (sale_date, sale_id),
    CONSTRAINT SalesStaging_july /*Trusted, because it was created with the table*/
        CHECK
        (
            sale_date >= '20240701'
        AND sale_date <  '20240801'
        )
);

INSERT
    dbo.SalesStaging
WITH
    (TABLOCK)
(
    sale_id,
    sale_date,
    customer_id,
    amount
)
SELECT
    sale_id = 600000 + x.n,
    sale_date =
        DATEADD
        (
            SECOND,
            ABS(CHECKSUM(NEWID())) % 2419200,
            CONVERT(datetime2(0), '20240701', 112)
        ),
    customer_id = ABS(CHECKSUM(NEWID())) % 10000,
    amount = (ABS(CHECKSUM(NEWID())) % 100000) / 100.
FROM
(
    SELECT TOP (100000)
        n = ROW_NUMBER() OVER (ORDER BY 1/0)
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

ALTER TABLE
    dbo.SalesStaging
SWITCH TO dbo.Sales
PARTITION $PARTITION.pf_sales_monthly('20240701')
WITH
(
    WAIT_AT_LOW_PRIORITY
    (
        MAX_DURATION = 1 MINUTES,
        ABORT_AFTER_WAIT = SELF
    )
);
```

Without the `CHECK` constraint, the switch fails with Msg 4982, because SQL Server needs proof that every staged row belongs in that partition. A constraint added later `WITH NOCHECK` fails too, with Msg 4972, until `ALTER TABLE ... WITH CHECK CHECK CONSTRAINT` validates it. The staging table's `CHECK` has to change before it can stage another month.

And the switch doesn't move the `IDENTITY` seed on `dbo.Sales`. After July went in, the identity still stood at 600,000 while the highest `sale_id` was 700,000. Reseed with `DBCC` [CHECKIDENT](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-checkident-transact-sql), or keep staged rows out of the identity's range.

When there's data in the way, the numbers change. Splitting June at June 15, with 100,000 rows in it, logged 12 to 13 MB, because half the rows had to move. Merging the halves back logged 6 to 7 MB. Merging an empty partition into a full neighbor logged about 9 KB.

## Reading

- [Why Partitioning Is Not A Performance Feature In SQL Server](https://erikdarling.com/why-partitioning-is-not-a-performance-feature-in-sql-server/)
- [Learn T-SQL With Erik: Partitioning != Performance](https://erikdarling.com/learn-t-sql-with-erik-partitioning-performance/)
