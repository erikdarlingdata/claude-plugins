# Know how it runs today

**Requires:** Query Store. It's on by default for databases created on **SQL Server 2022** and later. Check it's on for older ones.

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "How does it run today?" (CPU, duration, timeouts, and errors)

The plan says how a query runs. Its runtime stats say how it's been running: how often, how long it takes on average, how long on its best and worst runs, and whether it ever times out or fails. Query Store keeps those next to the estimated plans, for each plan, hour by hour, and it's on by default for databases created on **SQL Server 2022** and later. The plan cache keeps some of them, with caveats.

A query that averages 300 ms and sometimes takes 30 seconds is a different problem from one that always takes 2 seconds. Know which one you have before you change it, so you can tell whether the change helped.

## What it costs

Query Store takes space in each database, up to [MAX_STORAGE_SIZE_MB](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-set-options), plus some overhead to collect. When it fills up, it switches to read-only and stops collecting, so check `actual_state_desc` in `sys.database_query_store_options` before you trust what isn't in it.

## What it risks

Reading the averages wrong. Query Store averages are per interval, an hour by default, so a query's average across hours has to be weighted by `count_executions`. Averaging the hourly averages lets one slow run in a quiet hour count as much as a thousand fast runs in a busy one. The plan cache has no history at all, because its numbers start when the plan was cached and disappear when it recompiles or gets evicted.

## How fast it works

Fast. One query against Query Store gives you the average, minimum, and maximum CPU and duration for every plan the query has had, split into runs that finished, runs the client aborted, and runs that failed with an error. Those are your before numbers, the ones the change has to beat.

## When it backfires

Comparing your own test runs to the app's numbers. SSMS (SQL Server Management Studio) turns [ARITHABORT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-arithabort-transact-sql) on by default and most client libraries leave it off, so in the test, the same procedure called both ways became two Query Store entries with separate `query_ids`, and two plans in the cache. Look up the app's entry, because yours can have a different plan.

## Evidence

Demo code and measurements: [evidence/know-how-it-runs-today.md](../evidence/know-how-it-runs-today.md). Open it to quote a number or run the demo.

## Reading

- [Filtering To Specific Queries Using sp_QuickieStore](https://erikdarling.com/filtering-to-specific-queries-using-sp_quickiestore/)
- [sp_QuickieStore source](https://github.com/erikdarlingdata/DarlingData/tree/main/sp_QuickieStore) (GitHub)
- [sys.query_store_runtime_stats](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-runtime-stats-transact-sql) (Microsoft Learn)
- [Slow in the Application, Fast in SSMS?](https://www.sommarskog.se/query-plan-mysteries.html) (Erland Sommarskog)
