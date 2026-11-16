# Only search what was asked for

**Requires:** nothing for the fix. The automatic split into plans for whether a parameter is `NULL` needs **SQL Server 2025** at compatibility level 170.

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Is it a search with optional filters?" (Any combination of parameters, where NULL means "don't filter on this")

Search screens with a pile of optional filters usually turn into one query with a pile of (`column = @parameter OR @parameter IS NULL`) predicates. SQL Server compiles one plan for it, built for whichever parameters show up first. That plan has to return correct results for every combination, so it can't seek on any of them.

**SQL Server 2025**, at compatibility level 170 (a per-database setting for version-specific behavior), can split it into plans for whether a parameter is `NULL`. That's a feature called optional parameter plan optimization. But it picks which parameters to split on at the first compile, and the other filters stay catch-all. Searches on an indexed column scan the index anyway, and everything else drags rows through lookups to apply the filter.

Two fixes work. One is `OPTION` ([RECOMPILE](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query)) on the query, which builds a plan for the values passed, every time. The other is dynamic SQL that only includes the filters someone used, run through [sp_executesql](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-executesql-transact-sql) with parameters.

## What it costs

`RECOMPILE` costs a compile on every execution. That's usually fine, until the search runs constantly, takes a long time to compile, or kicks off long synchronous statistics updates (updates to SQL Server's summary of a column's values), and asynchronous auto-update fixes that last one. Dynamic SQL costs developer time instead: you're building and testing a query that doesn't exist until runtime, so print it while you work.

## What it risks

Doing either one the wrong way. `WITH RECOMPILE` on the procedure compiles a new plan every time, but it doesn't embed the parameter values. So the plan still has to survive every combination, and in a test, it scanned every time.

And dynamic SQL that concatenates values into the string, instead of passing them as parameters, is open to SQL injection, strings especially. It also fills the plan cache with one-off plans.

## How fast it works

Immediately. In a test, a search by one user went from an index scan and about 5,600 reads to a seek and under 100.

## When it backfires

Dynamic SQL gives each combination of filters its own cached plan, and each one can still be parameter sensitive (good for some values, bad for others). In a test, a date search compiled for all of history scanned the table. Reusing that plan for the last week took over 4 seconds, where a fresh plan took about 50 ms.

Add `RECOMPILE` only for the values that need it. The dynamic SQL sniffing post below shows how, and [Dev lied to you](dev-lied-to-you.md) covers the rest.

## Evidence

Demo code and measurements: [evidence/only-search-what-was-asked-for.md](../evidence/only-search-what-was-asked-for.md). Open it to quote a number or run the demo.

## Reading

- [The Only Thing Worse Than Optional Parameters For SQL Server Query Performance](https://erikdarling.com/the-only-thing-worse-than-optional-parameters/)
- [Defeating Parameter Sniffing With Dynamic SQL In SQL Server](https://erikdarling.com/defeating-parameter-sniffing-with-dynamic-sql/)
- [Dynamic Search Conditions in T-SQL](https://www.sommarskog.se/dyn-search.html) (Erland Sommarskog)
