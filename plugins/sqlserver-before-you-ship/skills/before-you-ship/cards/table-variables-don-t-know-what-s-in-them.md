# Table variables don't know what's in them

**Requires:** nothing. Below compatibility level 150 (**SQL Server 2019**), a table variable is also guessed at one row unless the statement recompiles.

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Using a table variable?" (@table instead of #temp, and why people pick it)

People pick table variables because they think they live in memory, or that they win under some magic number of rows. They're in tempdb like `#temp` tables, and no row count makes them safe.

What they're missing is statistics. SQL Server never knows what values a table variable holds, even with an index on it. Below compatibility level 150 (**SQL Server 2019**), it doesn't know how many rows it holds either, so it guesses one unless the statement recompiles. On every version, any modification to one runs single-threaded.

For intermediate results that feed another query, a `#temp` table is the better default.

## What it costs

Almost nothing to switch: `CREATE TABLE #name` instead of `DECLARE @name` table. A `#temp` table brings statistics, and statistics bring recompiles as its contents change, which is the point.

## What it risks

Code that runs constantly. A procedure called thousands of times a minute can lose more to tempdb contention from `#temp` tables than it ever lost to table variable estimates. That's the one case the first post below makes for table variables, so measure that one before you switch.

The other risk is `ROLLBACK`. Rows in a table variable survive one, and rows in a `#temp` table don't. So error logging that collects rows in a table variable inside a transaction stops working after the switch.

## How fast it works

The next compile. In a test at compatibility level 140, a join from 1,000 rows in a table variable to a two-million-row table took 2 to 4 seconds. The plan had a one-row estimate and a spill (its memory grant was too small, so it wrote to tempdb). The same rows in a `#temp` table took 1 to 1.7 seconds.

## When it backfires

`#temp` tables in stored procedures are cached between calls, and so are their statistics. When a call inserts different values, but not enough extra rows to trigger a recompile, it reuses the plan built from an earlier call's statistics. In a test, it kept a nested loops plan (one lookup per row) built for quiet users, and spilled once the busy user showed up. [UPDATE STATISTICS](https://learn.microsoft.com/en-us/sql/t-sql/statements/update-statistics-transact-sql) on the `#temp` table, plus `OPTION` ([RECOMPILE](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query)) on the query that reads it, fixed it.

## Evidence

Demo code and measurements: [evidence/table-variables-don-t-know-what-s-in-them.md](../evidence/table-variables-don-t-know-what-s-in-them.md). Open it to quote a number or run the demo.

## Reading

- [When Should You Use Table Variables In SQL Server? When Queries Execute Thousands Of Times A Minute](https://erikdarling.com/when-should-you-use-table-variables/)
- [Temporary Table Caching Explained](https://www.sql.kiwi/2012/08/temporary-object-caching-explained/) (Paul White)
- [Temporary Table Caching in Stored Procedures](https://www.sql.kiwi/2012/08/temporary-tables-in-stored-procedures/) (Paul White)
