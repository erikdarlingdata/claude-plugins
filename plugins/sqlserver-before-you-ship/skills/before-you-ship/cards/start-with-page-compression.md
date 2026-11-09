# Start with page compression

Where it sits in the chart: An index > A new index > "Should it be compressed?" (ROW, PAGE, and what they cost)

Row compression stores each value in only the bytes it needs. Page compression does that too, then shares common prefixes and repeated values across each page. In the test below, page compression shrank a covering index from 138 MB to 42 MB. Compressed pages stay compressed in memory, so the same buffer pool (the memory SQL Server keeps data pages in) holds about three times as much of that index. That matters most where there's more data than memory, like the buffer pool cap on **Standard Edition**: 256 GB on **SQL Server 2025**, and 128 GB before it.

The price is CPU: reading a compressed page means unpacking it, and changing a row means packing it again. Unless the server is already short on CPU, that's usually a good trade, which is why page compression is a sensible default for new indexes.

## What it costs

CPU. Reading a compressed page means unpacking it, and changing a row means packing it again. In a test, a warm scan with nothing else to do used a half to two-thirds more CPU with page compression, and updating an included column used 10 to 33% more.

Applying it to an existing index takes a rebuild. `DATA_COMPRESSION` is stored with the index, so later rebuilds keep it without being told again.

## What it risks

Only data stored in the row gets compressed. Off-row LOB data (long values like big `nvarchar(max)` strings, kept on pages of their own) doesn't: in a test, page compression left 48,002 LOB pages exactly as they were.

A page-compressed heap only page compresses rows put there by a bulk load, a rebuild, or an insert with `TABLOCK` into a heap with no nonclustered indexes. A plain insert of 500,000 rows got row compression and nothing more, 2,318 pages against 982 (see [Heaps are for staging](heaps-are-for-staging.md)).

Page-compressed pages start out full, so updates that make compressed values longer split them. In a test, updating 10% of the rows split nearly every page of a page-compressed index, doubling it from 42 MB to 86 MB, and logged 113 MB against 78 MB uncompressed. `FILLFACTOR = 80` prevented the splits, but fill factor is only applied at create and rebuild, so once writes use up that space, pages split again.

## How fast it works

In a test, a covering index on two million orders took 138 MB uncompressed, 98 MB with row compression, and 42 MB with page compression, on disk and in the buffer pool. A scan from disk read 5,415 pages instead of 17,645, so the same memory holds about three times as much of the index. Inserting 200,000 rows wrote 56 MB of log instead of 127 MB, with a little less CPU. Only the index was compressed in each copy, not the table under it.

## When it backfires

Turning it on for a table that's mostly `nvarchar(max)` stored off-row, rebuilding it over a weekend, and saving 10 pages.

## Deeper dive

Three copies of the same two million orders, with the same covering index compressed three ways:

```sql
CREATE TABLE
    dbo.OrdersNone
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    customer_id integer NOT NULL,
    order_date datetime2(7) NOT NULL,
    status varchar(20) NOT NULL,
    amount decimal(19, 4) NOT NULL,
    customer_name nvarchar(100) NOT NULL
);

INSERT
    dbo.OrdersNone
WITH
    (TABLOCK)
(
    id,
    customer_id,
    order_date,
    status,
    amount,
    customer_name
)
SELECT
    x.n,
    customer_id = x.n % 20000,
    order_date = DATEADD(SECOND, x.n * 15, CONVERT(datetime2(7), '20230101', 112)),
    status =
        CASE x.n % 4
            WHEN 0 THEN 'shipped'
            WHEN 1 THEN 'open'
            WHEN 2 THEN 'returned'
            ELSE 'cancelled'
        END,
    amount = CONVERT(decimal(19, 4), x.n % 100000) / 100,
    customer_name = CONCAT(N'Customer ', x.n % 20000)
FROM
(
    SELECT TOP (2000000)
        n = CONVERT(integer, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

/*Two copies with the same rows*/
SELECT
    o.*
INTO dbo.OrdersRow
FROM dbo.OrdersNone AS o;

SELECT
    o.*
INTO dbo.OrdersPage
FROM dbo.OrdersNone AS o;

ALTER TABLE dbo.OrdersRow ADD PRIMARY KEY CLUSTERED (id);
ALTER TABLE dbo.OrdersPage ADD PRIMARY KEY CLUSTERED (id);

/*The same covering index on each, compressed three ways*/
CREATE INDEX
    customer_orders
ON dbo.OrdersNone
    (customer_id, order_date)
INCLUDE
    (status, amount, customer_name);

CREATE INDEX
    customer_orders
ON dbo.OrdersRow
    (customer_id, order_date)
INCLUDE
    (status, amount, customer_name)
WITH
    (DATA_COMPRESSION = ROW);

CREATE INDEX
    customer_orders
ON dbo.OrdersPage
    (customer_id, order_date)
INCLUDE
    (status, amount, customer_name)
WITH
    (DATA_COMPRESSION = PAGE);
```

