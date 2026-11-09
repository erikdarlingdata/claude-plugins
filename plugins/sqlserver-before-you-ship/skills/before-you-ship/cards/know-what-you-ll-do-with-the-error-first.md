# Know what you'll do with the error first

Where it sits in the chart: A query > No NOLOCK > It changes data > "What happens when it fails?" (Decide before you write TRY/CATCH)

Before writing any error handling, decide what you want to happen. As far as I'm concerned there are four outcomes:

- Print an informational message and keep chugging along.
- Raise and log the error and stop everything, with or without a rollback.
- Raise and log it and keep going.
- Use the type of error to retry the thing you were trying to do.

If you're not going to do one of those, there's no point in error handling in your procedures. Transactions are a different story: [XACT_ABORT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-xact-abort-transact-sql) `ON` and a transaction get you all-or-nothing for most errors without writing any, and [the transactions card](transactions-you-didn-t-know-you-opened.md) has the exceptions.

## What it costs

Thinking time before coding time. And some checks don't belong in SQL Server at all. If an application sends a start date that's after the end date, catch it in the application before the query ever arrives. The application server is a lot cheaper than the SQL Server.

Inside SQL Server, error handling is cheap until it catches something. In a test, catching an error on every call made 100,000 calls about seven times slower than a [CASE](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/case-transact-sql) expression that avoided the error, so check for the errors you can predict instead of catching them.

## What it risks

Retrying the wrong errors. Deadlocks (1205), lock timeouts (1222), and snapshot update conflicts (3960) are worth another try. Most other errors will fail the same way twice, so re-throw them with [THROW](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/throw-transact-sql).

## How fast it works

Brief conflicts usually clear within a retry or two. Back off exponentially with a little random jitter, so two sessions that collided once don't collide again on the same schedule.

## When it backfires

Retrying without cleaning up. Check [XACT_STATE](https://learn.microsoft.com/en-us/sql/t-sql/functions/xact-state-transact-sql)() in the [CATCH](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/try-catch-transact-sql) block and roll back anything still open before the next attempt, or the retry runs inside the old transaction: doomed (it can't commit) if `XACT_STATE()` is -1, still open and holding its locks if it's 1.

## Deeper dive

The shape of a retry loop for the errors worth retrying, adapted from the course's simplified pattern:

```sql
DECLARE
    @RetryCount integer = 0,
    @MaxRetries integer = 10,
    @Success bit = 0,
    @Delay integer = 100,
    @WaitFor datetime,
    @Message nvarchar(2048);

WHILE @RetryCount < @MaxRetries
AND   @Success = 0
BEGIN
    BEGIN TRY
        SET NOCOUNT, XACT_ABORT ON;

        BEGIN TRANSACTION;
            /*Your modification here*/
        COMMIT TRANSACTION;

        SET @Success = 1;
    END TRY
    BEGIN CATCH
        IF XACT_STATE() <> 0
            ROLLBACK TRANSACTION;

        IF ERROR_NUMBER() IN (1205, 1222, 3960)
        BEGIN
            SET @RetryCount += 1;

            /*No point waiting after the last attempt*/
            IF @RetryCount < @MaxRetries
            BEGIN
                /*Exponential backoff with jitter*/
                SET @Delay = @Delay * 2 + (ABS(CHECKSUM(NEWID())) % 100);
                SET @WaitFor = DATEADD(MILLISECOND, @Delay, CONVERT(datetime, 0));
                WAITFOR DELAY @WaitFor;
            END;
        END;
        ELSE
        BEGIN;
            THROW;
        END;
    END CATCH;
END;

IF @Success = 0
BEGIN
    SET @Message = FORMATMESSAGE(N'Failed after %d retries due to locking conflicts.', @MaxRetries);
    THROW 50000, @Message, 1;
END;
```

Doubling from 100ms means ten attempts add up to minutes of waiting. Size `@MaxRetries` to how long the caller will wait.

The cost of catching, from [Alexander Kuznetsov's 2011 benchmark](https://web.archive.org/web/20160502081042/http://sqlblog.com/blogs/alexander_kuznetsov/archive/2011/07/26/entering-try-blocks-is-not-free-but-still-eight-times-cheaper-than-catching-exceptions.aspx), rerun on **SQL Server 2025**. A procedure divides two numbers, called 100,000 times, either guarding the divisor with `CASE` or wrapping the division in `TRY/CATCH`.

The `CASE` version used 458 to 575 ms of CPU, whether the divisor was 0 or not. The `TRY` version used 543 to 594 ms when nothing failed, and 3,466 to 3,603 ms when every call divided by zero and landed in `CATCH`. Entering a `TRY` block barely registers anymore (Alex measured 36% in 2011), but catching still costs about 30 microseconds a call.

That's no argument against the retry loop above, because no `CASE` expression prevents a deadlock. It's an argument for checking first when you can see the error coming.

## Reading

- [The Art Of The SQL Server Stored Procedure: Error Handling](https://erikdarling.com/the-art-of-the-sql-server-stored-procedure-error-handling/)
- [All About SQL Server Stored Procedures: Error And Situation Handling](https://erikdarling.com/all-about-sql-server-stored-procedures-error-and-situation-handling/)
- [Entering TRY blocks is not free, but still several times cheaper than catching exceptions](https://web.archive.org/web/20160502081042/http://sqlblog.com/blogs/alexander_kuznetsov/archive/2011/07/26/entering-try-blocks-is-not-free-but-still-eight-times-cheaper-than-catching-exceptions.aspx) (Alexander Kuznetsov, via the Wayback Machine)
