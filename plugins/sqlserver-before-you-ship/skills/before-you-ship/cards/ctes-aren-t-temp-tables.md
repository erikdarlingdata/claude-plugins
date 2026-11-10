# CTEs aren't temp tables

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Reaching for a CTE or a temp table?" (When each one helps)

A [CTE](https://learn.microsoft.com/en-us/sql/t-sql/queries/with-common-table-expression-transact-sql) (common table expression) doesn't store anything, in memory or anywhere else. It's a query macro, and a [TOP](https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql) in it stops SQL Server pushing predicates into it without making it run once. SQL Server folds its query into the rest of the plan, so a complex query or a bad estimate inside it can drag down everything after it. Join to it five times and that query runs five times. A `#temp` table gives the optimizer smaller bites: a stored result, with real statistics, to plan the rest of the work from.

And CTEs don't make queries more readable. Formatting does.

## What it costs

Temp tables cost a write to tempdb (SQL Server's shared scratch database). They buy you materialized results (computed once and stored), real statistics, and the option to index them. Statistics are SQL Server's summary of a column's values. A CTE costs nothing extra and buys nothing extra.

## What it risks

Refactoring a multi-reference CTE into a temp table turns intermediate results into a snapshot. Almost always what you wanted, occasionally a surprise under concurrency.

## How fast it works

Immediate. Materializing an expensive CTE that's referenced several times is one of the highest-payoff rewrites there is. The execution plan (SQL Server's recipe for running the query) then stops running the same branch over and over.

## When it backfires

Materializing a big result that the outer query mostly throws away. The `#temp` table gets every row the query that fills it returns, so filters the outer query would have applied early only happen after the write to tempdb. Put those filters in the query that fills it.

## Deeper dive

Two ways to watch a CTE run once per reference, and both work in any database. First, a CTE that picks a random number, referenced twice:

```sql
WITH
    pick AS
(
    SELECT
        n = ABS(CHECKSUM(NEWID()))
)
SELECT
    first_reference = p1.n,
    second_reference = p2.n
FROM pick AS p1
CROSS JOIN pick AS p2;
```

If SQL Server runs the CTE once and reuses the result, both columns will match. In five runs on **SQL Server 2022**, and again on **2025**, they never did.

Second, the reads. Build a 100,000-row table:

```sql
CREATE TABLE
    dbo.CteDemo
(
    id integer NOT NULL
       PRIMARY KEY CLUSTERED,
    filler char(200) NOT NULL
       DEFAULT 'x'
);

INSERT
    dbo.CteDemo
WITH
    (TABLOCK)
(
    id
)
SELECT TOP (100000)
    id = ROW_NUMBER() OVER (ORDER BY 1/0)
FROM sys.all_columns AS ac1
CROSS JOIN sys.all_columns AS ac2;
```

Count it in a CTE, and join the CTE to itself:

```sql
SET STATISTICS IO ON;

WITH
    totals AS
(
    SELECT
        records = COUNT_BIG(*)
    FROM dbo.CteDemo AS cd
)
SELECT
    t1.records
FROM totals AS t1
JOIN totals AS t2
  ON t2.records = t1.records;
```

`STATISTICS IO` shows `CteDemo` scanned twice: 5,278 logical reads, where counting the table once takes 2,639. Five references will put five scans in the plan.

Load the count into a `#temp` table once, and join that instead:

```sql
CREATE TABLE
    #totals
(
    records bigint NOT NULL
);

INSERT
    #totals
(
    records
)
SELECT
    records = COUNT_BIG(*)
FROM dbo.CteDemo AS cd;

SELECT
    t1.records
FROM #totals AS t1
JOIN #totals AS t2
  ON t2.records = t1.records;
```

`CteDemo` goes back to one scan and 2,639 reads, and each reference to the `#temp` table costs one page. The more expensive the query inside the CTE, the more that trade pays.

The course runs the same comparison on a five-reference query against `StackOverflow2013`, where the plan shows the same branch repeated five times. The post below walks through it on video.

## Reading

- [Learn T-SQL With Erik: Common Table Expression Mediocrity](https://erikdarling.com/learn-t-sql-with-erik-common-table-expression-mediocrity/)
