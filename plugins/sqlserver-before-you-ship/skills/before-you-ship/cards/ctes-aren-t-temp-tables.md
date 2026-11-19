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

Materializing a big result that the outer query mostly throws away. The `#temp` table gets every row the query that fills it returns, so filters the outer query would have applied early only happen after the write to tempdb. Put those filters in the query that fills it. A filter moved past a `TOP`, a window function, an aggregate, or an outer join can change which rows come back, so check before moving one of those.

## Evidence

Demo code and measurements: [evidence/ctes-aren-t-temp-tables.md](../evidence/ctes-aren-t-temp-tables.md). Open it to quote a number or run the demo.

## Reading

- [Learn T-SQL With Erik: Common Table Expression Mediocrity](https://erikdarling.com/learn-t-sql-with-erik-common-table-expression-mediocrity/)
