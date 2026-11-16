# Index the expression with a computed column: evidence

The card: [Index the expression with a computed column](../cards/index-the-expression-with-a-computed-column.md)

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

That last query never touches `minutes_open`, and it still ran serially. Its plan cost was about 54, against 14 for the same query on `dbo.Tickets`, where it went parallel. A schemabound function like this one is even indexable, which makes the trap easier to fall into. [Most functions hide their work](../cards/most-functions-hide-their-work.md) covers scalar UDFs in general.