[sp_estimate_data_compression_savings](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-estimate-data-compression-savings-transact-sql) samples an index and predicts the result:

```sql
EXECUTE sys.sp_estimate_data_compression_savings
    @schema_name = N'dbo',
    @object_name = N'OrdersNone',
    @index_id = 2,
    @partition_number = NULL,
    @data_compression = N'ROW';

EXECUTE sys.sp_estimate_data_compression_savings
    @schema_name = N'dbo',
    @object_name = N'OrdersNone',
    @index_id = 2,
    @partition_number = NULL,
    @data_compression = N'PAGE';
```

Then the real sizes:

```sql
SELECT
    table_name = OBJECT_NAME(ps.object_id),
    pages = SUM(ps.used_page_count),
    mb = CONVERT(decimal(9, 1), SUM(ps.used_page_count) * 8 / 1024.)
FROM sys.dm_db_partition_stats AS ps
WHERE ps.index_id = 2
AND   ps.object_id IN
      (
          OBJECT_ID(N'dbo.OrdersNone'),
          OBJECT_ID(N'dbo.OrdersRow'),
          OBJECT_ID(N'dbo.OrdersPage')
      )
GROUP BY
    ps.object_id;
```

- No compression: 137.9 MB.
- Row: 97.7 MB, against an estimate of 99.9 MB.
- Page: 42.3 MB, against an estimate of 47.8 MB.

Compressed pages stay compressed in memory. Clear the buffer pool, on a test server only, since `DBCC DROPCLEANBUFFERS` empties it for every database, and scan each index:

```sql
CHECKPOINT;
DBCC DROPCLEANBUFFERS;

SELECT
    total = SUM(o.amount)
FROM dbo.OrdersNone AS o WITH (INDEX (customer_orders))
OPTION (MAXDOP 1);

SELECT
    total = SUM(o.amount)
FROM dbo.OrdersRow AS o WITH (INDEX (customer_orders))
OPTION (MAXDOP 1);

SELECT
    total = SUM(o.amount)
FROM dbo.OrdersPage AS o WITH (INDEX (customer_orders))
OPTION (MAXDOP 1);

SELECT
    table_name = OBJECT_NAME(p.object_id),
    buffer_pool_pages = COUNT_BIG(*)
FROM sys.dm_os_buffer_descriptors AS bd
JOIN sys.allocation_units AS au
  ON au.allocation_unit_id = bd.allocation_unit_id
JOIN sys.partitions AS p
  ON p.hobt_id = au.container_id
WHERE bd.database_id = DB_ID()
AND   p.index_id = 2
GROUP BY
    p.object_id;
```

The buffer pool held 17,645 pages of the uncompressed index, 12,508 of the row-compressed one, and 5,415 of the page-compressed one, the same as on disk. Scanning each again from memory, on one thread, used about 150 ms of CPU uncompressed, about 195 ms with row compression, and about 250 ms with page compression. That's compression at its worst, a query with nothing to do but unpack pages that are already in memory.

Writes, measured with `STATISTICS TIME`, inserting rows staged in a table of their own:

