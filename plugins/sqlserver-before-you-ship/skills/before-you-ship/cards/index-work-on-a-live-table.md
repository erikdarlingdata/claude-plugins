# Index work on a live table

**Requires:** `ONLINE = ON` needs **Enterprise** edition or **Azure SQL**. **Standard** edition builds indexes single-threaded.

Where it sits in the chart: A table > An existing table > "Touching indexes on a live table" (Building or dropping while people use it)

The index door covers what to build and what to drop. Doing either on a table people are using adds its own concerns.

## What it costs

Online index operations (**Enterprise edition** and **Azure SQL**) keep the table available while they run, but still need short locks at the start and the end. Starting a new nonclustered index or a rebuild takes a shared table lock (reads get through, writes wait). Finishing a new nonclustered index takes a shared lock. Finishing a rebuild takes a schema modification lock (a lock that blocks every other query on the table).

Those queue the same way [the ALTER card](some-alters-are-free-some-aren-t.md) describes, and [WAIT_AT_LOW_PRIORITY](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-index-transact-sql), covered there, keeps them from holding everyone up. Offline builds block the table for the duration.

## What it risks

Dropping first and asking questions later. [Disable, then drop](disable-then-drop.md) is the safer way out.

## How fast it works

[SORT_IN_TEMPDB](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) and a sensible `MAXDOP` (the most CPUs one operation can use) make builds faster, but **Standard edition** builds indexes single-threaded regardless.

## When it backfires

An online build or rebuild in a deploy script, with no `WAIT_AT_LOW_PRIORITY`, on a table where transactions stay open. The build waits for its table lock, `LCK_M_S` at the start and `LCK_M_SCH_M` at the finish of a rebuild, and every query that arrives after it queues behind it for as long as the oldest open transaction lasts. The evidence file shows a four-second wait on a row nobody had locked, and the option that keeps that queue from forming.

## Evidence

Demo code and measurements: [evidence/index-work-on-a-live-table.md](../evidence/index-work-on-a-live-table.md). Open it to quote a number or run the demo.

## Reading

- [WAIT_AT_LOW_PRIORITY](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-index-transact-sql)
- [SORT_IN_TEMPDB](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql)
- [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide)
