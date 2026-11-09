# Widen before you add

Where it sits in the chart: An index > A new index > "Do you already have one that almost works?" (Widen vs add, near-duplicates)

Missing index requests (the index suggestions SQL Server attaches to query plans and also collects in DMVs) are opportunistic and not very thoughtful. You only see one of possibly many, and the impact number is an estimate of an estimate. A missing index request will also happily ask for a near-duplicate of an index you already have. Before adding a net-new index every darn time, check whether you can safely modify an existing one instead.

## What it costs

Widening one index (adding columns to it) adds some size and write overhead to that index. Adding a near-duplicate doubles it: two copies of mostly the same data, maintained on every modification and stored in every backup.

## What it risks

Changing an existing index changes it for every query that uses it. The one query that needed the original definition can regress, so test it before you change it.

## How fast it works

Immediate once built. The build itself takes time, log, and tempdb on big tables.

## When it backfires

The index you widened was unique or filtered, and the new definition dropped the `UNIQUE` or the `WHERE` clause, so a guarantee or a filter someone depended on is gone. Widening the clustered index is its own case: every nonclustered index carries its key, so they all get wider too. And `DROP_EXISTING` without `ONLINE = ON` holds a schema modification lock for the whole rebuild, which blocks reads as well as writes, so use `ONLINE = ON` where the edition allows.

## Deeper dive

One table, and an index that almost covers a query:

```sql
CREATE TABLE
    dbo.WidenDemo
(
    id integer NOT NULL
       PRIMARY KEY CLUSTERED,
    customer_id integer NOT NULL,
    order_date datetime NOT NULL,
    status_id tinyint NOT NULL,
    amount decimal(10, 2) NOT NULL,
    notes nvarchar(200) NOT NULL
);

INSERT
    dbo.WidenDemo
WITH
    (TABLOCK)
(
    id,
    customer_id,
    order_date,
    status_id,
    amount,
    notes
)
SELECT
    x.id,
    customer_id = x.id % 500, /*2,000 rows per customer*/
    order_date = DATEADD(MINUTE, x.id, CONVERT(datetime, '20200101', 112)),
    status_id = x.id % 10,
    amount = (x.id % 100000) / 10.,
    notes = REPLICATE(N'n', 100)
FROM
(
    SELECT TOP (1000000)
        id = ROW_NUMBER() OVER (ORDER BY 1/0)
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

/*The index you already have*/
CREATE INDEX
    customer_id
ON dbo.WidenDemo
    (customer_id)
INCLUDE
    (order_date);
```

Ask for one more column than the index has, with the actual execution plan on:

```sql
SELECT
    wd.order_date,
    wd.amount
FROM dbo.WidenDemo AS wd
WHERE wd.customer_id = 123;
```

On **SQL Server 2025**, the plan seeks the index and then does 2,000 key lookups to fetch amount: 6,143 reads in `STATISTICS IO`. Its missing index request, at 99.8% impact, asks for a brand-new index on `customer_id` that includes `order_date` and amount.

That's the index you already have, plus one column. Create it as asked and you're maintaining two indexes on `customer_id`. Widen the existing one instead:

```sql
CREATE INDEX
    customer_id
ON dbo.WidenDemo
    (customer_id)
INCLUDE
    (order_date, amount)
WITH
    (DROP_EXISTING = ON, DATA_COMPRESSION = PAGE);
```

Same query: one seek, 12 reads, and the request is gone. [DROP_EXISTING](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) swaps the definition in one operation, so there's no window where queries run without the index.

Offline, though, it holds a schema modification lock for the whole build, so even reads wait. Adding a brand-new index offline only blocks writes.

With `ONLINE = ON`, the old index keeps serving queries until the swap. On a busy table, read [Index work on a live table](index-work-on-a-live-table.md) first.

A plan can also carry more than one request. This query has two branches, and each one wants an index:

```sql
SELECT
    wd.id
FROM dbo.WidenDemo AS wd
WHERE wd.status_id = 3
AND   wd.amount >= 9990

UNION ALL

SELECT
    wd.id
FROM dbo.WidenDemo AS wd
WHERE wd.order_date >= CONVERT(datetime, '20211101', 112);
```

The plan XML holds two requests: one on `order_date` at about 27% impact, listed first, and one on `status_id` and amount at about 64%. The graphical plan shows a single green hint, and it's the first request in the XML. Here it's the 27% one, while the 64% request stays hidden. To see every request, right-click the plan, choose Show Execution Plan XML, and search for `MissingIndexGroup`.

And the impact number is a percentage of the plan's estimated cost, which is itself an estimate. [Look before you touch](look-before-you-touch.md) covers why costs aren't times.

Run the second query before widening `customer_id` and the same two requests show 8% and 88%, though the requests didn't change. Widening `customer_id` gave this query a cheaper plan, since the index now carries amount, and the percentages are of that new, lower cost.

They also move with the statistics sample, so your numbers can differ. The 99.8% on the first query happened to land close to the reads saved, but don't count on that.

Plans aren't the only place requests show up. SQL Server also collects them in four DMVs (dynamic management views):

- `sys.dm_db_missing_index_details`: the table and the requested columns, as `equality_columns`, `inequality_columns`, and `included_columns`
- `sys.dm_db_missing_index_groups`: which group each request belongs to
- `sys.dm_db_missing_index_group_stats`: the counts and estimates for each group
- `sys.dm_db_missing_index_group_stats_query` (**SQL Server 2019** and later): the same counts per query, with a `query_hash` and a handle to the query text

Each column list comes back in the table's column order, not the order the query wrote its predicates. A query filtering on `status_id`, then `customer_id`, then two ranges got equality columns of `[customer_id], [status_id]` and inequality columns of `[order_date], [amount]`. That's the ordering [Key order decides the seek](key-order-decides-the-seek.md) warns about, and [How does SQL Server determine key column order in missing index requests?](https://dba.stackexchange.com/questions/208947/how-does-sql-server-determine-key-column-order-in-missing-index-requests) covers how it gets picked.

The counts most tools show as uses are `user_seeks` and `user_scans`. They go up once per execution of a plan that carries the request. In testing on **SQL Server 2025**:

- Five runs of one cached plan put `user_seeks` at 5 and `unique_compiles` at 1. Five more took `user_seeks` to 10.
- Each run with `OPTION (RECOMPILE)` added one to both.
- An estimated plan added nothing.
- A run that seeked its inner side 50 times still counted one seek.
- The two-branch query above, run three times, gave both of its requests 3 seeks.
- A second query with different text that wanted the same index landed in the same row, and its seeks and compiles were added to the first query's.

So uses counts how often a plan ran, not how much the index would have saved each time. `avg_total_user_cost` is the whole query's estimated cost, not the part the index would fix: both requests from the two-branch query showed the same 26.34. `avg_user_impact` is the same percentage the plan shows, averaged across the queries in the group.

None of it lasts. The DMVs reset when SQL Server restarts, collection stops at 600 groups, and creating an index on the table or running `ALTER INDEX` on one clears its requests. In testing, an index on an unrelated column and a rebuild of an existing one each wiped every request for the table. Query Store keeps the plans, and the requests inside them, across all of that.

## Reading

- [Indexing SQL Server Queries For Performance: Missing Index Requests Are Bad And Dumb](https://erikdarling.com/indexing-sql-server-queries-for-performance-missing-index-requests-are-bad-and-dumb/)
- [Indexing SQL Server Queries For Performance: Fixing A Bad Missing Index Request](https://erikdarling.com/indexing-sql-server-queries-for-performance-fixing-a-bad-missing-index-request/)
