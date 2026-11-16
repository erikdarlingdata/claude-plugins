# Move partitions, not rows

**Requires:** partitioning is in every edition since **SQL Server 2016 SP1**. `WAIT_AT_LOW_PRIORITY` needs **SQL Server 2014** or later.

Where it sits in the chart: A table > A new table > "Will old data get archived or purged in bulk?" (Months of history that age out on a schedule)

If a table will keep months of history and drop the oldest month on a schedule, decide now whether to split it into partitions by date range.

(Partitioning is in every edition since **SQL Server 2016 SP1**.) Partitioned, retiring a month is `ALTER TABLE` ... [SWITCH](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql), which moves a whole partition to another table by changing metadata. Or it's [TRUNCATE](https://learn.microsoft.com/en-us/sql/t-sql/statements/truncate-table-transact-sql) `TABLE ... WITH (PARTITIONS)`, which empties one in place. Loading runs the same way in reverse: fill a staging table, then switch it in.

Not partitioned, it's a giant `DELETE`, batched or not, for the life of the table. That's the job partitioning is for, and converting a big table to partitioned later means rebuilding every index on it.

It's a data management feature, not a performance feature, and partitioning a table to make queries faster usually makes them slower.

## What it costs

Discipline, from the first `CREATE TABLE`. Every index has to be aligned to the partition scheme (partitioned the same way as the table). One non-aligned index blocks `SWITCH` (Msg 7733) and partition `TRUNCATE` (Msg 3756). Queries can pay for alignment, which the posts below get into.

Every unique index, the primary key included, has to carry the partitioning column (Msg 1908), so an ID can't be unique on its own. An enabled foreign key pointing at the table blocks `SWITCH` (Msg 4967). Disabling it lets the switch through, and leaves the key unenforced until it's re-enabled.

And every switch target needs the same columns in the same order, matching indexes, and the same filegroup (the set of data files it's stored in). Switching in also needs a trusted [CHECK constraint](https://learn.microsoft.com/en-us/sql/relational-databases/tables/create-check-constraints) (one SQL Server verified against every existing row) that keeps the staged rows inside the partition's range.

## What it risks

[SPLIT](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-partition-function-transact-sql) and `MERGE` where there's data. Adding or removing a boundary inside rows moves those rows, fully logged in `FULL` recovery. Splitting a 100,000-row month logged 12 to 13 MB, and splitting an empty one under 3 KB. Keep an empty partition at the end, split only empty partitions, and merge only where at least one side is empty.

## How fast it works

Milliseconds, whatever the size. Switching out a 100,000-row month logged about 1 KB, where deleting it logged 12 to 13 MB.

## When it backfires

The schema modification lock (a lock that blocks every other query on the table). `SWITCH` needs one on the whole table, so it waits for any running query or open transaction holding a lock there. Everything else queues behind it, including queries on other partitions. In a test, a reader of a different month waited about 3 seconds behind a plain `SWITCH`, until the blocker finished. Behind one using [WAIT_AT_LOW_PRIORITY](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-index-transact-sql) (**SQL Server 2014+**), it waited 4 ms.

`SPLIT` and `MERGE` need the same lock on every table that uses the partition function (the object that defines the date ranges), even when the partition is empty. They don't accept `WAIT_AT_LOW_PRIORITY`, so give them a short [LOCK_TIMEOUT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-lock-timeout-transact-sql), the way [Some ALTERs are free. Some aren't.](some-alters-are-free-some-aren-t.md) does.

## Evidence

Demo code and measurements: [evidence/move-partitions-not-rows.md](../evidence/move-partitions-not-rows.md). Open it to quote a number or run the demo.

## Reading

- [Why Partitioning Is Not A Performance Feature In SQL Server](https://erikdarling.com/why-partitioning-is-not-a-performance-feature-in-sql-server/)
- [Learn T-SQL With Erik: Partitioning != Performance](https://erikdarling.com/learn-t-sql-with-erik-partitioning-performance/)
