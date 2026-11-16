# Audit before you add

Where it sits in the chart: An index > Existing indexes > "Which ones do queries use?" (Usage stats, reads vs writes)

SQL Server keeps score in [sys.dm_db_index_usage_stats](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-db-index-usage-stats-transact-sql): seeks, scans, lookups on one side, updates on the other. An index untouched since the counters last reset has no row there at all. An audit that inner joins to it skips the deadest indexes, so start from `sys.indexes` and left join. Most tables that collect indexes for years carry several that are all writes and no reads.

Adding every missing index request (SQL Server's own index suggestion) with no regard for what already exists is lazy. Worse, it teaches you nothing about index design.

## What it costs

The audit is a query. The savings are the writes, backup space, and maintenance time the dead indexes were burning.

## What it risks

Zero reads isn't always zero use. Reads on an availability group secondary show up only in that secondary's counts. A unique index enforces its rule without logging a single read (and see [Disable, then drop](disable-then-drop.md) before touching one). [Unused since when?](unused-since-when.md) covers how far back the counts go.

## How fast it works

About an afternoon per table.

## When it backfires

Reading high update counts as "this index is active." Updates are what the index costs you.

## Evidence

Demo code and measurements: [evidence/audit-before-you-add.md](../evidence/audit-before-you-add.md). Open it to quote a number or run the demo.

## Reading

- [Introducing sp_IndexCleanup!](https://erikdarling.com/introducing-sp_indexcleanup/)
- [sp_IndexCleanup documentation](https://erikdarling.com/sp_indexcleanup/)
- [sp_IndexCleanup source](https://github.com/erikdarlingdata/DarlingData/tree/main/sp_IndexCleanup) (GitHub)
