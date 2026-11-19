# Dev lied to you

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "It worked in dev" (Row counts, parameters, statistics)

A thousand rows and one friendly test parameter tell you nothing. Parameterized code gets one cached plan, built for whatever values it was last compiled with. A plan sized for the small case reused for the big case is a disaster. And it's a disaster you cannot see in dev because dev doesn't have the big case.

The other direction hides until there's load: a plan sized for the big case, reused for the small ones, only looks wasteful one call at a time. Under concurrency, every small call asks for the big plan's memory grant and parallel threads at once, and they queue for both. On editions with memory grant feedback, the grant can shrink after the first runs, but the parallel plan stays.

**SQL Server 2022** and later, at compatibility level 160 or higher, can keep several plans for one statement with [Parameter Sensitive Plan Optimization](https://learn.microsoft.com/en-us/sql/relational-databases/performance/parameter-sensitive-plan-optimization). It only covers equality predicates on columns it finds skewed enough, and each plan is still reused for every value in its range, so test the same way. Its plans show `OPTION (PLAN PER VALUE(...))` at the end of their query text, and `sys.query_store_query_variant` ties each one to its parent query.

## What it costs

Testing properly means testing selective and non-selective parameters (values that match few rows or many) in both execution orders. Both orders matter because plan reuse means whoever compiles first sets the plan for everyone after. Then run the small values concurrently with the big plan cached, because one call at a time won't show you the queue.

## What it risks

The local-variable "fix" for parameter sniffing (planning around the compile-time values) swaps the sniffed estimate for an average guess that's the same for every value. That's usually worse, and wrong the same way every time. [OPTIMIZE FOR UNKNOWN](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query) is the same trick in a costume, and both are red flags.

## How fast it works

An index that makes the plan shape stable across parameter values is the fastest lasting fix when there is one. Often there isn't, because no single plan is good for every value. Then dynamic SQL can give each bucket of values its own plan, with hints that fit the bucket, or a `#temp` table can hold the parameter-sensitive part so the rest of the query plans for the rows that actually came back. `RECOMPILE` works immediately too, but charges a compile on every execution, and a statement that compiles every time never gets memory grant feedback.

## When it backfires

Buckets are a snapshot of your data. When the data shifts, a value can drift into the wrong bucket and nothing warns you, so check the counts behind them now and then. And the biggest outlier can be too big for a `#temp` table. In the test, `VoteTypeId` 2 took about 0.9 seconds through the `#temp` table against about 0.5 seconds with its own plan, which is why the course's hybrid version sends it down the original query instead.

## Evidence

Demo code and measurements: [evidence/dev-lied-to-you.md](../evidence/dev-lied-to-you.md). Open it to quote a number or run the demo.

## Reading

- [What Parameter Sniffing Looks Like In SQL Server's Plan Cache](https://erikdarling.com/what-parameter-sniffing-looks-like-in-the-plan-cache/)
- [Yet Another Post About Local Variables In SQL Server](https://go.erikdarling.com/LocalVariables)
- [Defeating Parameter Sniffing With Dynamic SQL In SQL Server](https://erikdarling.com/defeating-parameter-sniffing-with-dynamic-sql/)
- [All About SQL Server Stored Procedures: Dynamic SQL For Performance](https://erikdarling.com/all-about-sql-server-stored-procedures-dynamic-sql-for-performance/)
