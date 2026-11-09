# Local variables hide their values

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Filtering on a local variable?" (DECLARE @x = ...; then WHERE column = @x)

SQL Server compiles a batch before it runs any of it. So when a query filters on a local variable, SQL Server builds the plan before the variable has a value. With nothing to look up in the statistics (SQL Server's summary of a column's values), it guesses.

For an equality, the guess is the average number of rows per value in the column. For a range like `>=`, it's 30% of the table. Every value gets that same guess, whether it matches 10 rows or 1.4 million.

Parameters don't have the problem, because SQL Server sees their values when it compiles. If the variable is only a copy of a parameter, use the parameter.

More often it holds something computed: the result of another query, or an expression like [DATEADD](https://learn.microsoft.com/en-us/sql/t-sql/functions/dateadd-transact-sql)(DAY, 1, [GETDATE](https://learn.microsoft.com/en-us/sql/t-sql/functions/getdate-transact-sql)()) that you don't want to repeat. An expression can go straight into the query, where SQL Server can estimate it. For a query result, pass the value to dynamic SQL as a parameter, or add `OPTION` ([RECOMPILE](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query)) to the statement.

## What it costs

Nothing, if the variable is only a copy of a parameter, or an expression you can write into the query instead. When it holds a query result, `OPTION (RECOMPILE)` costs a compile on every execution. Passing it to dynamic SQL or to a second procedure doesn't.

## What it risks

Parameter sniffing, when the variable was there to hide it. SQL Server builds a parameter's plan for the first value and reuses it for the next. Here, Parameter Sensitive Plan Optimization kept separate plans for vote types 11 and 2. With it turned off, type 2 reused type 11's seek-and-lookup plan for 1.4 million rows and read 4.2 million pages. [Dev lied to you](dev-lied-to-you.md) covers testing for it.

## How fast it works

The next compile. With the value visible, through a parameter or `OPTION (RECOMPILE)`, the rare type got a 10-row estimate and an index seek. It got 33 page reads instead of 7,229. The common type got a 1.4 million row estimate and a 127 MB grant, against the 19 MB the local variable got it.

## When it backfires

`WITH RECOMPILE` on the procedure instead of `OPTION (RECOMPILE)` on the statement. A procedure created `WITH RECOMPILE` compiles fresh every time, but it still compiles before the variable gets its value. In a test, the estimate stayed at 200,000 for both types. Only the statement-level hint lets SQL Server use the parameter embedding optimization. [Only search what was asked for](only-search-what-was-asked-for.md) has the same trap with parameters, for a different reason.

## Deeper dive

Two million votes with a lopsided spread of vote types:

```sql
/*Two million votes. Vote type 2 is 70% of them, type 11 is 10 rows, and user 1 cast a quarter of them*/
CREATE TABLE
    dbo.Votes
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    user_id integer NOT NULL,
    vote_type_id integer NOT NULL,
    created datetime NOT NULL
);

INSERT
    dbo.Votes
WITH
    (TABLOCK)
(
    id,
    user_id,
    vote_type_id,
    created
)
SELECT
    x.id,
    user_id =
        CASE
            WHEN x.id % 4 = 0
            THEN 1
            ELSE CONVERT(integer, x.id * 7919 % 400000 + 2)
        END,
    vote_type_id =
        CASE
            WHEN x.id % 200000 = 7
            THEN 11
            WHEN x.id % 10 < 7
            THEN 2
            WHEN x.id % 10 < 9
            THEN 1
            ELSE CONVERT(integer, 3 + x.id % 7)
        END,
    created = DATEADD(MINUTE, x.id, CONVERT(datetime, '20220101', 112))
FROM
(
    SELECT TOP (2000000)
        id = CONVERT(bigint, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

CREATE INDEX
    vote_type_id
ON dbo.Votes
    (vote_type_id);

CREATE INDEX
    user_id
ON dbo.Votes
    (user_id);
```

Ten distinct vote types means the average guess for any one of them is a tenth of the table, 200,000 rows. The local variable version:

```sql
/*A local variable: the plan gets built before the value is known*/
DECLARE
    @vote_type_id integer = 11;

SELECT
    v.id,
    v.user_id,
    v.created
FROM dbo.Votes AS v
WHERE v.vote_type_id = @vote_type_id
ORDER BY
    v.created DESC;

GO
```

On **SQL Server 2025**, that estimated 200,000 rows for vote type 11, which has 10. The plan scanned the clustered index in parallel, read 7,229 pages, and asked for a 19 MB grant to sort 10 rows. Change the value to 2, the 1.4 million row type, and the plan and the estimate don't move. It got the same 19 MB grant, and a sort that spilled.

The same query with a parameter:

```sql
/*The same value as a parameter*/
EXECUTE sys.sp_executesql
    N'
SELECT
    v.id,
    v.user_id,
    v.created
FROM dbo.Votes AS v
WHERE v.vote_type_id = @vote_type_id
ORDER BY
    v.created DESC;',
    N'@vote_type_id integer',
    @vote_type_id = 11;
```

For vote type 11 it estimated 10 rows, seeked the `vote_type_id` index, did 10 lookups, and read 33 pages. For vote type 2 it estimated 1.4 million and got a 127 MB grant. **SQL Server 2022** and later, at compatibility level 160 or higher, can also keep separate plans for rare and common values of a parameter. The feature is Parameter Sensitive Plan Optimization, and it did that here, but a local variable never qualifies for that.

When the value has to be computed in the batch, a statement-level recompile lets the optimizer see it:

```sql
/*Or let the statement see the variable's value*/
DECLARE
    @vote_type_id integer = 11;

SELECT
    v.id,
    v.user_id,
    v.created
FROM dbo.Votes AS v
WHERE v.vote_type_id = @vote_type_id
ORDER BY
    v.created DESC
OPTION (RECOMPILE);

GO
```

Same estimates and plans as the parameter version, at the cost of a compile every time it runs.

Ranges get a flat guess too. `WHERE v.created >= @created` estimated 600,000 rows, 30% of the table, whether 421,761 or 1,955,361 rows came back.

And the version that looks like a fix:

```sql
CREATE OR ALTER PROCEDURE
    dbo.VotesByType
(
    @vote_type_id integer
)
WITH RECOMPILE
AS
BEGIN
    SET NOCOUNT, XACT_ABORT ON;

    DECLARE
        @vote_type_id_inner integer = @vote_type_id;

    SELECT
        v.id,
        v.user_id,
        v.created
    FROM dbo.Votes AS v
    WHERE v.vote_type_id = @vote_type_id_inner
    ORDER BY
        v.created DESC;
END;
```

Both vote types got the 200,000-row estimate and the parallel scan. [Dev lied to you](dev-lied-to-you.md) covers why copying parameters into variables is the wrong answer to parameter sniffing.

## Reading

- [SQL Server IF Branches And Query Performance Part 3: Local Variables Still Suck](https://erikdarling.com/sql-server-if-branches-and-query-performance-part-2-local-variables-still-suck/)
- [Table Variable vs Local Variable Cardinality Estimates in SQL Server](https://erikdarling.com/table-variable-vs-local-variable-cardinality-estimates-in-sql-server/)
- [Why Expressions Are Better Than Local Variables For Performance In SQL Server](https://erikdarling.com/why-expressions-are-better-than-local-variables-for-performance-in-sql-server/)
- [Parameter Sniffing, Embedding, and the RECOMPILE Options](https://www.sql.kiwi/2013/08/parameter-sniffing-embedding-and/) (Paul White)
