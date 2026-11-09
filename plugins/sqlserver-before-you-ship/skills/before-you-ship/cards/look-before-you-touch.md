# Look before you touch

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "What plan does it have today?" (Will your change blow it up?)

Before editing a query that runs fine, know what execution plan it has and why. The plan is SQL Server's step-by-step recipe for running the query: which indexes it reads, in what order, and how it combines them.

Get the actual plan, not the estimated one. Estimated plans, including everything in the plan cache and Query Store, lack actual rows, operator times, wait stats, and spills (sorts or hashes that outgrow their memory grant and write to tempdb). They only show the parameter values the plan was compiled with. Actual plans show the runtime values too, so check both.

## What it costs

Capturing actual plans has overhead. Include Actual Execution Plan (Ctrl+M in SSMS, SQL Server Management Studio) for one-offs. In production, use Extended Events, SQL Server's built-in tracing, targeted at specific code, not a database-wide plan collection setting left on forever.

## What it risks

Trusting costs. They're unitless estimates with no recalculation after execution, so when the estimates behind them are bad, plans that look cheap are anything but.

## How fast it works

Fast. Operator times in an actual plan point at the slow branch. The plan's wait stats say whether the time went to disk, locks, or waiting on memory. If the query runs too long to wait for, the dive shows how to read its plan while it's still running.

## When it backfires

Capturing an actual plan changes what you're measuring. Collecting per-operator timings and row counts adds overhead that can distort the numbers on short, fast queries. So confirm small differences with plan capture turned off.

## Deeper dive

When a query runs too long to wait for its actual plan, get the plan while it runs. Turn on actual execution plans in the window running the query (Ctrl+M in SSMS, or [SET STATISTICS XML](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-statistics-xml-transact-sql) `ON`), start it, and ask `sp_WhoIsActive` for the plan from a second window. This query against the `Votes` table from [Local variables hide their values](local-variables-hide-their-values.md) takes about 20 seconds, which is plenty of time:

```sql
/*Window 1: actual plans on, then the slow query*/
SET STATISTICS XML ON;

/*The hints keep it slow on purpose*/
SELECT
    c = COUNT_BIG(*)
FROM dbo.Votes AS v1
JOIN dbo.Votes AS v2
  ON DATEDIFF(MINUTE, v1.created, v2.created) BETWEEN 0 AND 5
WHERE v1.id <= 40
OPTION (MAXDOP 1, LOOP JOIN);
```

```sql
/*Window 2: while window 1 is still running*/
EXECUTE dbo.sp_WhoIsActive
    @get_plans = 1;
```

Click the `query_plan` column. That's the plan in flight, with actual rows, CPU, elapsed time, and reads for each operator so far. Eight seconds in, the test plan already showed where the time was going. The Nested Loops join had used 7.9 of those seconds, and 6.3 of them were in a Table Spool replaying all 2 million rows for each of the 11 outer rows read so far, which came to 22 million rows and 5.9 million reads.

Run window 2 again and the numbers grow in the same places. A few minutes of that is usually enough to tell where the gummy parts are.

Leave actual plans off in window 1 and you still get a live plan on **SQL Server 2019** and later, because lightweight profiling is on by default there, but it only has row counts. The same peek showed 21.7 million rows through the spool, with no times or reads. With lightweight profiling turned off too, `sp_WhoIsActive` falls back to the cached plan, which has estimates only. It reads the live plan from [sys.dm_exec_query_statistics_xml](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-exec-query-statistics-xml-transact-sql), so you can query that directly too.

## Reading

- [Understand Your Plan: Estimates And Actuals](https://erikdarling.com/understand-your-plan-estimates-and-actuals/)
- [Understand Your Plan: Costs (And Why You Shouldn't Bother With Them)](https://erikdarling.com/understand-your-plan-costs-and-why-you-shouldnt-bother-with-them/)
- [sp_WhoIsActive](https://github.com/amachanic/sp_whoisactive) (Adam Machanic)
