# Most functions hide their work: evidence

The card: [Most functions hide their work](../cards/most-functions-hide-their-work.md)

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
