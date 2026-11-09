# Index the expression with a computed column

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

## Deeper dive

A million tickets, each opened and closed:

```sql
/*A million support tickets, each opened and then closed*/
CREATE TABLE
    dbo.Tickets
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    opened datetime NOT NULL,
    closed datetime NOT NULL
);

INSERT
    dbo.Tickets
WITH
    (TABLOCK)
(
    id,
    opened,
    closed
)
SELECT
    x.id,
    opened = x.opened,
    closed = DATEADD(MINUTE, CONVERT(integer, x.id * 7 % 600 + CASE WHEN x.id % 1000 = 0 THEN 2000 ELSE 0 END), x.opened)
FROM
(
    SELECT TOP (1000000)
        id = CONVERT(bigint, ROW_NUMBER() OVER (ORDER BY 1/0)),
        opened = DATEADD(MINUTE, CONVERT(integer, ROW_NUMBER() OVER (ORDER BY 1/0)), CONVERT(datetime, '20240101', 112))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;
```

The question:

```sql
/*Tickets that stayed open more than a day*/
SELECT
    tickets = COUNT_BIG(*)
FROM dbo.Tickets AS t
WHERE DATEDIFF(MINUTE, t.opened, t.closed) > 1440;
```

On **SQL Server 2025**, that scanned the clustered index, 3,593 pages, in 74 to 140 ms. There's no index that can help, because the value it compares only exists once SQL Server reads both columns. So name it, and index it:

```sql
/*Give the expression a name and an index. Not persisted: adding it is metadata only.*/
ALTER TABLE
    dbo.Tickets
ADD
    minutes_open AS DATEDIFF(MINUTE, opened, closed);

CREATE INDEX
    minutes_open
ON dbo.Tickets
    (minutes_open);
```

Run the same query again, unchanged, and it seeks the `minutes_open` index: 6 pages, 1 ms. Writing it as `t.minutes_open > 1440`, or as 1440 `<` `DATEDIFF(MINUTE, t.opened, t.closed)`, or with mi for `MINUTE`, matched too. This one didn't:

```sql
/*The same expression, written differently*/
SELECT
    tickets = COUNT_BIG(*)
FROM dbo.Tickets AS t
WHERE DATEDIFF(HOUR, t.opened, t.closed) > 24;
```

Back to the clustered index scan. `DATEDIFF` counts boundaries crossed, so hours and minutes don't line up exactly anyway, and the optimizer won't treat them as the same expression.

The same column defined through a scalar UDF, on a copy of the table:

```sql
/*A copy of the table, to try the same column through a scalar function*/
SELECT
    t.id,
    t.opened,
    t.closed
INTO dbo.TicketsUdf
FROM dbo.Tickets AS t;

ALTER TABLE
    dbo.TicketsUdf
ADD CONSTRAINT
    tickets_udf_id
PRIMARY KEY CLUSTERED
    (id);
GO

CREATE OR ALTER FUNCTION
    dbo.MinutesBetween
(
    @start datetime,
    @end datetime
)
RETURNS integer
WITH SCHEMABINDING
AS
BEGIN
    RETURN DATEDIFF(MINUTE, @start, @end);
END;
GO

ALTER TABLE
    dbo.TicketsUdf
ADD
    minutes_open AS dbo.MinutesBetween(opened, closed);
GO

/*A query that never mentions minutes_open*/
SELECT
    opened_day = CONVERT(date, t.opened),
    tickets = COUNT_BIG(*)
FROM dbo.TicketsUdf AS t
GROUP BY
    CONVERT(date, t.opened)
ORDER BY
    tickets DESC;
```

That last query never touches `minutes_open`, and it still ran serially. Its plan cost was about 54, against 14 for the same query on `dbo.Tickets`, where it went parallel. A schemabound function like this one is even indexable, which makes the trap easier to fall into. [Most functions hide their work](most-functions-hide-their-work.md) covers scalar UDFs in general.

## Reading

- [Indexing SQL Server Queries For Performance: Computed Columns](https://erikdarling.com/indexing-sql-server-queries-for-performance-computed-columns/)
- [Software Vendor Mistakes With SQL Server: Using Scalar UDFs In Computed Columns Or Check Constraints](https://erikdarling.com/software-vendor-mistakes-with-sql-server-using-scalar-udfs-in-computed-columns-or-check-constraints/)
