# Index the expression with a computed column

**Requires:** nothing. Scalar UDF inlining doesn't apply to computed columns, even on **SQL Server 2025**.

Where it sits in the chart: An index > A new index > "Filtering on an expression you can't rewrite?" (Math across two columns, function results, CASE expressions)

Some predicates (filters in a `WHERE` clause) can't be rewritten to seek. [DATEDIFF](https://learn.microsoft.com/en-us/sql/t-sql/functions/datediff-transact-sql)`(MINUTE, opened, closed) > 1440` compares two columns from the same row, so there's no search value to move the math onto.

A computed column gives the expression a name, and an index on that column stores the result in order. Queries don't have to mention the column: when a query uses the same expression, SQL Server matches it to the index on its own.

The column doesn't need to be persisted (stored in the table). So adding it is a metadata change, and only the index takes time to build.

## What it costs

An index to build and maintain like any other: every insert, and every update to a column in the expression, recalculates it. The expression also has to be deterministic, so [GETDATE](https://learn.microsoft.com/en-us/sql/t-sql/functions/getdate-transact-sql)() is out, and so is converting a date to a string without a style number. [COLUMNPROPERTY](https://learn.microsoft.com/en-us/sql/t-sql/functions/columnproperty-transact-sql)`(..., 'IsIndexable')` says whether it qualifies before you try.

## What it risks

Expression matching is literal-minded. In a test, the index matched `DATEDIFF(MINUTE, t.opened, t.closed) > 1440`, the same comparison flipped around, and `DATEDIFF(mi, ...)`. It didn't match `DATEDIFF(HOUR, t.opened, t.closed) > 24`, which asks almost the same question, and that query went back to scanning the table.

Referring to the column by name matched every time the session had the `SET` options (connection settings) that indexes on computed columns need. Those are the same ones [filtered indexes](filtered-indexes-need-to-see-the-filter.md) need. With [QUOTED_IDENTIFIER](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-quoted-identifier-transact-sql) `OFF`, even referring to the column by name scanned.

## How fast it works

Immediate. Counting the 1,000 tickets that stayed open more than a day read 3,593 pages in 74 to 140 ms without the index. With it, the same count read 6 pages in 1 ms.

## When it backfires

A scalar [UDF](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-function-transact-sql) (a user-defined function that returns one value) in the computed column. Defining the same column through a scalar UDF made a query on the table that never mentions the column run serially. It took 64 to 76 ms, with `NonParallelPlanReason` TSQLUserDefinedFunctionsNotParallelizable. On the table without the UDF, the same query took 46 to 47 ms in parallel. Scalar UDF inlining doesn't apply to computed columns, even on **SQL Server 2025**.

## Evidence

Demo code and measurements: [evidence/index-the-expression-with-a-computed-column.md](../evidence/index-the-expression-with-a-computed-column.md). Open it to quote a number or run the demo.

## Reading

- [Indexing SQL Server Queries For Performance: Computed Columns](https://erikdarling.com/indexing-sql-server-queries-for-performance-computed-columns/)
- [Software Vendor Mistakes With SQL Server: Using Scalar UDFs In Computed Columns Or Check Constraints](https://erikdarling.com/software-vendor-mistakes-with-sql-server-using-scalar-udfs-in-computed-columns-or-check-constraints/)
