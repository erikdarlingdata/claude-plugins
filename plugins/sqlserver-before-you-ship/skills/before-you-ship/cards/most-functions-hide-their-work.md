# Most functions hide their work

**Requires:** automatic scalar UDF inlining needs **SQL Server 2019** or later at compatibility level 150 or higher, Standard edition included.

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Are you calling a function?" (Scalar UDFs, multi-statement and inline TVFs)

Functions are how developers keep logic in one place, and two of SQL Server's three kinds make every query that calls them pay for it:

- A scalar [UDF](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-function-transact-sql) (`RETURNS` some data type) runs once for every row that needs a result and keeps the whole query from going parallel. It also hides its work from the plan: the Compute Scalar that calls it shows next to no cost.
- A multi-statement table-valued function (`RETURNS @some_table_variable`) fills a table variable with a serial insert, and the read back out of it is serial too, and its row estimate is a fixed guess. Newer versions can sometimes swap in the real count, but there are never any statistics on what's inside.
- The good kind is the inline table-valued function (`RETURNS table`): one `SELECT` the optimizer can see straight through, which makes it a parameterized view.

## What it costs

Rewriting a scalar UDF or a multi-statement function as an inline one means a single `SELECT` with no variables or procedural code. When the logic is too tangled to rewrite, put the rows you care about in a `#temp` table first. Then call the function against that small result, so the main query keeps its parallel plan.

## What it risks

Rewrites change results if you're careless. Swapping a scalar UDF in the select list for a [CROSS APPLY](https://learn.microsoft.com/en-us/sql/t-sql/queries/from-transact-sql) to the inline version turns it into a join. That join can drop rows the original kept. The safe replacement is a scalar subquery against the inline function, as in the evidence file.

## How fast it works

Scalar UDF inlining is the fastest fix when it applies. On **SQL Server 2019** and later, at compatibility level 150 or higher (**Standard edition** included), SQL Server can rewrite the function into the calling query, so you don't have to touch either one. It's a sometimes fix: there are around 30 documented restrictions, including [GETDATE](https://learn.microsoft.com/en-us/sql/t-sql/functions/getdate-transact-sql)(), common table expressions, and string building. Before you count on it, check `is_inlineable` and the plan.

## When it backfires

Inlining or rewriting without supporting indexes. Once the optimizer can see the function's queries, it can build an [Eager Index Spool](an-eager-index-spool-is-an-index-you-didn-t-create.md) (a temporary index) to cope with a missing index. The fixed query then gets slower than the broken one. Check what the function's queries need to seek on first.

## Evidence

Demo code and measurements: [evidence/most-functions-hide-their-work.md](../evidence/most-functions-hide-their-work.md). Open it to quote a number or run the demo.

## Reading

- [Learn T-SQL With Erik: Inline Table Valued Functions](https://erikdarling.com/learn-t-sql-with-erik-inline-table-valued-functions/)
- [Learn T-SQL With Erik: Scalar UDFs](https://erikdarling.com/learn-t-sql-with-erik-scalar-udfs/)
- [Scalar UDF inlining requirements](https://go.erikdarling.com/InliningRestrictions) (Microsoft Learn)
