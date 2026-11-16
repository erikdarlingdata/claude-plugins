# Reporting tables want columnstore: evidence

The card: [Reporting tables want columnstore](../cards/reporting-tables-want-columnstore.md)

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
