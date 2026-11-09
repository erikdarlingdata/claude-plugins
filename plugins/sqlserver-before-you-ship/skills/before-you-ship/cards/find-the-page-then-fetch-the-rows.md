# Find the page, then fetch the rows

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Showing results a page at a time?" (OFFSET/FETCH, ROW_NUMBER, page 1 of 10,000)

A paging query returns one page of results at a time: rows 1 to 100, then 101 to 200, and so on. Write it in two steps:

- Find the keys for one page, using only the narrow columns you sort and filter on.
- Join back to the table for the wide columns, for just those rows.

The first step is only cheap when an index already holds the rows in that order, so every sort order you offer needs one. Deep pages still read every key before them, and a total count reads every key there is.

## What it costs

An index in the order of each sort you offer, keyed for the filters that go with it, and a query written in two steps instead of one.

When users can sort by any column and filter on any combination, no set of rowstore indexes covers it. That's when to look at a nonclustered columnstore index, a denormalized reporting table, or a search engine like Elasticsearch.

## What it risks

Sort by something that isn't unique, and rows can show up on two pages, or on none, because ties can come back in a different order each time, so end every sort with the primary key. That's one of [Microsoft's two conditions](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-order-by-clause-transact-sql) for stable paging, along with data that doesn't change between requests.

A total count with `COUNT_BIG(*) OVER ()` reads every matching row to return 100 of them, and a sort on an unindexed column reads and sorts the whole table for every page.

## How fast it works

In a test on a million rows, page 5,000 took 1.4 million reads and 1 to 2 seconds selecting every column straight from `OFFSET/FETCH`, because every row up to the end of the page got a key lookup. Finding the keys first took about 1,400 reads and 50 to 70 ms. Seeking from the last row of the previous page read 276 pages in about a millisecond at the same depth.

## When it backfires

Someone exports the whole table through the paging screen, 100 rows at a time. Every page reads all the keys before it, so each one is slower than the last.

## Deeper dive

A million posts with an index on `last_activity_date`. The clustering key, `id`, is part of every row in that index, so the index is already in `last_activity_date, id` order:

```sql
CREATE TABLE
    dbo.Posts
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    owner_user_id integer NOT NULL,
    score integer NOT NULL,
    last_activity_date datetime NOT NULL,
    title nvarchar(250) NOT NULL,
    body nvarchar(max) NOT NULL
);

INSERT
    dbo.Posts
WITH
    (TABLOCK)
(
    id,
    owner_user_id,
    score,
    last_activity_date,
    title,
    body
)
SELECT
    x.n,
    owner_user_id = x.n % 50000,
    score = CONVERT(integer, CONVERT(bigint, x.n) * 7919 % 1000),
    last_activity_date = DATEADD(SECOND, x.n * 37 % 31536000, CONVERT(datetime, '20240101', 112)),
    title = CONCAT(N'Question number ', x.n),
    body = REPLICATE(N'words ', 20 + x.n % 30)
FROM
(
    SELECT TOP (1000000)
        n = CONVERT(integer, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

CREATE INDEX
    last_activity_date
ON dbo.Posts
    (last_activity_date);
```

Page 5,000, two ways:

```sql
/*Every column, straight from OFFSET/FETCH*/
DECLARE
    @page_number integer = 5000,
    @page_size integer = 100;

SELECT
    p.*
FROM dbo.Posts AS p
ORDER BY
    p.last_activity_date,
    p.id
OFFSET ((@page_number - 1) * @page_size) ROWS
FETCH NEXT (@page_size) ROWS ONLY
OPTION (RECOMPILE);
GO

/*The keys first, then the columns*/
DECLARE
    @page_number integer = 5000,
    @page_size integer = 100;

WITH
    paging AS
(
    SELECT
        p.id
    FROM dbo.Posts AS p
    ORDER BY
        p.last_activity_date,
        p.id
    OFFSET ((@page_number - 1) * @page_size) ROWS
    FETCH NEXT (@page_size) ROWS ONLY
)
SELECT
    p.*
FROM paging AS pg
JOIN dbo.Posts AS p
  ON pg.id = p.id
ORDER BY
    p.last_activity_date,
    p.id
OPTION (RECOMPILE);
```

On **SQL Server 2025**, with reads from the actual execution plan, which counts a little lower than `SET STATISTICS IO`:

- Every column straight from `OFFSET/FETCH`: 1,438,605 reads and 1 to 2 seconds. The plan did a key lookup for all 500,000 rows up to the end of the page, not just the 100 it returned.
- The keys first, then the columns: 1,393 reads and 48 to 58 ms, with 100 seeks back to the table.

The same idea with `ROW_NUMBER`, the way the course writes it, with the outer query ordered by the row number:

```sql
DECLARE
    @page_number integer = 5000,
    @page_size integer = 100;

WITH
    fetching AS
(
    SELECT
        p.id,
        n =
            ROW_NUMBER() OVER
            (
                ORDER BY
                    p.last_activity_date,
                    p.id
            )
    FROM dbo.Posts AS p
)
SELECT
    p.*
FROM fetching AS f
JOIN dbo.Posts AS p
  ON f.id = p.id
WHERE f.n > ((@page_number - 1) * @page_size)
AND   f.n < ((@page_number * @page_size) + 1)
ORDER BY
    f.n
OPTION (RECOMPILE);
```

1,428 reads and 56 to 67 ms, about the same as `OFFSET` on this table. Its Window Aggregate ran in batch mode, which is part of how it ran twice as fast as `OFFSET` on the bigger table in the first post below.

Order the outer query by the columns instead, and a Sort comes back:

```sql
DECLARE
    @page_number integer = 5000,
    @page_size integer = 100;

WITH
    fetching AS
(
    SELECT
        p.id,
        n =
            ROW_NUMBER() OVER
            (
                ORDER BY
                    p.last_activity_date,
                    p.id
            )
    FROM dbo.Posts AS p
)
SELECT
    p.*
FROM fetching AS f
JOIN dbo.Posts AS p
  ON f.id = p.id
WHERE f.n > ((@page_number - 1) * @page_size)
AND   f.n < ((@page_number * @page_size) + 1)
ORDER BY
    p.last_activity_date,
    p.id
OPTION (RECOMPILE);
```

The reads and the time stayed the same, but the Sort ran in batch mode and asked for 627 MB of memory to sort 100 rows. It got 320 to 345 MB, the most this server would give one query, where the row mode Sort in the `OFFSET` version sorted the same 100 rows with 1.3 MB. Memory grant feedback cut later runs to about 3 MB, on **Enterprise Edition**, but only after one to three runs had already asked for the full grant.

Add a total count, and page 1 reads every key in the table:

```sql
DECLARE
    @page_number integer = 1,
    @page_size integer = 100;

WITH
    fetching AS
(
    SELECT
        p.id,
        n =
            ROW_NUMBER() OVER
            (
                ORDER BY
                    p.last_activity_date,
                    p.id
            ),
        total_rows = COUNT_BIG(*) OVER ()
    FROM dbo.Posts AS p
)
SELECT
    p.*,
    f.total_rows
FROM fetching AS f
JOIN dbo.Posts AS p
  ON f.id = p.id
WHERE f.n > ((@page_number - 1) * @page_size)
AND   f.n < ((@page_number * @page_size) + 1)
ORDER BY
    f.n
OPTION (RECOMPILE);
```

2,507 reads and 164 to 187 ms, against 285 reads and about 1 ms without the count. `SET STATISTICS IO` also shows 41,838 worktable reads for the count, which the plan leaves out. If the screen needs a total, get it once per search, not once per page.

When users only click next and previous, seek from the last row they saw instead of counting to it (keyset paging):

```sql
/*The last row the previous page showed, here row 499,900*/
DECLARE
    @last_date datetime,
    @last_id integer;

SELECT
    @last_date = x.last_activity_date,
    @last_id = x.id
FROM
(
    SELECT
        p.last_activity_date,
        p.id
    FROM dbo.Posts AS p
    ORDER BY
        p.last_activity_date,
        p.id
    OFFSET 499899 ROWS
    FETCH NEXT 1 ROWS ONLY
) AS x;

SET STATISTICS XML ON;

SELECT TOP (100)
    p.*
FROM dbo.Posts AS p
WHERE p.last_activity_date > @last_date
OR
(
      p.last_activity_date = @last_date
  AND p.id > @last_id
)
ORDER BY
    p.last_activity_date,
    p.id
OPTION (RECOMPILE);

SET STATISTICS XML OFF;
```

276 reads and about a millisecond at row 499,900, the same as page 1, though there's no jumping to page 37.

Sort by a column no index has in order, and every page reads and sorts the whole table:

```sql
DECLARE
    @page_number integer = 1,
    @page_size integer = 100;

WITH
    fetching AS
(
    SELECT
        p.id,
        n =
            ROW_NUMBER() OVER
            (
                ORDER BY
                    p.score DESC,
                    p.id
            )
    FROM dbo.Posts AS p
)
SELECT
    p.*
FROM fetching AS f
JOIN dbo.Posts AS p
  ON f.id = p.id
WHERE f.n > ((@page_number - 1) * @page_size)
AND   f.n < ((@page_number * @page_size) + 1)
ORDER BY
    f.n
OPTION (RECOMPILE);
```

63,103 reads and 230 to 420 ms for page 1, in a parallel plan. Add a nonclustered columnstore index on the columns people sort and filter by:

```sql
CREATE NONCLUSTERED COLUMNSTORE INDEX
    posts_columnstore
ON dbo.Posts
    (id, owner_user_id, score, last_activity_date);
```

The same query took 110 to 310 ms, since it only reads those columns, compressed, but it still sorted all million rows. The plan only showed 252 reads, from the 100 seeks back to the table, since it doesn't count columnstore reads. `SET STATISTICS IO` showed about 800 to 1,350 more for the scan.

## Reading

- [Considerations For Paging Queries In SQL Server With Batch Mode (Don't Use OFFSET/FETCH)](https://erikdarling.com/considerations-for-paging-queries-in-sql-server-with-batch-mode-dont-use-offset-fetch/)
- [Learn T-SQL With Erik: TOP and OFFSET/FETCH](https://erikdarling.com/learn-t-sql-with-erik-top-and-offset-fetch/)
- [A Little About Paging Queries And Batch Mode In SQL Server](https://erikdarling.com/a-little-about-paging-queries-and-batch-mode-in-sql-server/)
- [Optimising Server-Side Paging - Part I](https://www.sqlservercentral.com/articles/optimising-server-side-paging-part-i) (Paul White)
- [Optimising Server-Side Paging - Part II](https://www.sqlservercentral.com/articles/optimising-server-side-paging-part-ii) (Paul White)
