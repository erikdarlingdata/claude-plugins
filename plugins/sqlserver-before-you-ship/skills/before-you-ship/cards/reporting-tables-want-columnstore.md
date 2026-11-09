# Reporting tables want columnstore

Where it sits in the chart: A table > A new table > "Will it mostly be summed and counted?" (Reporting, history, and fact tables (one row per recorded event), read a few columns at a time)

Rowstore tables keep each row's data together, which suits finding one order and changing it. Reporting reads the other way: a few columns from millions of rows, summed or counted.

A clustered columnstore index stores each column separately, compressed, in groups of about a million rows. Queries read only the columns they use, in batch mode, many rows at a time. In a test, four million sales took 178 MB as rows and 42 MB as columns, and a revenue-by-month query read 914 pages instead of 22,968.

It's a poor fit for tables that get read and changed one row at a time.

## What it costs

Loading in big batches. An insert of 102,400 rows or more gets compressed straight into columnstore. Smaller ones land in an uncompressed delta rowgroup (a holding area for new rows). The tuple mover (a background task) compresses it once it closes at about a million rows. In a test, a 1,000-row insert sat in an `OPEN` delta rowgroup, stored as rows.

## What it risks

Single-row work. Finding one sale by id read 3 pages from the rowstore table and 1,449 from the columnstore copy, because there's no B-tree to seek into. Since **SQL Server 2016**, a nonclustered rowstore index on a clustered columnstore table covers single-row lookups, at the write cost on [the write tax card](the-write-tax.md). Updates are a delete plus an insert, and deleted rows stay in their compressed segments, marked in a bitmap, until index maintenance clears them.

## How fast it works

Immediate for the reports. The revenue query took under 40 ms on the columnstore copy, on one thread, and 230 to 280 ms on the rowstore table in row mode. **SQL Server 2019** and later can also use batch mode on rowstore tables, on **Enterprise edition** and its **Developer edition** (**Enterprise Developer**, from **SQL Server 2025**). That brought the rowstore table to 130 to 155 ms, still about four times as long as the columnstore copy, reading 25 times the pages.

## When it backfires

Trickle loads and steady deletes. A table fed a few rows at a time keeps its newest rows in uncompressed delta rowgroups. Deleted rows still get read and filtered out on every scan.

`ALTER INDEX` ... [REORGANIZE](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-index-transact-sql) compresses closed delta rowgroups and cleans up some deleted rows, and `WITH (COMPRESS_ALL_ROW_GROUPS = ON)` compresses the open one too. `REBUILD` clears them all. Schedule one or the other, or the table slides back toward rowstore speed.

## Deeper dive

Four million sales, once as rows and once as columns:

```sql
/*Four million sales, stored as rows*/
CREATE TABLE
    dbo.SalesRowstore
(
    id bigint NOT NULL
        PRIMARY KEY CLUSTERED,
    sold datetime NOT NULL,
    store_id integer NOT NULL,
    product_id integer NOT NULL,
    quantity integer NOT NULL,
    amount decimal(19, 2) NOT NULL
);

INSERT
    dbo.SalesRowstore
WITH
    (TABLOCK)
(
    id,
    sold,
    store_id,
    product_id,
    quantity,
    amount
)
SELECT
    x.id,
    sold = DATEADD(SECOND, CONVERT(integer, x.id * 30), CONVERT(datetime, '20220101', 112)),
    store_id = CONVERT(integer, x.id % 200 + 1),
    product_id = CONVERT(integer, x.id * 7919 % 5000 + 1),
    quantity = CONVERT(integer, x.id % 5 + 1),
    amount = CONVERT(decimal(19, 2), x.id * 37 % 10000) / 100
FROM
(
    SELECT TOP (4000000)
        id = CONVERT(bigint, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

/*The same rows, stored as columns*/
SELECT
    s.*
INTO dbo.SalesColumnstore
FROM dbo.SalesRowstore AS s;

/*Sort by date first, so each rowgroup holds its own range of dates*/
CREATE CLUSTERED INDEX
    sales_columnstore
ON dbo.SalesColumnstore
    (sold);

CREATE CLUSTERED COLUMNSTORE INDEX
    sales_columnstore
ON dbo.SalesColumnstore
WITH
    (DROP_EXISTING = ON, MAXDOP = 1);
```

On **SQL Server 2025**, the rowstore table used 178 MB and the columnstore copy 42 MB. The query:

```sql
/*Revenue by store and month, for this year so far*/
SELECT
    s.store_id,
    sold_month = DATETRUNC(MONTH, s.sold),
    revenue = SUM(s.amount),
    units = SUM(s.quantity)
FROM dbo.SalesRowstore AS s /*Then dbo.SalesColumnstore*/
WHERE s.sold >= CONVERT(datetime, '20250101', 112)
GROUP BY
    s.store_id,
    DATETRUNC(MONTH, s.sold);
```

Against `dbo.SalesRowstore`, it read 22,968 pages in 230 to 280 ms with batch mode disallowed, and 130 to 155 ms with batch mode on rowstore. **SQL Server 2025** used it on its own. Against `dbo.SalesColumnstore`, it read 914 pages of column segments in under 40 ms, on one thread.

Segment elimination helped too: `STATISTICS IO` reported 1 segment read and 3 skipped. That's because each rowgroup keeps the minimum and maximum of every column, and the clustered index put the rows in date order before the columnstore index compressed them.

Skip that step and the columnstore build runs in parallel, which mixes dates across rowgroups. In five builds without it, the same query read 3 or 4 segments and 3,464 to 5,951 pages, a different count each time.

And the write side:

```sql
/*A small insert, the way an app adds rows*/
INSERT
    dbo.SalesColumnstore
(
    id,
    sold,
    store_id,
    product_id,
    quantity,
    amount
)
SELECT
    id = s.id + 20000000,
    s.sold,
    s.store_id,
    s.product_id,
    s.quantity,
    s.amount
FROM dbo.SalesRowstore AS s
WHERE s.id <= 1000;

/*Where the rows ended up*/
SELECT
    rg.state_desc,
    row_groups = COUNT_BIG(*),
    total_rows = SUM(rg.total_rows),
    deleted_rows = SUM(rg.deleted_rows)
FROM sys.dm_db_column_store_row_group_physical_stats AS rg
WHERE rg.object_id = OBJECT_ID(N'dbo.SalesColumnstore')
GROUP BY
    rg.state_desc;
```

Four `COMPRESSED` rowgroups holding the original 4 million rows, and one `OPEN` rowgroup holding the 1,000 new ones, uncompressed. The tuple mover compresses delta rowgroups once they close, at about a million rows. This one was still open, and still rows, 23 minutes later.

From **SQL Server 2019** on, a background merge task can also compress an `OPEN` rowgroup that sits for a while. The rowgroup has to be big enough to qualify, and 1,000 rows isn't. A `REORGANIZE WITH (COMPRESS_ALL_ROW_GROUPS = ON)` compresses it, but a plain `REORGANIZE` left an `OPEN` rowgroup alone in a test.

## Reading

- [Learn T-SQL With Erik: Columnstore Modifications](https://erikdarling.com/learn-t-sql-with-erik-columnstore-modifications/)
- [Column Store, Delta Store, and More](https://erikdarling.com/column-store-delta-store-and-more/)
