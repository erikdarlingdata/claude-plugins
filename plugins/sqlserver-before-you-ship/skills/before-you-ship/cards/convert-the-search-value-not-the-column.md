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

## Evidence

Demo code and measurements: [evidence/convert-the-search-value-not-the-column.md](../evidence/convert-the-search-value-not-the-column.md). Open it to quote a number or run the demo.

## Reading

- [Learn T-SQL With Erik: AT TIME ZONE Performance](https://erikdarling.com/learn-t-sql-with-erik-at-time-zone-performance/)
- [Be Careful Where You Use AT TIME ZONE In Your SQL Server Queries](https://erikdarling.com/be-careful-where-you-use-at-time-zone/)
- [Learn T-SQL With Erik: DATEDIFF Considerations](https://erikdarling.com/learn-t-sql-with-erik-datediff-considerations/)
