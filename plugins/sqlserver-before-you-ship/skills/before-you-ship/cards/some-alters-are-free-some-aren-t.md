# Some ALTERs are free. Some aren't.

**Requires:** the metadata-only `NOT NULL` column with a runtime-constant default is documented for **Enterprise** edition since **SQL Server 2012**.

Where it sits in the chart: A table > An existing table > "Adding a column" (Metadata-only, or size-of-data?)

Adding a column is either a metadata-only change, done in milliseconds regardless of table size, or a size-of-data operation. That one rewrites every row under a schema modification lock (a lock that blocks every other query on the table). Which one you get depends on version, edition, nullability, defaults, and details that shift between releases: too many variations to memorize, so don't. Test the exact `ALTER` on a production-sized copy, every time.

A few rules do hold still. Adding a nullable column with no default is metadata-only. Adding a `NOT NULL` column with a default is metadata-only when the default is a runtime constant, a literal or `SYSDATETIME()`, and the [ALTER TABLE](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql) docs promise that for **Enterprise edition** since **SQL Server 2012** and nowhere else. `NEWID()` and `NEWSEQUENTIALID()` don't count, because they produce a different value per row, so that `ALTER` rewrites the table under a schema modification lock. Adding an `IDENTITY` column or a `PERSISTED` computed column rewrites the table too.

And the `ALTER` isn't the only question. Look at how wide the table already is before making it wider, and think about how queries will use the column. Does it fit into an existing index, or are you signing up for new ones to cover the query patterns around it? That last question belongs to the index door, starting with [Widen before you add](widen-before-you-add.md).

## What it costs

Metadata-only: nearly free. Size-of-data: log, time, and an exclusive hold on the table proportional to how big it got since someone last thought about this.

## What it risks

Trusting a rule you read in a blog post about a different version. The ten-row dev table where everything finishes instantly is the trap.

## How fast it works

Metadata-only adds finish in milliseconds no matter how big the table is. Size-of-data adds take as long as rewriting every row does. Only the test tells you which one you're getting.

## When it backfires

The schema modification lock queues behind every running query and makes every new query queue behind it. Even a genuinely instant `ALTER` stuck behind a ten-minute report is a ten-minute outage. Give the `ALTER` a short [LOCK_TIMEOUT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-lock-timeout-transact-sql) so it gives up instead of holding the line, and the evidence file has the pattern.

And any `SELECT *` view over the table now has a stale contract. It won't show the new column until refreshed, and when it is, everything reading the view gets a new shape.

## Evidence

Demo code and measurements: [evidence/some-alters-are-free-some-aren-t.md](../evidence/some-alters-are-free-some-aren-t.md). Open it to quote a number or run the demo.

## Reading

- [ALTER TABLE](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql)
- [LOCK_TIMEOUT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-lock-timeout-transact-sql)
- [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide)
- [TRY/CATCH](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/try-catch-transact-sql)
- [THROW](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/throw-transact-sql)
- [WAIT_AT_LOW_PRIORITY](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-index-transact-sql)
- [SHRINKFILE](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-shrinkfile-transact-sql)
