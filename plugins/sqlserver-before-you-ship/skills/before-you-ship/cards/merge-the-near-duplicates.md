# Merge the near-duplicates

Where it sits in the chart: An index > Existing indexes > "Can these be merged?" (Consolidation without breaking the one query)

Two indexes that share a leading key (first key column) and differ by a trailing column or some included columns can usually become one. The merged index serves both sets of queries. The near-duplicates got there one missing index request (SQL Server's own index suggestion) at a time, each added without looking at what already existed. Don't do the analysis by eyeball: `sp_IndexCleanup` analyzes usage and overlap and generates the scripts.

## What it costs

One build for the merged index, plus regression-testing the queries that used the indexes you drop.

## What it risks

Key order matters here too. An index on (A, B) and one on (B, A) look like duplicates in a sloppy audit and are nothing of the sort, so merge on definitions, not on column lists.

## How fast it works

Immediate on write-heavy tables: one fewer index to maintain on every modification. Deduping exact overlaps is safe even when usage stats are too young to trust for anything else.

## When it backfires

The dropped index had a name something depended on. A query that hints it by name fails with error 308, and a Query Store plan that was forced with it stops forcing, with `NO_INDEX` in `last_force_failure_reason_desc`. Or the audit folded a `UNIQUE` or filtered index into a plain one, and the guarantee or the filter went with it.

## Evidence

Demo code and measurements: [evidence/merge-the-near-duplicates.md](../evidence/merge-the-near-duplicates.md). Open it to quote a number or run the demo.

## Reading

- [Software Vendor Mistakes With SQL Server: Not Deduplicating Overlapping Indexes](https://erikdarling.com/software-vendor-mistakes-with-sql-server-not-deduplicating-indexes/)
- [Introducing sp_IndexCleanup!](https://erikdarling.com/introducing-sp_indexcleanup/)
