# Filter so indexes can help you

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "How are you filtering?" (Functions on columns, mismatched types, leading wildcards)

You'll hear that some queries "can't use indexes" because of how they're written, or more precisely, that they can't use them efficiently.

B-tree indexes put data in order, and wrapping a column in most functions or doing math on it prevents a seek into that order. The same goes for comparing it to [a type that forces the column to convert](types-are-a-performance-feature.md), and for a `LIKE` that leads with a wildcard. A few functions still seek, like converting a `datetime` column to `date`, but don't count on it.

The jargon for a predicate (a filter condition) that an index can seek with is SARGable. Hiding the expression inside a [CTE](https://learn.microsoft.com/en-us/sql/t-sql/queries/with-common-table-expression-transact-sql) (common table expression) or derived table doesn't help either. When you're stuck, [an indexed computed column](index-the-expression-with-a-computed-column.md) is the escape hatch.

## What it costs

Nothing to buy. Write the predicate against the bare column. Use `IS NULL` instead of [COALESCE](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/coalesce-transact-sql)`(col, sentinel)` = sentinel, a date range instead of `YEAR(col)`, and parameter types that match the column's type.

## What it risks

Rewrites can change results if you're careless. `COALESCE(col, 0) = 0` matches the `NULL`s and the real zeroes. So the SARGable equivalent is `col = 0 OR col IS NULL`, not `IS NULL` alone.

## How fast it works

Immediate, and biggest when the query only needs a small number of rows. If it has to read most of the table anyway, no seek will save it.

## When it backfires

A rewrite that changes the answer. `COALESCE(t.priority, 0) = 0` was matching the real zeroes as well as the `NULL`s, and a time-zone shift on the column has to move to the search value, not disappear, or the rows near midnight land in the wrong day. Compare row counts from the old predicate and the new one, with the same values, before it ships.

## Deeper dive

A million tasks, with an index on each column the queries filter by:

```sql
CREATE TABLE
    dbo.Tasks
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    created_date datetime NOT NULL,
    closed_date datetime NULL,
    priority integer NULL,
    title varchar(100) NOT NULL
);

INSERT
    dbo.Tasks
WITH
    (TABLOCK)
(
    id,
    created_date,
    closed_date,
    priority,
    title
)
SELECT
    x.n,
    created_date = DATEADD(MINUTE, x.n * 3, CONVERT(datetime, '20200101', 112)),
    closed_date =
        CASE
            WHEN x.n % 100 = 0
            THEN NULL
            ELSE DATEADD(MINUTE, x.n * 3 + 1440, CONVERT(datetime, '20200101', 112))
        END,
    priority =
        CASE
            WHEN x.n % 50 = 0 THEN NULL
            WHEN x.n % 50 = 1 THEN 0
            ELSE x.n % 5 + 1
        END,
    title = CONCAT('task ', x.n)
FROM
(
    SELECT TOP (1000000)
        n = CONVERT(integer, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

CREATE INDEX created_date ON dbo.Tasks (created_date);
CREATE INDEX closed_date ON dbo.Tasks (closed_date);
CREATE INDEX priority ON dbo.Tasks (priority);
CREATE INDEX title ON dbo.Tasks (title);
```

Three pairs. In each, the first query wraps the column and the second leaves it bare, and both return the same rows:

```sql
/*Open tasks*/
SELECT
    open_tasks = COUNT_BIG(*)
FROM dbo.Tasks AS t
WHERE COALESCE(t.closed_date, '19000101') = '19000101';

SELECT
    open_tasks = COUNT_BIG(*)
FROM dbo.Tasks AS t
WHERE t.closed_date IS NULL;

/*Created in 2024*/
SELECT
    tasks_2024 = COUNT_BIG(*)
FROM dbo.Tasks AS t
WHERE YEAR(t.created_date) = 2024;

SELECT
    tasks_2024 = COUNT_BIG(*)
FROM dbo.Tasks AS t
WHERE t.created_date >= CONVERT(datetime, '20240101', 112)
AND   t.created_date <  CONVERT(datetime, '20250101', 112);

/*The ten newest, in local time*/
SELECT TOP (10)
    t.id,
    created_local = DATEADD(HOUR, -5, t.created_date)
FROM dbo.Tasks AS t
ORDER BY
    DATEADD(HOUR, -5, t.created_date) DESC;

SELECT TOP (10)
    t.id,
    created_local = DATEADD(HOUR, -5, t.created_date)
FROM dbo.Tasks AS t
ORDER BY
    t.created_date DESC;
```

On **SQL Server 2025**:

- Open tasks: `COALESCE` scanned the whole `closed_date` index, 2,238 pages. `IS NULL` sought it in 26 reads.
- Tasks from 2024: `YEAR` scanned the `created_date` index, 2,237 pages. The date range sought it in 396 reads.
- The ten newest: sorting by the converted time scanned 2,263 pages and sorted a million rows in parallel to keep ten. Sorting by the bare column read 3 pages, because the index already has the rows in that order.

A CTE doesn't hide the expression from anything:

```sql
WITH
    by_year AS
(
    SELECT
        t.id,
        created_year = YEAR(t.created_date)
    FROM dbo.Tasks AS t
)
SELECT
    tasks_2024 = COUNT_BIG(*)
FROM by_year AS y
WHERE y.created_year = 2024;
```

Same scan, same 2,237 pages. SQL Server expands the CTE into the query before optimizing it, so the filter is still `YEAR(t.created_date) = 2024`.

Two more:

```sql
SELECT
    one_day = COUNT_BIG(*)
FROM dbo.Tasks AS t
WHERE CONVERT(date, t.created_date) = CONVERT(date, '20240315', 112);

SELECT
    t.title
FROM dbo.Tasks AS t
WHERE t.title LIKE '%99999';

SELECT
    t.title
FROM dbo.Tasks AS t
WHERE t.title LIKE 'task 99999%';
```

- Converting `created_date` to `date` still sought, and read 6 pages for 480 rows. It's one of the few conversions SQL Server can turn into a range on the column.
- The leading wildcard scanned the `title` index, 3,092 pages, and the trailing one sought it in 3. They don't return the same rows, but only one of them can seek.

And the risk row's case, where a careless rewrite changes the answer:

```sql
SELECT
    zero_or_null = COUNT_BIG(*)
FROM dbo.Tasks AS t
WHERE COALESCE(t.priority, 0) = 0;

SELECT
    zero_or_null = COUNT_BIG(*)
FROM dbo.Tasks AS t
WHERE t.priority = 0
OR    t.priority IS NULL;

SELECT
    null_only = COUNT_BIG(*)
FROM dbo.Tasks AS t
WHERE t.priority IS NULL;
```

- `COALESCE(t.priority, 0) = 0`: 40,000 rows, from a scan of 1,739 pages.
- The `OR`: the same 40,000, from two seeks and 77 reads.
- `IS NULL` alone: 20,000, half the answer.

## Reading

- [SARGability Week: What Is It, Anyway?](https://erikdarling.com/sargability-week-what-is-it-anyway/)
