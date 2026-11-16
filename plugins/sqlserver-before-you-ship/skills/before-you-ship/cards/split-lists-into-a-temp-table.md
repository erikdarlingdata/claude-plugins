# Split lists into a #temp table

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Passing in a list of values?" (Comma-separated strings, STRING_SPLIT, table-valued parameters)

Apps send lists as comma-separated strings, and the query splits them with [STRING_SPLIT](https://learn.microsoft.com/en-us/sql/t-sql/functions/string-split-transact-sql) or a user-defined function. Whatever does the splitting, SQL Server has no statistics (its summary of a column's values) on what comes out. `STRING_SPLIT` gets a fixed guess of 50 rows, and no idea which values are in the list.

When the list feeds a join, put the split values into a `#temp` table first. Convert them to the type of the column they'll be compared with. Then the next query compiles against real row counts and statistics.

Table-valued parameters are table variables underneath, with the same blind spot: [Table variables don't know what's in them](table-variables-don-t-know-what-s-in-them.md).

## What it costs

One more statement and a `#temp` table. Split the string once, convert each value on the way in, and join to the `#temp` table from then on.

## What it risks

Values that don't convert. `STRING_SPLIT` returns strings, so a stray letter in the list fails the query with a conversion error wherever it's compared. Converting into the `#temp` table finds it before anything else runs. [TRY_CONVERT](https://learn.microsoft.com/en-us/sql/t-sql/functions/try-convert-transact-sql) turns it into a `NULL` you have to filter out, because the `#temp` table's key won't take it.

## How fast it works

The next query. In a test with one busy user and 99 quiet ones, SQL Server estimated the inline split at 50 values. The plan joined its way to 5 million rows one at a time, in a third to half a second. From the `#temp` table, the plan counted each user's posts first and finished in 40 to 100 ms.

## When it backfires

Empty strings. A trailing comma, or two commas in a row, gives `STRING_SPLIT` an empty value. [CONVERT](https://learn.microsoft.com/en-us/sql/t-sql/functions/cast-and-convert-transact-sql)`(integer, '')` returns 0 instead of an error, so the list quietly gains a 0. Filter out empty values on the way into the `#temp` table.

## Evidence

Demo code and measurements: [evidence/split-lists-into-a-temp-table.md](../evidence/split-lists-into-a-temp-table.md). Open it to quote a number or run the demo.

## Reading

- [Software Vendor Mistakes With SQL Server: String Splitting With Functions](https://erikdarling.com/software-vendor-mistakes-with-sql-server-string-splitting-with-functions/)
