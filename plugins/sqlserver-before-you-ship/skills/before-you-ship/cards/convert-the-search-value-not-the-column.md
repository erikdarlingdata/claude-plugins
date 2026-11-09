# Convert the search value, not the column

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Filtering by date or time zone?" (DATEDIFF, AT TIME ZONE, or BETWEEN on a datetime column)

Date filters break the same way other filters do ([Filter so indexes can help you](filter-so-indexes-can-help-you.md)). Wrap the column in a function, [CONVERT](https://learn.microsoft.com/en-us/sql/t-sql/functions/cast-and-convert-transact-sql)`(date, column)` aside, and SQL Server has to compute it for every row before it can compare anything.

Dates have a few traps of their own. [DATEDIFF](https://learn.microsoft.com/en-us/sql/t-sql/functions/datediff-transact-sql)`(DAY, column, @day) = 0` looks like a date comparison, and it reads the whole index. The same question as a range, `column >= @day AND column` `<` the next day, seeks.

`AT TIME ZONE` on the column converts every row in the table. Convert the search values to the column's time zone instead.

And write ranges with `>=` and `<`, not [BETWEEN](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/between-transact-sql), so there's no last moment of the day to get wrong.

## What it costs

Nothing at runtime. Moving the math to the other side takes some care. The end of a range is the start of the next day, month, or year. A time zone conversion happens once, on each search value, converted back to the column's type.

## What it risks

Boundaries. `BETWEEN '20250101' AND '2025-01-31T23:59:59.999'` looks like January, but `datetime` rounds .999 up to midnight on February 1. So in a test it counted 44,641 votes where January had 44,640. A range that ends with `<` the first day of the next month can't round into it.

## How fast it works

Immediate. Counting one day of votes out of two million, `DATEDIFF` on the column scanned the index, 4,515 pages, in 63 to 76 ms. The range seeked 7 pages in a few milliseconds at most. Converting the column with `AT TIME ZONE` took 11 to 14 seconds. Converting the two search values took a millisecond.

## When it backfires

Swapping `AT TIME ZONE` for a fixed offset to save time. Converting the search values with `AT TIME ZONE` already costs next to nothing. And [DATEADD](https://learn.microsoft.com/en-us/sql/t-sql/functions/dateadd-transact-sql)`(HOUR, 5, ...)` is wrong for New York every day daylight saving time is in effect. For July 15, it missed the first hour of the day and counted an hour of July 16, 60 votes each way.

## Deeper dive

Using the votes from [Local variables hide their values](local-variables-hide-their-values.md), one a minute, stored in UTC, with an index on created:

```sql
CREATE INDEX
    created
ON dbo.Votes
    (created);
```

```sql
/*Votes cast on January 15, 2025*/

/*Math on the column*/
SELECT
    votes = COUNT_BIG(*)
FROM dbo.Votes AS v
WHERE DATEDIFF(DAY, v.created, CONVERT(datetime, '20250115', 112)) = 0;

/*The same question as a range*/
SELECT
    votes = COUNT_BIG(*)
FROM dbo.Votes AS v
WHERE v.created >= CONVERT(datetime, '20250115', 112)
AND   v.created <  CONVERT(datetime, '20250116', 112);
```

On **SQL Server 2025**, the `DATEDIFF` version scanned the whole created index in parallel, 4,515 pages, to count 1,440 votes in 63 to 76 ms. The range seeked straight to them: 7 pages, 0 to 5 ms.

Time zones. The votes are in UTC, and someone wants a day in New York time:

```sql
/*Votes are stored in UTC. Count the ones cast on January 15, 2025, New York time.*/

/*Converting the column: every row, every time*/
SELECT
    votes = COUNT_BIG(*)
FROM dbo.Votes AS v
WHERE CONVERT(datetime, v.created AT TIME ZONE 'UTC' AT TIME ZONE 'Eastern Standard Time') >= CONVERT(datetime, '20250115', 112)
AND   CONVERT(datetime, v.created AT TIME ZONE 'UTC' AT TIME ZONE 'Eastern Standard Time') <  CONVERT(datetime, '20250116', 112);

/*Converting the two search values instead*/
SELECT
    votes = COUNT_BIG(*)
FROM dbo.Votes AS v
WHERE v.created >= CONVERT(datetime, CONVERT(datetime, '20250115', 112) AT TIME ZONE 'Eastern Standard Time' AT TIME ZONE 'UTC')
AND   v.created <  CONVERT(datetime, CONVERT(datetime, '20250116', 112) AT TIME ZONE 'Eastern Standard Time' AT TIME ZONE 'UTC');
```

Converting the column scanned the index and ran the conversion on all two million rows. It took 11 to 14 seconds, with 20 seconds of CPU across two threads. Converting the two search values seeked 8 pages in a millisecond, and returned the same 1,440 votes (checked with [EXCEPT](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/set-operators-except-and-intersect-transact-sql)). Its estimate was off, 328,634 rows for 1,440, because the optimizer can't evaluate `AT TIME ZONE` ahead of time.

If the query does more than count, check the plan. `sys.time_zone_info` lists the names `AT TIME ZONE` accepts.

Ranges:

```sql
/*January, the BETWEEN way*/
SELECT
    votes = COUNT_BIG(*)
FROM dbo.Votes AS v
WHERE v.created BETWEEN CONVERT(datetime, '20250101', 112)
                    AND CONVERT(datetime, '2025-01-31T23:59:59.999', 126);

/*January, the half-open way*/
SELECT
    votes = COUNT_BIG(*)
FROM dbo.Votes AS v
WHERE v.created >= CONVERT(datetime, '20250101', 112)
AND   v.created <  CONVERT(datetime, '20250201', 112);
```

44,641 and 44,640. The `BETWEEN` picked up the vote cast at midnight on February 1. That's because `datetime` only stores times to about 3 ms, and .999 rounds up to the next day. `datetime2(3)` and up keep the .999, but `datetime2(0)` through (2) round it up to February 1 the same way. So the half-open range is the one to use everywhere.

## Reading

- [Learn T-SQL With Erik: AT TIME ZONE Performance](https://erikdarling.com/learn-t-sql-with-erik-at-time-zone-performance/)
- [Be Careful Where You Use AT TIME ZONE In Your SQL Server Queries](https://erikdarling.com/be-careful-where-you-use-at-time-zone/)
- [Learn T-SQL With Erik: DATEDIFF Considerations](https://erikdarling.com/learn-t-sql-with-erik-datediff-considerations/)
