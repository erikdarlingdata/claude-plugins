# Swart's avoid list

**Requires:** the list covers **SQL Server 2019** and later.

Where it sits in the chart: A query > No NOLOCK > It changes data > MERGE > "What's on the target table?" (The avoid list)

If you're still set on [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql), look at the target table first. Michael J. Swart started from Aaron Bertrand's list of `MERGE` problems and boiled it down to what to avoid on **SQL Server 2019** and later. His list: databases in simple recovery, tables with change data capture (CDC) enabled, memory-optimized tables, fulltext and columnstore indexes, partitioned tables, unique filtered indexes, temporal tables, and any `MERGE` that deletes.

The delete case is the scary one. A bug can leave an indexed view (a view whose results SQL Server stores and maintains) inconsistent with its base tables. It was still unfixed as of **SQL Server 2019 CU9** when he wrote it up. And nobody can promise an indexed view won't show up on that table next year.

His bottom line: "Avoid: `MERGE`."

## What it costs

More code, plus the same hints and unique index [the upsert card](upserts-break-under-concurrency.md) needs. Separate `UPDATE` and `INSERT` statements aren't safe under concurrency on their own either.

## What it risks

Losing the one guard `MERGE` gives you for free. A separate `UPDATE` with a join won't error on duplicate source rows, so check the source for duplicates yourself.

## How fast it works

Immediately, once the rewrite ships.

## When it backfires

Rewriting into separate statements with no transaction and no hints. That trades `MERGE`'s bugs for exactly the race conditions in Swart's vanilla-upsert tests: primary key violations under load.

## Evidence

Demo code and measurements: [evidence/swart-s-avoid-list.md](../evidence/swart-s-avoid-list.md). Open it to quote a number or run the demo.

## Reading

- [What To Avoid If You Want To Use MERGE](https://michaeljswart.com/2021/08/what-to-avoid-if-you-want-to-use-merge/) (Michael J. Swart)
- [Be Careful with the Merge Statement](https://michaeljswart.com/2012/08/be-careful-with-the-merge-statement/) (Michael J. Swart)
- [Use Caution with SQL Server's MERGE Statement](https://www.mssqltips.com/sqlservertip/3074/use-caution-with-sql-servers-merge-statement/) (Aaron Bertrand)
- [sqlblog.org/merge](https://sqlblog.org/merge) (Aaron Bertrand)
- [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql)
