# Look before you touch

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "What plan does it have today?" (Will your change blow it up?)

Before editing a query that runs fine, know what execution plan it has and why. The plan is SQL Server's step-by-step recipe for running the query: which indexes it reads, in what order, and how it combines them.

Get the actual plan, not the estimated one. Estimated plans, including everything in the plan cache and Query Store, lack actual rows, operator times, wait stats, and spills (sorts or hashes that outgrow their memory grant and write to tempdb). They only show the parameter values the plan was compiled with. Actual plans show the runtime values too, so check both.

## What it costs

Capturing actual plans has overhead. Include Actual Execution Plan (Ctrl+M in SSMS, SQL Server Management Studio) for one-offs. In production, use Extended Events, SQL Server's built-in tracing, targeted at specific code, not a database-wide plan collection setting left on forever.

## What it risks

Trusting costs. They're unitless estimates with no recalculation after execution, so when the estimates behind them are bad, plans that look cheap are anything but.

## How fast it works

Fast. Operator times in an actual plan point at the slow branch. The plan's wait stats say whether the time went to disk, locks, or waiting on memory. If the query runs too long to wait for, the evidence file shows how to read its plan while it's still running.

## When it backfires

Capturing an actual plan changes what you're measuring. Collecting per-operator timings and row counts adds overhead that can distort the numbers on short, fast queries. It adds up per row and per execution, so it's largest for a scalar UDF that isn't inlined and for loops, and a before-and-after comparison taken with plans on overstates what rewriting those gained. So confirm small differences, and any rewrite of a function or a loop, with plan capture turned off.

## Evidence

Demo code and measurements: [evidence/look-before-you-touch.md](../evidence/look-before-you-touch.md). Open it to quote a number or run the demo.

## Reading

- [Understand Your Plan: Estimates And Actuals](https://erikdarling.com/understand-your-plan-estimates-and-actuals/)
- [Understand Your Plan: Costs (And Why You Shouldn't Bother With Them)](https://erikdarling.com/understand-your-plan-costs-and-why-you-shouldnt-bother-with-them/)
- [sp_WhoIsActive](https://github.com/amachanic/sp_whoisactive) (Adam Machanic)
