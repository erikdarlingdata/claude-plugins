# Transactions you didn't know you opened

Where it sits in the chart: A query > No NOLOCK > It changes data > "Could a transaction stay open by accident?" (Implicit transactions, INSERT EXEC, errors)

The transaction holding your locks isn't always one you wrote. SQL Server's default is autocommit, where every statement commits on its own. The [IMPLICIT_TRANSACTIONS](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-implicit-transactions-transact-sql) setting turns that off, and it's kind of the worst.

The prime examples are pyodbc, which defaults to autocommit off, and JDBC with autocommit off, which both get there by turning `IMPLICIT_TRANSACTIONS` on. Once it's on, the first statement that touches a table, `SELECT`s included, opens a transaction that stays open until something commits.

If it's on and you can't turn it off, you probably need Read Committed Snapshot Isolation ([RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide)) too. With RCSI, readers stop waiting on transactions nobody remembers opening. It only helps readers (see [the upsert card](upserts-break-under-concurrency.md)).

And errors that only end the statement leave a transaction sitting open behind them.

## What it costs

`SET` [XACT_ABORT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-xact-abort-transact-sql) `ON` at the top of every procedure that modifies data. It's one line, and most errors, plus client timeouts, then roll back the whole transaction instead of leaving it open, but the exceptions are in the dive.

## What it risks

A forgotten transaction holds its locks until the application commits or the connection closes, which can be never. Optimized locking (one transaction lock in place of row and page locks) doesn't change that: anything that touches the changed rows still waits. It's always on in **Azure SQL Database** and off by default in **SQL Server 2025** (not in **Express**).

With row versioning on (SQL Server keeps old versions of changed rows), a forgotten transaction also stops version store cleanup in every database until it commits. So the version store grows the whole time it sits there: in tempdb, and inside any database with Accelerated Database Recovery on.

## How fast it works

These show up fast once you look. By default, `sp_WhoIsActive` lists sleeping sessions that hold open transactions. `@get_transaction_info = 1` adds when each transaction started and how much log it used.

## When it backfires

Counting on `XACT_ABORT` alone. [RAISERROR](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/raiserror-transact-sql) and syntax errors slip past it and leave the transaction open, so raise errors with [THROW](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/throw-transact-sql) and test the error paths.

## Deeper dive

See it for yourself. With `IMPLICIT_TRANSACTIONS` on, a plain `SELECT` from a table leaves a transaction open:

```sql
SET IMPLICIT_TRANSACTIONS ON;

SELECT TOP (1)
    u.Id
FROM dbo.Users AS u;

SELECT
    open_transactions = @@TRANCOUNT; /*1, and nobody wrote BEGIN TRANSACTION*/

IF @@TRANCOUNT > 0
    ROLLBACK TRANSACTION;

SET IMPLICIT_TRANSACTIONS OFF;
```

Until that `ROLLBACK` or a `COMMIT` runs, whatever that session locked stays locked. In an application, that's usually until the connection does something else, which can be never. With optimized locking on, its modifications hold one transaction lock plus table-level intent locks, and anything that touches those rows still waits. In a test, an update of the same row waited until rollback, and so did a plain read unless RCSI was on too.

What `XACT_ABORT ON` covers, tested on **SQL Server 2025** with an open transaction. Rolled back: primary key violations, `THROW`, references to objects that don't exist, and client timeouts. Still open afterward: `RAISERROR`, and syntax errors, whether they're in dynamic SQL or in a batch that fails to parse. With `XACT_ABORT OFF`, every one of those left the transaction open.

Two more ways a transaction outlives its welcome. `INSERT ... EXEC` runs the whole called procedure inside a transaction, so the transaction holds every lock the procedure takes until the insert finishes. [Who else depends on this?](mind-your-query-consumers.md) has the other way it bites. And RCSI is no fix for read-then-write code: in Swart's 2011 tests, RCSI made the plain upsert fail more often.

## Reading

- [Implicit Transactions: Why Unrelated Queries Block Each Other In SQL Server](https://erikdarling.com/implicit-transactions-why-unrelated-queries-block-each-other/)
