# A Top above a scan means a missing index

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "Is there a Top right above a Scan?" (EXISTS, NOT EXISTS, or TOP reading the same table over and over)

[EXISTS](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/exists-transact-sql), `NOT EXISTS`, `IN`, and [TOP](https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql) all tell SQL Server it can stop once it finds enough rows, and the optimizer plans around that, which is called a row goal. When the table being searched has no index on the column the subquery matches on, the optimizer can put a Top right above a scan. It bets each scan finds a match in the first few rows. When matches are missing, each execution reads the whole table, and when they're rare, close to it.

The estimated plan looks tiny, because its estimates assume the bet pays off. The actual plan shows what each scan read.

Index the column the subquery matches on.

## What it costs

One index, on the column in the subquery's `WHERE` clause that points back at the outer table.

## What it risks

Trusting the estimated plan. In a test, the whole query had an estimated cost of 0.80 and an estimate of 1 row per scan. The actual plan showed 210 executions of the scan and 40 million rows read. The scan's `EstimateRowsWithoutRowGoal` property, 20,000 here, is the optimizer's guess without the bet.

## How fast it works

Immediate. Finding the first ten stores with no sales read 228,700 pages in 2 to 3 seconds. With an index on `store_id`, it read about 700 pages in 1 ms.

## When it backfires

A new index for one query on a table that's written to all day. If an existing index already leads with the column, look at why the plan isn't seeking it, and if one almost works, [widen it](widen-before-you-add.md) instead. Every new index is part of [the write tax](the-write-tax.md).

When the index can't go in, `OPTION` ([USE HINT](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query) ('`DISABLE_OPTIMIZER_ROWGOAL`')) plans the query without the bet: one scan, 160 to 180 ms in the test. But it turns off every row goal in the statement, including any that were helping.

## Evidence

Demo code and measurements: [evidence/a-top-above-a-scan-means-a-missing-index.md](../evidence/a-top-above-a-scan-means-a-missing-index.md). Open it to quote a number or run the demo.

## Reading

- [A Row Goal Request For SQL Server](https://erikdarling.com/a-row-goal-request/)
- [Row Goals: Part 2](https://erikdarling.com/row-goals-part-2/)
