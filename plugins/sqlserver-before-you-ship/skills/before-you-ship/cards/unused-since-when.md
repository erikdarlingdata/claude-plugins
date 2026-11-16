# Unused since when?

Where it sits in the chart: An index > Existing indexes > "It says unused. Is it?" (Why three quiet weeks prove nothing)

[sys.dm_db_index_usage_stats](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-db-index-usage-stats-transact-sql) resets when:

- the instance restarts
- the database goes offline
- the database gets restored or detached
- [AUTO_CLOSE](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-set-options) closes the database

"Unused" is only meaningful with a start date attached. An index with zero reads since last Tuesday's patching window tells you about one week of one month of one workload.

## What it costs

Checking when the counts started costs one query. Skipping it costs whatever the quarter-end report was worth.

## What it risks

Fourteen days is the minimum, because under two weeks the stats aren't representative, and longer is better. Under one, don't make unused-index decisions at all, and deduping exact overlaps is the only call the data supports. The reporting queries that run four times a year are exactly the ones with dedicated indexes, and exactly the ones a short window misses.

## How fast it works

Instant: one query, before you believe any zero.

## When it backfires

Dropping on a three-week zero, then meeting the year-end close process. This is why disable-then-drop exists: it converts this mistake from an incident into a rebuild.

## Evidence

Demo code and measurements: [evidence/unused-since-when.md](../evidence/unused-since-when.md). Open it to quote a number or run the demo.

## Reading

- [sys.dm_db_index_usage_stats](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-db-index-usage-stats-transact-sql)
- [AUTO_CLOSE](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-set-options)