```sql
/*
The rows to insert, in a table of their own. Inserting into dbo.OrdersNone
from dbo.OrdersNone would add a Halloween protection spool
that the other two tables don't get.
*/
CREATE TABLE
    dbo.NewOrders
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    customer_id integer NOT NULL,
    order_date datetime2(7) NOT NULL,
    status varchar(20) NOT NULL,
    amount decimal(19, 4) NOT NULL,
    customer_name nvarchar(100) NOT NULL
);

INSERT
    dbo.NewOrders
WITH
    (TABLOCK)
(
    id,
    customer_id,
    order_date,
    status,
    amount,
    customer_name
)
SELECT
    o.id + 3000000,
    o.customer_id,
    o.order_date,
    o.status,
    o.amount,
    o.customer_name
FROM dbo.OrdersNone AS o
WHERE o.id <= 200000;

SET STATISTICS TIME ON;

BEGIN TRANSACTION;

INSERT
    dbo.OrdersNone
(
    id,
    customer_id,
    order_date,
    status,
    amount,
    customer_name
)
SELECT
    n.id,
    n.customer_id,
    n.order_date,
    n.status,
    n.amount,
    n.customer_name
FROM dbo.NewOrders AS n;

SET STATISTICS TIME OFF;

SELECT
    log_mb =
        CONVERT
        (
            decimal(9, 1),
            dt.database_transaction_log_bytes_used / 1048576.
        )
FROM sys.dm_tran_database_transactions AS dt
WHERE dt.database_id = DB_ID()
AND   dt.transaction_id = CURRENT_TRANSACTION_ID();

ROLLBACK;

/*The rollback leaves its page splits behind*/
ALTER INDEX ALL
ON dbo.OrdersNone
REBUILD;

/*Repeat for dbo.OrdersRow and dbo.OrdersPage*/
```

```sql
SET STATISTICS TIME ON;

BEGIN TRANSACTION;

UPDATE
    o
SET
    o.amount += 1
FROM dbo.OrdersNone AS o
WHERE o.id <= 200000;

SET STATISTICS TIME OFF;

SELECT
    log_mb =
        CONVERT
        (
            decimal(9, 1),
            dt.database_transaction_log_bytes_used / 1048576.
        )
FROM sys.dm_tran_database_transactions AS dt
WHERE dt.database_id = DB_ID()
AND   dt.transaction_id = CURRENT_TRANSACTION_ID();

ROLLBACK;

ALTER INDEX ALL
ON dbo.OrdersNone
REBUILD;

/*Repeat for dbo.OrdersRow and dbo.OrdersPage*/
```

- Inserting 200,000 rows logged 127.3 MB uncompressed, 95.7 MB with row compression, and 55.9 MB with page compression, and the page-compressed insert used 10 to 18% less CPU.
- Updating `amount`, an included column, on those rows used 10 to 33% more CPU with page compression and 23 to 54% more with row compression, across four rounds of runs. It logged 78.0 MB uncompressed and 70.4 MB with row compression, but 113.4 MB with page compression.

The extra log is page splits. All three indexes were at the default fill factor of 100, so every page started full. The new rows land all over each index, so the inserts split nearly every page in all three, compressed or not: the uncompressed index went from 17,647 pages to 35,342. The update only split pages in the page-compressed index, where adding 1 to `amount` made compressed rows longer, and took it from 5,417 pages to 11,027.

Free space on the pages absorbs both. Rebuilt with `FILLFACTOR = 80`, the page-compressed index took 6,694 pages, 52 MB instead of 42 MB. Neither write split a page, the insert logged 27.1 MB, and the update logged 70.1 MB. Fill factor 90 avoided the splits too, but its insert used more CPU than at 80, and at 95 the insert split pages anyway and logged 57.2 MB.

Fill factor is only applied when an index is created or rebuilt, though. Between rebuilds, pages fill up and split like any others. At fill factor 80, two rounds of 200,000-row inserts fit without a split. Without it, the first write after a rebuild splits the full pages and leaves them half empty, which gives later writes room: a second update of 200,000 different rows logged 70.1 MB on the page-compressed index, the same as at fill factor 80.

