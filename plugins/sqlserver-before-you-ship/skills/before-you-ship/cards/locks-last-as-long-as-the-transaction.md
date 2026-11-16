# Locks last as long as the transaction

**Requires:** nothing. Optimized locking changes which locks a transaction holds. It's always on in **Azure SQL Database**, and off by default in **SQL Server 2025** (not in **Express**).

Where it sits in the chart: A query > No NOLOCK > It changes data > "How long are you holding locks?" (Every lock lasts until the transaction ends)

Modifications take exclusive locks, and those locks stay put until the transaction commits or rolls back, not until the statement finishes. A transaction that updates one table and then runs a slow query against another is still blocking everyone who wants the first table. And nothing in SQL Server decides when a wait is long enough. Unless someone set [LOCK_TIMEOUT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-lock-timeout-transact-sql) (a session setting that caps lock waits), the application's timeout is the only thing that ends the wait.

## What it costs

Keeping transactions short takes some design work. Do the slow reads, the calculations, and the calls out to anything else before `BEGIN TRANSACTION`, not inside it.

## What it risks

Without an index to seek with, a modification reads past every row in the table and waits on any of them someone else locked. That includes rows it was never going to change. And after roughly 5,000 locks on one index or partition, SQL Server tries to escalate to a table or partition lock, retrying every 1,250 locks after that, and once escalation lands, everyone else waits.

Optimized locking (one transaction lock in place of row and page locks) is always on in **Azure SQL Database** and off by default in **SQL Server 2025** (not in **Express**). It mostly stops escalation, but every row a modification changes stays locked until it commits. With [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) (Read Committed Snapshot Isolation) on as well, it adds lock after qualification: a modification checks its `WHERE` clause against the last committed version of each row without locking it, and only locks the rows that qualify, so it stops waiting on locked rows it was never going to change.

## How fast it works

Immediate. Locks release at `COMMIT`, so every second you cut from a transaction comes off every wait queued behind it.

## When it backfires

Splitting work into short transactions that each leave the data half-done. Short is good, but short and inconsistent is a bug. Keep work that must succeed or fail together in one transaction, and make that transaction fast.

## Evidence

Demo code and measurements: [evidence/locks-last-as-long-as-the-transaction.md](../evidence/locks-last-as-long-as-the-transaction.md). Open it to quote a number or run the demo.

## Reading

- [Learn T-SQL With Erik: Transactions and Blocking and Confusion](https://erikdarling.com/learn-t-sql-with-erik-transactions-and-blocking-and-confusion/)
- [WhatsUpLocks, a helper view for seeing who holds which locks](https://go.erikdarling.com/WhatsUpLocks) (GitHub)
- [Optimized locking](https://learn.microsoft.com/en-us/sql/relational-databases/performance/optimized-locking) (Microsoft Learn)
