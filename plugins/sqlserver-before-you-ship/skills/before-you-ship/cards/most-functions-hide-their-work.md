# Most functions hide their work

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Are you calling a function?" (Scalar UDFs, multi-statement and inline TVFs)

Functions are how developers keep logic in one place, and two of SQL Server's three kinds make every query that calls them pay for it:

- A scalar [UDF](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-function-transact-sql) (`RETURNS` some data type) runs once for every row that needs a result and keeps the whole query from going parallel. It also hides its work from the plan: the Compute Scalar that calls it shows next to no cost.
- A multi-statement table-valued function (`RETURNS @some_table_variable`) fills a table variable with a serial insert, and the read back out of it is serial too, and its row estimate is a fixed guess. Newer versions can sometimes swap in the real count, but there are never any statistics on what's inside.
- The good kind is the inline table-valued function (`RETURNS table`): one `SELECT` the optimizer can see straight through, which makes it a parameterized view.

## What it costs

Rewriting a scalar UDF or a multi-statement function as an inline one means a single `SELECT` with no variables or procedural code. When the logic is too tangled to rewrite, put the rows you care about in a `#temp` table first. Then call the function against that small result, so the main query keeps its parallel plan.

## What it risks

Rewrites change results if you're careless. Swapping a scalar UDF in the select list for a [CROSS APPLY](https://learn.microsoft.com/en-us/sql/t-sql/queries/from-transact-sql) to the inline version turns it into a join. That join can drop rows the original kept. The safe replacement is a scalar subquery against the inline function, as in the dive.

## How fast it works

Scalar UDF inlining is the fastest fix when it applies. On **SQL Server 2019** and later, at compatibility level 150 or higher (**Standard edition** included), SQL Server can rewrite the function into the calling query, so you don't have to touch either one. It's a sometimes fix: there are around 30 documented restrictions, including [GETDATE](https://learn.microsoft.com/en-us/sql/t-sql/functions/getdate-transact-sql)(), common table expressions, and string building. Before you count on it, check `is_inlineable` and the plan.

## When it backfires

Inlining or rewriting without supporting indexes. Once the optimizer can see the function's queries, it can build an [Eager Index Spool](an-eager-index-spool-is-an-index-you-didn-t-create.md) (a temporary index) to cope with a missing index. The fixed query then gets slower than the broken one. Check what the function's queries need to seek on first.

## Deeper dive

About that estimate: a multi-statement function is guessed at 100 rows (1 on the legacy cardinality estimator). For read-only queries on **SQL Server 2017** and later, at compatibility level 140 or higher, interleaved execution can run the function first. It then uses the real row count, but that count gets cached with the plan, and the serial insert and read don't change.

Check whether SQL Server will even consider inlining a function:

```sql
SELECT
    function_name = OBJECT_NAME(sm.object_id),
    sm.is_inlineable
FROM sys.sql_modules AS sm
WHERE sm.object_id = OBJECT_ID(N'dbo.TotalScore');
```

A 1 means it's eligible, not that it will be inlined in every query that calls it, so the plan is the final word. In testing, a version of this function that used a [CTE](https://learn.microsoft.com/en-us/sql/t-sql/queries/with-common-table-expression-transact-sql) (common table expression) came back 0, and the same logic without the CTE came back 1.

When inlining doesn't apply, rewrite it as an inline table-valued function, here against `StackOverflow2013`:

```sql
CREATE OR ALTER FUNCTION
    dbo.TotalScore_Inline
(
    @UserId integer
)
RETURNS
    table
WITH
    SCHEMABINDING
AS
RETURN
    SELECT
        TotalScore =
            (
                SELECT
                    ISNULL(SUM(p.Score), 0)
                FROM dbo.Posts AS p
                WHERE p.OwnerUserId = @UserId
            ) +
            (
                SELECT
                    ISNULL(SUM(c.Score), 0)
                FROM dbo.Comments AS c
                WHERE c.UserId = @UserId
            );
```

And call it where the scalar UDF used to be, as a scalar subquery, so the query keeps returning exactly the rows it did before:

```sql
SELECT
    u.Id,
    u.DisplayName,
    TotalScore =
        (
            SELECT
                ts.TotalScore
            FROM dbo.TotalScore_Inline(u.Id) AS ts
        )
FROM dbo.Users AS u
WHERE u.Reputation >= 20000;
```

## Reading

- [Learn T-SQL With Erik: Inline Table Valued Functions](https://erikdarling.com/learn-t-sql-with-erik-inline-table-valued-functions/)
- [Learn T-SQL With Erik: Scalar UDFs](https://erikdarling.com/learn-t-sql-with-erik-scalar-udfs/)
- [Scalar UDF inlining requirements](https://go.erikdarling.com/InliningRestrictions) (Microsoft Learn)
