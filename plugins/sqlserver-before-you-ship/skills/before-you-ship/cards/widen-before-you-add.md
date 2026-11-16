# Widen before you add

Where it sits in the chart: An index > A new index > "Do you already have one that almost works?" (Widen vs add, near-duplicates)

Missing index requests (the index suggestions SQL Server attaches to query plans and also collects in DMVs) are opportunistic and not very thoughtful. You only see one of possibly many, and the impact number is an estimate of an estimate. A missing index request will also happily ask for a near-duplicate of an index you already have. Before adding a net-new index every darn time, check whether you can safely modify an existing one instead.

## What it costs

Widening one index (adding columns to it) adds some size and write overhead to that index. Adding a near-duplicate doubles it: two copies of mostly the same data, maintained on every modification and stored in every backup.

## What it risks

Changing an existing index changes it for every query that uses it. The one query that needed the original definition can regress, so test it before you change it.

## How fast it works

Immediate once built. The build itself takes time, log, and tempdb on big tables.

## When it backfires

The index you widened was unique or filtered, and the new definition dropped the `UNIQUE` or the `WHERE` clause, so a guarantee or a filter someone depended on is gone. Widening the clustered index is its own case: every nonclustered index carries its key, so they all get wider too. And `DROP_EXISTING` without `ONLINE = ON` holds a schema modification lock for the whole rebuild, which blocks reads as well as writes, so use `ONLINE = ON` where the edition allows.

## Evidence

Demo code and measurements: [evidence/widen-before-you-add.md](../evidence/widen-before-you-add.md). Open it to quote a number or run the demo.

## Reading

- [Indexing SQL Server Queries For Performance: Missing Index Requests Are Bad And Dumb](https://erikdarling.com/indexing-sql-server-queries-for-performance-missing-index-requests-are-bad-and-dumb/)
- [Indexing SQL Server Queries For Performance: Fixing A Bad Missing Index Request](https://erikdarling.com/indexing-sql-server-queries-for-performance-fixing-a-bad-missing-index-request/)
