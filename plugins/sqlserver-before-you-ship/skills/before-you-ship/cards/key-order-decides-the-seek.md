# Key order decides the seek

Where it sits in the chart: An index > A new index > "What order do the key columns go in?" (Why isn't SQL Server using my index?)

Missing index requests are SQL Server's own index suggestions. They order key columns (the columns the index sorts on) by predicate type (equality or inequality), then by the column's ordinal position in the table. Ordinal position has nothing to do with selectivity (how few rows a value matches).

Sometimes that works out in your favor. Other times the not-selective column leads. With two equality predicates, that rarely hurts the query that asked, because both columns land in the seek. With two inequality predicates, only the leading one gets the seek, and the index can read every row to find a handful.

Selectivity is a reasonable place to start, but it isn't a rule: equality predicates can be selective or not, and so can inequality predicates. What you're designing for is the query pattern: what it filters on, what it sorts by, and which values people search for.

## What it costs

Maintenance cost is identical regardless of column order. The benefit depends entirely on getting the order right, so a wrong order is full price for a fraction of the payoff.

## What it risks

With two inequality predicates, only the first one gets the seek. The second becomes a residual predicate: checked row by row against everything the seek returns. Which one goes first depends on which narrows more for the values people pass in.

## How fast it works

Immediate. A reversed key order on a range-heavy query can be the difference between reading a wide date range and seeking to the few qualifying rows.

## When it backfires

Treating "most selective column first" as the rule. It's a fine place to start, and it falls apart quickly. A selective range column can land ahead of an equality column, or ahead of the `ORDER BY` columns. That can cost you the seek or the Sort you were trying to avoid. Run [COUNT_BIG](https://learn.microsoft.com/en-us/sql/t-sql/functions/count-big-transact-sql) per predicate to see where you stand, then design for the whole query pattern, which [the keys-and-includes card](keys-sort-includes-ride-along.md) lays out.

## Deeper dive

A table with the same columns, in the same relative order, as `dbo.Posts` in the Stack Overflow database:

```sql
CREATE TABLE
    dbo.Posts
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    answer_count integer NOT NULL,
    creation_date datetime NOT NULL,
    owner_user_id integer NOT NULL,
    parent_id integer NOT NULL,
    post_type_id integer NOT NULL,
    score integer NOT NULL
);

INSERT
    dbo.Posts
WITH
    (TABLOCK)
(
    id,
    answer_count,
    creation_date,
    owner_user_id,
    parent_id,
    post_type_id,
    score
)
SELECT
    x.n,
    answer_count =
        CASE
            WHEN x.n = 1000 THEN 518
            WHEN x.n % 100 < 40 THEN x.n % 7
            ELSE 0
        END,
    creation_date = DATEADD(MINUTE, x.n, CONVERT(datetime, '20080101', 112)),
    owner_user_id = x.n % 100000,
    parent_id =
        CASE
            WHEN x.n IN (777, 1777) THEN 0
            WHEN x.n % 100 BETWEEN 40 AND 97 THEN x.n - x.n % 100
            ELSE 0
        END,
    post_type_id =
        CASE
            WHEN x.n IN (777, 1777) THEN 8
            WHEN x.n % 100 < 40 THEN 1
            WHEN x.n % 100 < 98 THEN 2
            ELSE 3 + x.n % 5
        END,
    score =
        CASE
            WHEN x.n % 100000 = 0 THEN 30000
            WHEN x.n % 10000 = 0 THEN 12000
            WHEN x.n % 2000 = 0 THEN 6000
            ELSE x.n % 50
        END
FROM
(
    SELECT TOP (3000000)
        n = CONVERT(integer, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;
```

Two queries, each with two equality predicates:

```sql
/*answer_count = 518 is 1 row, post_type_id = 1 is 1.2 million*/
SELECT
    p.answer_count,
    p.post_type_id
FROM dbo.Posts AS p
WHERE p.answer_count = 518
AND   p.post_type_id = 1
ORDER BY
    p.score DESC;

/*parent_id = 0 is 1.26 million rows, post_type_id = 8 is 2*/
SELECT
    p.answer_count,
    p.post_type_id,
    p.parent_id
FROM dbo.Posts AS p
WHERE p.parent_id = 0
AND   p.post_type_id = 8
ORDER BY
    p.score DESC;
```

Their missing index requests, from the plan XML:

- The first asked for `answer_count`, then `post_type_id`. The 1-row predicate happens to lead.
- The second asked for `parent_id`, then `post_type_id`. The 1.26-million-row predicate leads, and the 2-row one comes second.

Same rule both times: equality columns, in the order they sit in the table. Built as asked, the second request still reads 3 pages:

```sql
CREATE INDEX
    parent_id_post_type_id
ON dbo.Posts
    (parent_id, post_type_id)
INCLUDE
    (answer_count, score);
```

The reversed order reads 3 too, because both equality columns end up in the seek either way.

Two inequality predicates are where the order bites:

```sql
SELECT
    p.owner_user_id,
    p.score
FROM dbo.Posts AS p
WHERE p.creation_date >= CONVERT(datetime, '20070101', 112)
AND   p.creation_date <  CONVERT(datetime, '20131231', 112)
AND   p.score >= 25000
ORDER BY
    p.score DESC;
```

The request is `creation_date`, then `score`. Count each predicate on its own before building anything:

```sql
SELECT
    dates = COUNT_BIG(*)
FROM dbo.Posts AS p
WHERE p.creation_date >= CONVERT(datetime, '20070101', 112)
AND   p.creation_date <  CONVERT(datetime, '20131231', 112);

SELECT
    scores = COUNT_BIG(*)
FROM dbo.Posts AS p
WHERE p.score >= 25000;
```

Every one of the 3,000,000 rows is in the date range, and 30 have a score of 25,000 or more. Here's the index the request asked for:

```sql
CREATE INDEX
    creation_date_score
ON dbo.Posts
    (creation_date, score)
INCLUDE
    (owner_user_id);
```

On **SQL Server 2025**, the query scanned the whole index, 9,802 pages, in 74 to 85 ms, then sorted the 30 rows it kept. The date range covers the table, so leading with `creation_date` gives the seek nothing to skip. Now try it with the keys in the other order:

```sql
DROP INDEX
    creation_date_score
ON dbo.Posts;

CREATE INDEX
    score_creation_date
ON dbo.Posts
    (score, creation_date)
INCLUDE
    (owner_user_id);
```

Now the query seeks straight to the high scores: 3 pages, and no Sort, because the index already has `score` in order. `creation_date` becomes a residual predicate, checked on each row the seek returns, which is what happens to the second inequality column in any key order.

Neither order wins everywhere. Two more searches:

```sql
/*One week, high scores*/
SELECT
    p.owner_user_id,
    p.score
FROM dbo.Posts AS p
WHERE p.creation_date >= CONVERT(datetime, '20100101', 112)
AND   p.creation_date <  CONVERT(datetime, '20100108', 112)
AND   p.score >= 25000
ORDER BY
    p.score DESC;

/*One week, any score*/
SELECT
    p.owner_user_id,
    p.score
FROM dbo.Posts AS p
WHERE p.creation_date >= CONVERT(datetime, '20100101', 112)
AND   p.creation_date <  CONVERT(datetime, '20100108', 112)
AND   p.score >= 0
ORDER BY
    p.score DESC;
```

- All dates, score 25,000 and up: 9,802 reads with `creation_date` first, 3 with `score` first.
- One week, score 25,000 and up: 37 reads with `creation_date` first, 3 with `score` first.
- One week, any score: 37 reads with `creation_date` first, 9,732 with `score` first, in 80 to 99 ms.

The week has 10,080 rows, and every score passes `>= 0`, so leading with `score` reads the whole index for that one. Each order loses on the searches the other one handles, which is why the values people actually search with decide the order.

## Reading

- [A Little About Choosing Index Key Column Order](https://erikdarling.com/a-little-about-choosing-index-key-column-order/)
- [Parameter Sniffing, Predicate Selectivity, And Index Key Column Order In SQL Server](https://erikdarling.com/parameter-sniffing-predicate-selectivity-and-index-key-column-order-in-sql-server/)
- [How does SQL Server determine key column order in missing index requests?](https://dba.stackexchange.com/questions/208947/how-does-sql-server-determine-key-column-order-in-missing-index-requests) (DBA Stack Exchange)
