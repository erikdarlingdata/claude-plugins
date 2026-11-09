# Merge the near-duplicates

Where it sits in the chart: An index > Existing indexes > "Can these be merged?" (Consolidation without breaking the one query)

Two indexes that share a leading key (first key column) and differ by a trailing column or some included columns can usually become one. The merged index serves both sets of queries. The near-duplicates got there one missing index request (SQL Server's own index suggestion) at a time, each added without looking at what already existed. Don't do the analysis by eyeball: `sp_IndexCleanup` analyzes usage and overlap and generates the scripts.

## What it costs

One build for the merged index, plus regression-testing the queries that used the indexes you drop.

## What it risks

Key order matters here too. An index on (A, B) and one on (B, A) look like duplicates in a sloppy audit and are nothing of the sort, so merge on definitions, not on column lists.

## How fast it works

Immediate on write-heavy tables: one fewer index to maintain on every modification. Deduping exact overlaps is safe even when usage stats are too young to trust for anything else.

## When it backfires

If this backfires, you did something else too.

## Deeper dive

Three indexes that grew one missing index request at a time, two of them leading with `customer_id`:

```sql
CREATE TABLE
    dbo.Orders
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    customer_id integer NOT NULL,
    order_date datetime2(0) NOT NULL,
    amount decimal(19, 2) NOT NULL,
    status varchar(20) NOT NULL
);

INSERT
    dbo.Orders
WITH
    (TABLOCK)
(
    id,
    customer_id,
    order_date,
    amount,
    status
)
SELECT
    x.n,
    customer_id = x.n % 20000,
    order_date = DATEADD(MINUTE, x.n, CONVERT(datetime2(0), '20240101', 112)),
    amount = CONVERT(decimal(19, 2), x.n % 1000),
    status = 'shipped'
FROM
(
    SELECT TOP (1000000)
        n = CONVERT(integer, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

CREATE INDEX
    customer_id_order_date
ON dbo.Orders
    (customer_id, order_date);

CREATE INDEX
    customer_id_amount
ON dbo.Orders
    (customer_id)
INCLUDE
    (amount);

CREATE INDEX
    order_date_customer_id
ON dbo.Orders
    (order_date, customer_id);
```

One query for each of them:

```sql
SELECT
    o.order_date
FROM dbo.Orders AS o
WHERE o.customer_id = 42
AND   o.order_date >= CONVERT(datetime2(0), '20240601', 112);

SELECT
    total = SUM(o.amount)
FROM dbo.Orders AS o
WHERE o.customer_id = 42;

SELECT
    o.customer_id
FROM dbo.Orders AS o
WHERE o.order_date >= CONVERT(datetime2(0), '20240601', 112)
AND   o.order_date <  CONVERT(datetime2(0), '20240602', 112);
```

On **SQL Server 2025**, each sought its own index, in 3, 4, and 8 reads, and this is what the two `customer_id` indexes cost to store and maintain:

```sql
SELECT
    index_name = i.name,
    pages = SUM(ps.used_page_count)
FROM sys.dm_db_partition_stats AS ps
JOIN sys.indexes AS i
  ON  i.object_id = ps.object_id
  AND i.index_id = ps.index_id
WHERE ps.object_id = OBJECT_ID(N'dbo.Orders')
AND   i.index_id > 1
GROUP BY
    i.name;
```

```sql
BEGIN TRANSACTION;

INSERT
    dbo.Orders
(
    id,
    customer_id,
    order_date,
    amount,
    status
)
SELECT
    o.id + 2000000,
    o.customer_id,
    o.order_date,
    o.amount,
    o.status
FROM dbo.Orders AS o
WHERE o.id % 20 = 0;

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

/*The rollback leaves its page splits behind, so rebuild before measuring anything else*/
ALTER INDEX ALL
ON dbo.Orders
REBUILD;
```

- 2,489 pages for `customer_id_order_date` and 2,852 for `customer_id_amount`.
- Inserting 50,000 rows logged 42.0 MB with all three nonclustered indexes in place.

[sp_IndexCleanup](https://github.com/erikdarlingdata/DarlingData/tree/main/sp_IndexCleanup) finds the overlap on its own:

```sql
EXECUTE dbo.sp_IndexCleanup
    @database_name = N'YourDatabase',
    @dedupe_only = 1;
```

- A merge script for `customer_id_order_date`, marked Key Superset: a `CREATE INDEX` with `DROP_EXISTING = ON` that adds `amount` as an included column, with online, `SORT_IN_TEMPDB`, and page compression options.
- A disable script for `customer_id_amount`, marked Key Subset of `customer_id_order_date`. It disables instead of dropping, the way [Disable, then drop](disable-then-drop.md) says to.
- Nothing for `order_date_customer_id` but a compression script, because reversed key order isn't a duplicate.

Its summary put the cleanup at one removable index out of four, and 0.10 GB down to 0.08 GB before compression.

Here's the merge by hand, without the compression, so the numbers below measure only the merge:

```sql
CREATE INDEX
    customer_id_order_date
ON dbo.Orders
    (customer_id, order_date)
INCLUDE
    (amount)
WITH
    (DROP_EXISTING = ON);

DROP INDEX
    customer_id_amount
ON dbo.Orders;
```

Run the same queries and measurements again:

- Both customer queries sought the merged index, in 3 reads each.
- The merged index takes 3,602 pages, against 5,341 for the two it replaced.
- The same insert logged 31.5 MB.

The third index has the same two columns in the other order, and it isn't a duplicate:

```sql
BEGIN TRANSACTION;

DROP INDEX
    order_date_customer_id
ON dbo.Orders;

SELECT
    o.customer_id
FROM dbo.Orders AS o
WHERE o.order_date >= CONVERT(datetime2(0), '20240601', 112)
AND   o.order_date <  CONVERT(datetime2(0), '20240602', 112);

ROLLBACK;
```

Without it, the date query scanned the merged index, 3,598 pages, instead of seeking in 8 reads.

## Reading

- [Software Vendor Mistakes With SQL Server: Not Deduplicating Overlapping Indexes](https://erikdarling.com/software-vendor-mistakes-with-sql-server-not-deduplicating-indexes/)
- [Introducing sp_IndexCleanup!](https://erikdarling.com/introducing-sp_indexcleanup/)
