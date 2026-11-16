# Move partitions, not rows: evidence

The card: [Move partitions, not rows](../cards/move-partitions-not-rows.md)

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

Each `SET LOCK_TIMEOUT -1` runs in its own batch, because a lock timeout (error 1222) ends the statement, or the whole batch when `XACT_ABORT` is on. The card [Some ALTERs are free. Some aren't.](../cards/some-alters-are-free-some-aren-t.md) has that pattern, and [Index work on a live table](../cards/index-work-on-a-live-table.md) covers what `MAX_DURATION` and `ABORT_AFTER_WAIT` do.

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
