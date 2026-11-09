# Some ALTERs are free. Some aren't.

Where it sits in the chart: A table > An existing table > "Adding a column" (Metadata-only, or size-of-data?)

Adding a column is either a metadata-only change, done in milliseconds regardless of table size, or a size-of-data operation. That one rewrites every row under a schema modification lock (a lock that blocks every other query on the table). Which one you get depends on version, edition, nullability, defaults, and details that shift between releases: too many variations to memorize, so don't. Test the exact `ALTER` on a production-sized copy, every time.

And the `ALTER` isn't the only question. Look at how wide the table already is before making it wider, and think about how queries will use the column. Does it fit into an existing index, or are you signing up for new ones to cover the query patterns around it? That last question belongs to the index door, starting with [Widen before you add](widen-before-you-add.md).

## What it costs

Metadata-only: nearly free. Size-of-data: log, time, and an exclusive hold on the table proportional to how big it got since someone last thought about this.

## What it risks

Trusting a rule you read in a blog post about a different version. The ten-row dev table where everything finishes instantly is the trap.

## How fast it works

Metadata-only adds finish in milliseconds no matter how big the table is. Size-of-data adds take as long as rewriting every row does. Only the test tells you which one you're getting.

## When it backfires

The schema modification lock queues behind every running query and makes every new query queue behind it. Even a genuinely instant `ALTER` stuck behind a ten-minute report is a ten-minute outage. Give the `ALTER` a short [LOCK_TIMEOUT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-lock-timeout-transact-sql) so it gives up instead of holding the line, and the dive has the pattern.

And any `SELECT *` view over the table now has a stale contract. It won't show the new column until refreshed, and when it is, everything reading the view gets a new shape.

## Deeper dive

Give the `ALTER` a short fuse, so it gives up instead of becoming the head of a blocking chain:

```sql
SET LOCK_TIMEOUT 2000; /*milliseconds*/

ALTER TABLE
    dbo.TableName
ADD
    NewColumn integer NULL;
GO

SET LOCK_TIMEOUT -1; /*Back to waiting as long as it takes*/
GO
```

If it can't get its lock within two seconds, it fails with error 1222 and everything queued behind it starts moving again. Retry it later, or in a loop like the one on [the error-handling card](know-what-you-ll-do-with-the-error-first.md).

In a test on **SQL Server 2025**, a query stuck behind a waiting `ALTER` waited 3.5 seconds with no timeout. With a two-second one, it waited about 1 second. [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) (Read Committed Snapshot Isolation) and **SQL Server 2025**'s optimized locking made no difference to either number, because the queued query needs a schema stability lock either way.

Two things to know before putting this in a deploy script:

- The timeout lasts for the whole session, so set it back, and do it in its own batch. In testing, the 1222 ended the rest of the batch it happened in, so a reset on the next line never ran.
- Run the script so a failure stops it (sqlcmd -b, or [TRY/CATCH](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/try-catch-transact-sql) with [THROW](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/throw-transact-sql)). Otherwise the backfill and index builds that come next run against a table that never changed.

[WAIT_AT_LOW_PRIORITY](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-index-transact-sql) is the built-in version of this, and it covers more with each release. Online `ALTER INDEX REBUILD` and partition [SWITCH](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql) got it in **SQL Server 2014**, and online `CREATE INDEX` and `DBCC` [SHRINKFILE](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-shrinkfile-transact-sql) got it in **2022**. It doesn't cover `ALTER TABLE ... ADD` or `ALTER COLUMN`, which is why the timeout is still the move for column changes.
