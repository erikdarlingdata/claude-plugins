# Upserts break under concurrency

Where it sits in the chart: A query > No NOLOCK > It changes data > "Is it an upsert?" (Update it if it's there, insert it if it isn't)

An upsert updates the row if it's there and inserts it if it isn't. It's an upsert whether you write it as [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql) or as [IF EXISTS](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/exists-transact-sql) then `UPDATE` else `INSERT`. Run single-threaded, every way of writing that works. Run concurrently, nearly all of them fail.

Michael J. Swart tested the usual suspects. `IF EXISTS` then `UPDATE` else `INSERT`, the same thing wrapped in a transaction, and plain `MERGE` all produced primary key violations, so being one statement doesn't save `MERGE`. In his words, it's "not isolated enough."

## What it costs

Two lock hints on the existence check, [UPDLOCK](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table) and `SERIALIZABLE`, so it holds a key-range lock (a lock on a range of key values) until the transaction ends. On a `MERGE`, `HOLDLOCK` (another name for `SERIALIZABLE`) alone is enough, because `MERGE` already reads its target with update locks. `UPDLOCK` alone under read committed (SQL Server's default isolation level) still loses the race, because you can't lock a row that doesn't exist yet without a key-range lock.

## What it risks

`SERIALIZABLE` by itself on a separate existence check swaps primary key violations for deadlocks: both sessions take shared key-range locks, then both try to insert. In Swart's 2011 tests, 82% of calls died as deadlock victims. On separate statements it takes both hints together.

## How fast it works

Immediately: the violations stop when the hinted version deploys. Pick the shape for your workload, update-first if the row usually exists and insert-first if it usually doesn't, so the common case takes one statement. Swart's advice is to pay "very close attention to your average use case."

## When it backfires

Unique data isn't a unique index. If you don't declare the key unique, SQL Server takes key-range locks out to infinity. Then concurrent upserts that check with `IF EXISTS`, or update first without [TOP](https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql) (1), deadlock anyway, hints and all.

## Evidence

Demo code and measurements: [evidence/upserts-break-under-concurrency.md](../evidence/upserts-break-under-concurrency.md). Open it to quote a number or run the demo.

## Reading

- [Mythbusting: Concurrent Update/Insert Solutions](https://michaeljswart.com/2011/09/mythbusting-concurrent-updateinsert-solutions/) (Michael J. Swart)
- [SQL Server UPSERT Patterns and Antipatterns](https://michaeljswart.com/2017/07/sql-server-upsert-patterns-and-antipatterns/) (Michael J. Swart)
- [UPSERT Requires a Unique Index](https://michaeljswart.com/2022/03/upsert-requires-a-unique-index/) (Michael J. Swart)
- [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql)
- [IF EXISTS](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/exists-transact-sql)
- [UPDLOCK](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table)
- [TOP](https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql)
- [@@ROWCOUNT](https://learn.microsoft.com/en-us/sql/t-sql/functions/rowcount-transact-sql)
- [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide)
