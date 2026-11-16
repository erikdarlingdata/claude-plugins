# Readers shouldn't wait on writers

**Requires:** nothing. RCSI is on by default in **Azure SQL Database**. With Accelerated Database Recovery (**SQL Server 2019** and later), the version store lives in the database instead of tempdb.

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "Is it waiting on writers?" (Readers blocked by modifications, the reason NOLOCK gets added)

Under SQL Server's default, read committed, a query that wants a row another transaction is changing waits until that transaction finishes. That's the blocking that sends people to [NOLOCK](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table), which stops the waiting by reading data that can get rolled back.

Read Committed Snapshot Isolation ([RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide)) stops it properly: readers get the last committed version of the row and keep going, and writers keep writing. It's a database setting, on by default in **Azure SQL Database**, and most other database engines work this way out of the box.

It fixes readers. Writers still block writers.

## What it costs

Row versions. Every `UPDATE` and `DELETE` copies the old row to the version store. The version store lives in tempdb, or inside the database when Accelerated Database Recovery is on (**SQL Server 2019+**).

Every row inserted or modified while RCSI is on also picks up 14 bytes of row versioning information. In a test, updating every row of a full table grew rows from 220 to 234 bytes and doubled its pages through page splits. Writes get a little slower so reads stop waiting.

## What it risks

Code that relied on the waiting. A query that reads a row and then writes based on what it saw used to wait for the writer and see the new value. Under RCSI, it sees the old value right away.

Find those spots and give them the locking read back with a `READCOMMITTEDLOCK` hint, or `UPDLOCK` when the read is part of a write. When it decides whether to insert, add `SERIALIZABLE`, the way [Upserts break under concurrency](upserts-break-under-concurrency.md) does.

## How fast it works

As soon as the setting takes, which is the hard part. `ALTER DATABASE ... SET READ_COMMITTED_SNAPSHOT ON` waits until no other connection is in the database, idle ones included. Run it at a quiet time, or add `WITH ROLLBACK IMMEDIATE`, which rolls back other sessions' open transactions and disconnects them.

## When it backfires

Long-running transactions. Versions stay until the oldest transaction that can still need them finishes, so one open transaction lets the version store grow until it commits. In a test, 148 MB of versions sat in tempdb for the three minutes a transaction stayed open. They were gone within a minute of the commit. [Transactions you didn't know you opened](transactions-you-didn-t-know-you-opened.md) covers how those happen.

## Evidence

Demo code and measurements: [evidence/readers-shouldn-t-wait-on-writers.md](../evidence/readers-shouldn-t-wait-on-writers.md). Open it to quote a number or run the demo.

## Reading

- [Read Committed Is A Garbage Isolation Level In SQL Server](https://erikdarling.com/read-committed-is-a-garbage-isolation-level/)
- [How To Tell You Need An Optimistic Isolation Level In SQL Server](https://erikdarling.com/how-to-tell-you-need-an-optimistic-isolation-level-in-sql-server/)
- [The Difference Between Read Committed And Read Committed Snapshot Isolation In SQL Server](https://erikdarling.com/the-difference-between-read-committed-and-read-committed-snapshot-isolation-in-sql-server/)
