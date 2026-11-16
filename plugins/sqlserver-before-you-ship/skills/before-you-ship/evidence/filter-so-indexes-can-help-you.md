# Filter so indexes can help you: evidence

The card: [Filter so indexes can help you](../cards/filter-so-indexes-can-help-you.md)

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
