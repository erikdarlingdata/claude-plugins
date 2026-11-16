# Transactions you didn't know you opened: evidence

The card: [Transactions you didn't know you opened](../cards/transactions-you-didn-t-know-you-opened.md)

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

Two more ways a transaction outlives its welcome. `INSERT ... EXEC` runs the whole called procedure inside a transaction, so the transaction holds every lock the procedure takes until the insert finishes. [Who else depends on this?](../cards/mind-your-query-consumers.md) has the other way it bites. And RCSI is no fix for read-then-write code: in Swart's 2011 tests, RCSI made the plain upsert fail more often.
