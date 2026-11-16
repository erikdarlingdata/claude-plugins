# Think in batches

**Requires:** nothing. With optimized locking on, lock escalation mostly stops being a reason to batch. It's always on in **Azure SQL Database**, and off by default in **SQL Server 2025** (not in **Express**).

Where it sits in the chart: A query > No NOLOCK > It changes data > "Are you doing this row by row?" (Loops, cursors, calling a stored procedure per row)

SQL Server is built to touch millions of rows in one statement. A loop that runs a query per row pays execution and locking overhead every iteration. Outside an explicit transaction, it pays a commit and a log flush (a write to the transaction log on disk) for every row, too. It also hides the real work from the optimizer, so it never gets to plan the job as a whole.

That doesn't mean every big change has to be one statement, either. The middle ground is a loop over batches of a few thousand rows, each one its own short transaction, walking the clustered key. That's set-based work inside every batch, without one giant transaction holding everything.

## What it costs

Rewriting a loop as a set-based statement costs developer time and testing, and nothing at runtime. A batch loop adds a little code around it: a key to walk, and a way to stop it between batches.

## What it risks

One giant statement means one giant transaction: log growth, lock escalation (many row or page locks becoming one table or partition lock), blocking. In the test, the single `UPDATE` grew the log to 328 MB and escalated to a table lock that held up another session's one-row update for as long as 1.1 seconds.

Optimized locking, always on in **Azure SQL Database** and off by default in **SQL Server 2025** (not in **Express**), mostly takes escalation off that list. The log growth and the long transaction stay.

Set-based doesn't have to mean all-at-once. And if the rows you're clearing fill whole partitions of a table that's already partitioned by date, [Move partitions, not rows](move-partitions-not-rows.md) beats any batch size.

## How fast it works

Orders of magnitude are common. The engine runs one execution for the whole job instead of a hundred thousand tiny ones. In a test updating 963,359 rows, one row at a time took seven and a half minutes, batches of 1,000 took 4.6 to 5.1 seconds, and one statement took 1.8.

## When it backfires

Batching on a column with no index. Each batch has to scan to find its next chunk, so the job slows down as it goes. Batch along the clustered key (the columns the table itself is sorted on) or another indexed column. A loop over batches is fine, but a loop over rows is the problem.

Batches that are too big drift back toward the giant statement: at 10,000 rows per batch, 67 to 72 of the 97 batches escalated to a table lock. On a heap (a table with no clustered index), batches small enough to avoid lock escalation leave every emptied page allocated: [Heaps are for staging](heaps-are-for-staging.md).

## Evidence

Demo code and measurements: [evidence/think-in-batches.md](../evidence/think-in-batches.md). Open it to quote a number or run the demo.

## Reading

- [All About SQL Server Stored Procedures: Batching Modifications](https://erikdarling.com/all-about-sql-server-stored-procedures-batching-modifications/)
- [Why Large Modifications Are Never Fast In SQL Server](https://erikdarling.com/why-large-modifications-are-never-fast/)
- [Batching Modification Queries Is Great Until...](https://erikdarling.com/batching-modification-queries-is-great-until/)
