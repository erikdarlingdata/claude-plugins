# Know what you'll do with the error first: evidence

The card: [Know what you'll do with the error first](../cards/know-what-you-ll-do-with-the-error-first.md)

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