Compression also skips two things, starting with off-row LOB data:

```sql
CREATE TABLE
    dbo.Notes
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    note nvarchar(max) NOT NULL
);

INSERT
    dbo.Notes
WITH
    (TABLOCK)
(
    id,
    note
)
SELECT TOP (20000)
    ROW_NUMBER() OVER (ORDER BY 1/0),
    REPLICATE(CONVERT(nvarchar(max), N'the same words again and again '), 300)
FROM sys.all_columns AS ac1
CROSS JOIN sys.all_columns AS ac2;

SELECT
    in_row_pages = SUM(ps.in_row_used_page_count),
    lob_pages = SUM(ps.lob_used_page_count)
FROM sys.dm_db_partition_stats AS ps
WHERE ps.object_id = OBJECT_ID(N'dbo.Notes');

ALTER TABLE
    dbo.Notes
REBUILD
WITH
    (DATA_COMPRESSION = PAGE);

SELECT
    in_row_pages = SUM(ps.in_row_used_page_count),
    lob_pages = SUM(ps.lob_used_page_count)
FROM sys.dm_db_partition_stats AS ps
WHERE ps.object_id = OBJECT_ID(N'dbo.Notes');
```

The rebuild left all 48,002 LOB pages where they were. The other thing it skips is a heap loaded the usual way:

```sql
CREATE TABLE
    dbo.HeapPage
(
    id integer NOT NULL,
    customer_id integer NOT NULL,
    status varchar(20) NOT NULL,
    customer_name nvarchar(100) NOT NULL
)
WITH
    (DATA_COMPRESSION = PAGE);

/*A plain insert*/
INSERT
    dbo.HeapPage
(
    id,
    customer_id,
    status,
    customer_name
)
SELECT
    o.id,
    o.customer_id,
    o.status,
    o.customer_name
FROM dbo.OrdersNone AS o
WHERE o.id <= 500000;

SELECT
    plain_insert_pages = SUM(ps.used_page_count)
FROM sys.dm_db_partition_stats AS ps
WHERE ps.object_id = OBJECT_ID(N'dbo.HeapPage');

/*The same rows with TABLOCK*/
TRUNCATE TABLE dbo.HeapPage;

INSERT
    dbo.HeapPage
WITH
    (TABLOCK)
(
    id,
    customer_id,
    status,
    customer_name
)
SELECT
    o.id,
    o.customer_id,
    o.status,
    o.customer_name
FROM dbo.OrdersNone AS o
WHERE o.id <= 500000;

SELECT
    tablock_insert_pages = SUM(ps.used_page_count)
FROM sys.dm_db_partition_stats AS ps
WHERE ps.object_id = OBJECT_ID(N'dbo.HeapPage');
```

The plain insert took 2,318 pages, the same as a row-compressed heap with the same rows, and the `TABLOCK` insert took 982. With a nonclustered index on the heap, the `TABLOCK` insert took 2,318 pages too, since `TABLOCK` only page compresses a heap that has none.

[sp_IndexCleanup](https://github.com/erikdarlingdata/DarlingData/tree/main/sp_IndexCleanup) scripts page compression for every index it reviews, as in the [Merge the near-duplicates](merge-the-near-duplicates.md) run.

## Reading

- [Compressed Indexes And The Buffer Pool In SQL Server](https://erikdarling.com/compressed-indexes-and-the-buffer-pool/)
- [Software Vendor Mistakes With SQL Server: Not Taking Advantage Of Index Compression](https://erikdarling.com/software-vendor-mistakes-with-sql-server-not-taking-advantage-of-index-compression/)
- [Creating SQL Server Indexes: Stored Options vs. Creation Options](https://erikdarling.com/creating-sql-server-indexes-stored-options-vs-creation-options/)
- [Can Rowstore Compression Beat Columnstore Compression In SQL Server?](https://erikdarling.com/can-rowstore-compression-beat-columnstore-compression/) (Joe Obbish)
- [Data compression](https://learn.microsoft.com/en-us/sql/relational-databases/data-compression/data-compression) (Microsoft)
