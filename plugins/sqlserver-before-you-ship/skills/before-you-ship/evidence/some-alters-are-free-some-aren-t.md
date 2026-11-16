# Some ALTERs are free. Some aren't.: evidence

The card: [Some ALTERs are free. Some aren't.](../cards/some-alters-are-free-some-aren-t.md)

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

If it can't get its lock within two seconds, it fails with error 1222 and everything queued behind it starts moving again. Retry it later, or in a loop like the one on [the error-handling card](../cards/know-what-you-ll-do-with-the-error-first.md).

In a test on **SQL Server 2025**, a query stuck behind a waiting `ALTER` waited 3.5 seconds with no timeout. With a two-second one, it waited about 1 second. [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) (Read Committed Snapshot Isolation) and **SQL Server 2025**'s optimized locking made no difference to either number, because the queued query needs a schema stability lock either way.

Two things to know before putting this in a deploy script:

- The timeout lasts for the whole session, so set it back, and do it in its own batch. In testing, the 1222 ended the rest of the batch it happened in, so a reset on the next line never ran.
- Run the script so a failure stops it (sqlcmd -b, or [TRY/CATCH](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/try-catch-transact-sql) with [THROW](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/throw-transact-sql)). Otherwise the backfill and index builds that come next run against a table that never changed.

[WAIT_AT_LOW_PRIORITY](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-index-transact-sql) is the built-in version of this, and it covers more with each release. Online `ALTER INDEX REBUILD` and partition [SWITCH](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql) got it in **SQL Server 2014**, and online `CREATE INDEX` and `DBCC` [SHRINKFILE](https://learn.microsoft.com/en-us/sql/t-sql/database-console-commands/dbcc-shrinkfile-transact-sql) got it in **2022**. It doesn't cover `ALTER TABLE ... ADD` or `ALTER COLUMN`, which is why the timeout is still the move for column changes.
