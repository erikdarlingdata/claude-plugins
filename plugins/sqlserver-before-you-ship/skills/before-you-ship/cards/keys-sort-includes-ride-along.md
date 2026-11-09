# Keys sort. Includes ride along.

Where it sits in the chart: An index > A new index > "Key columns or included columns?" (What each one costs)

Key columns are ordered. Included columns are along for the ride. If your query has an `ORDER BY`, those columns belong in the keys, where equality predicates ahead of them preserve the ordering.

Missing index requests (SQL Server's own index suggestions) shove `ORDER BY` columns into the includes. That buys you a covered query (one the index answers on its own) that still sorts every execution.

A Sort needs a memory grant sized from estimates. Parameter-sensitive queries reusing a grant sized for the small case can spill to tempdb (write to disk when the grant runs short).

## What it costs

Key columns are carried up the B-tree (the index's tree of pages) and cost more than includes. Includes live only at the leaf level (the bottom of the tree). If nothing needs a column's order or needs to seek on it, don't promote it to the keys.

## What it risks

An index removes the Sort only for the order it's built in. A query sorting by score `DESC`, `creation_date` needs those columns in that order and direction. SQL Server can also read an index backward, so the fully reversed order works too, but any other order still sorts.

## How fast it works

Immediate. An index that satisfies the `ORDER BY` removes the Sort, and with it that Sort's memory grant and spill risk. Hashes (hash joins and aggregates) still take grants. The plan can still flip between a seek with lookups and a scan depending on the parameter.

## When it backfires

Putting the `ORDER BY` columns ahead of an equality predicate. The order that works is equality, then ordering, then range. Get it backwards and you trade the Sort for a scan.

## Deeper dive

The course runs this shootout on `StackOverflow2013`. This version builds its own table: two million rows, three post types (a rare one at 1% of rows, the others at 35% and 64%), six years of dates, and a random score.

```sql
CREATE TABLE
    dbo.EsrDemo
(
    id integer NOT NULL
       PRIMARY KEY CLUSTERED,
    post_type_id integer NOT NULL,
    creation_date datetime NOT NULL,
    score integer NOT NULL
);

INSERT
    dbo.EsrDemo
WITH
    (TABLOCK)
(
    id,
    post_type_id,
    creation_date,
    score
)
SELECT
    x.id,
    post_type_id =
        CASE
            WHEN x.id % 100 = 0
            THEN 4 /*Rare: 1% of rows*/
            WHEN x.id % 100 <= 35
            THEN 1
            ELSE 2 /*Common: 64% of rows*/
        END,
    creation_date =
        DATEADD(SECOND, x.id * 95, CONVERT(datetime, '20090101', 112)),
    score = ABS(CHECKSUM(NEWID())) % 1000
FROM
(
    SELECT TOP (2000000)
        id = ROW_NUMBER() OVER (ORDER BY 1/0)
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;
```

Three indexes on the same three columns, in three different orders:

```sql
CREATE INDEX
    creation_date_post_type_id_score
ON dbo.EsrDemo
    (creation_date, post_type_id, score DESC);

CREATE INDEX
    post_type_id_creation_date_score
ON dbo.EsrDemo
    (post_type_id, creation_date, score DESC);

CREATE INDEX
    post_type_id_score_creation_date
ON dbo.EsrDemo
    (post_type_id, score DESC, creation_date);
```

One query for the rare type, one for the common type, both asking for the top 5,000 by score. Run each pair once per index by swapping the hint:

```sql
/*The hints force each index for the comparison. Don't ship them.*/

/*Rare type, about two years of dates*/
SELECT TOP (5000)
    ed.id,
    ed.post_type_id,
    ed.creation_date,
    ed.score
FROM dbo.EsrDemo AS ed
    WITH (INDEX = post_type_id_score_creation_date)
WHERE ed.post_type_id = 4
AND   ed.creation_date >= CONVERT(datetime, '20130202', 112)
ORDER BY
    ed.score DESC;

/*Common type, three years of dates*/
SELECT TOP (5000)
    ed.id,
    ed.post_type_id,
    ed.creation_date,
    ed.score
FROM dbo.EsrDemo AS ed
    WITH (INDEX = post_type_id_score_creation_date)
WHERE ed.post_type_id = 2
AND   ed.creation_date >= CONVERT(datetime, '20120101', 112)
ORDER BY
    ed.score DESC;
```

On **SQL Server 2025**, with a warm cache:

**creation_date, post_type_id, score.** Both queries sort. The rare one takes tens of milliseconds. The common one goes parallel, asks for a memory grant of about 73 MB, and takes a few hundred milliseconds.

**post_type_id, creation_date, score.** The rare query is fine at under 10 ms, but it still sorts. The common one is the same parallel sort with the same 73 MB grant.

**post_type_id, score, creation_date.** No Sort and no memory grant for either query. Both finish in a few milliseconds and read about 50 pages. Times come from a two-core test server, so yours will differ.

The third index seeks on the equality predicate, and the rows come back already in score order. So [TOP](https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql) can stop as soon as it has 5,000 rows that pass the date check. The date ends up as a residual predicate, checked only on the rows the seek reads, which is why the order goes equality, then sort, then range.

That matters most in parameterized code, where one cached plan serves every value. Run the same query through [sp_executesql](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-executesql-transact-sql) with parameters, rare type first, once per index:

```sql
DECLARE
    @sql nvarchar(MAX) = N'
SELECT TOP (5000)
    ed.id,
    ed.post_type_id,
    ed.creation_date,
    ed.score
FROM dbo.EsrDemo AS ed
    WITH (INDEX = post_type_id_creation_date_score)
WHERE ed.post_type_id = @post_type_id
AND   ed.creation_date >= @creation_date
ORDER BY
    ed.score DESC;';

/*Rare type first: this compiles the plan*/
EXECUTE sys.sp_executesql
    @sql,
    N'@post_type_id integer, @creation_date datetime',
    @post_type_id = 4,
    @creation_date = '20130202';

/*Common type second: this reuses it*/
EXECUTE sys.sp_executesql
    @sql,
    N'@post_type_id integer, @creation_date datetime',
    @post_type_id = 2,
    @creation_date = '20120101';
```

With either of the first two indexes, the common type reused the rare type's plan and its grant of a megabyte or two. It spilled the Sort to tempdb and took several hundred milliseconds. With the third index, both values got the same plan with no Sort in it, and the common type finished in a few milliseconds.

Parameter Sensitive Plan Optimization didn't step in for any of them. On **Enterprise edition** at compatibility level 150 and up, memory grant feedback adjusts a grant like that on later runs, which can stop the spill, but the plan and its Sort stay.

## Reading

- [A Little About How Indexes Store Data In SQL Server](https://erikdarling.com/a-little-about-how-indexes-store-data-in-sql-server/)
