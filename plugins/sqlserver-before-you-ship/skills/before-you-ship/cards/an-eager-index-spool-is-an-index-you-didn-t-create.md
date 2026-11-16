# An Eager Index Spool is an index you didn't create

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "Is there an Eager Index Spool in the plan?" (SQL Server building a temporary index every time the query runs)

When a nested loops join has to look rows up in a table with no useful index to support the join, SQL Server sometimes builds one itself, and that's an Eager Index Spool. It reads the whole table, writes the rows it needs into a temporary index in tempdb, and seeks into that. The temporary index gets built from scratch every time the query runs. In a parallel plan, one thread reads the table while the others wait.

The spool tells you the index it wanted. Its seek predicate (what it searches on) is the key, and its output columns are the includes (extra columns the index carries). Create that index, and the spool usually goes away. The evidence file also has a case where it doesn't, because the spool copied an index that was already there.

## What it costs

One index, mostly designed by the spool: the seek predicate's columns as keys and the output columns as includes. Any column the query sorts on also goes in the key, and the spool doesn't show it, plus the usual [write tax](the-write-tax.md).

## What it risks

Building exactly what the spool shows and stopping there. Here the spool held `user_id` with created and score in its output. An index on (`user_id`) [INCLUDE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) (created, score) removed the spool but left a Sort for every user. That was cheap with four comments per user, but check it against your busiest ones.

Putting created in the key let [TOP](https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql) (1) read one row with no sort, in either direction. SQL Server reads an ascending index backward for `ORDER BY created DESC` ([Keys sort. Includes ride along.](keys-sort-includes-ride-along.md)).

## How fast it works

Immediate. For 5,050 users, the spool version took 5 to 7.5 seconds. Most of it went to [EXECSYNC](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-os-wait-stats-transact-sql) waits while one thread built the spool from two million rows, with 6 million page reads against the worktable, while the same query with the index took 30 to 47 ms.

## When it backfires

An index with the right columns in the wrong order. An index on (created, `user_id`) `INCLUDE (score)` covers every column the query needs. The optimizer still built the spool, this time from a scan of the new index, in 6.5 seconds, so the seek column has to lead.

## Evidence

Demo code and measurements: [evidence/an-eager-index-spool-is-an-index-you-didn-t-create.md](../evidence/an-eager-index-spool-is-an-index-you-didn-t-create.md). Open it to quote a number or run the demo.

## Reading

- [Indexing SQL Server Queries For Performance: Eager Index Spools](https://erikdarling.com/indexing-sql-server-queries-for-performance-eager-index-spools/)
- [Eager Index Spools Are Judgmental Query Plan Operators In SQL Server](https://erikdarling.com/eager-index-spools-are-judgmental/)
- [Index Spools When You Have An Index](https://erikdarling.com/index-spools-when-you-have-an-index/)
