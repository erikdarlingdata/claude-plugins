# Filtered indexes need to see the filter: evidence

The card: [Filtered indexes need to see the filter](../cards/filtered-indexes-need-to-see-the-filter.md)

A million tasks, a filtered index on the open ones, and the filter column carried in the `INCLUDE` list:

```sql
/*A million tasks. 1% of them still need doing.*/
CREATE TABLE
    dbo.Tasks
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    assigned_to integer NOT NULL,
    is_done bit NOT NULL,
    created datetime NOT NULL
);

INSERT
    dbo.Tasks
WITH
    (TABLOCK)
(
    id,
    assigned_to,
    is_done,
    created
)
SELECT
    x.id,
    assigned_to = CONVERT(integer, x.id % 5000 + 1),
    is_done =
        CASE
            WHEN x.id % 100 = 0
            THEN CONVERT(bit, 0)
            ELSE CONVERT(bit, 1)
        END,
    created = DATEADD(MINUTE, x.id, CONVERT(datetime, '20240101', 112))
FROM
(
    SELECT TOP (1000000)
        id = CONVERT(bigint, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

/*Index only the open tasks, and carry the filter column along*/
CREATE INDEX
    assigned_to_open
ON dbo.Tasks
    (assigned_to)
INCLUDE
    (created, is_done)
WHERE
    (is_done = 0);
```

The `is_done` column is in the `INCLUDE` list on purpose. Without it, a query that returns `is_done` has to do a key lookup back to the table for every row. It does that even though every row in the index has the same value. In a test with a filtered index that left its filter column out, selecting that column added a lookup per row.

The filter written in, and passed in:

```sql
/*The filter written into the query*/
SELECT
    t.id,
    t.created
FROM dbo.Tasks AS t
WHERE t.is_done = 0
AND   t.assigned_to = 101;

/*The filter passed in as a parameter*/
EXECUTE sys.sp_executesql
    N'
SELECT
    t.id,
    t.created
FROM dbo.Tasks AS t
WHERE t.is_done = @is_done
AND   t.assigned_to = @assigned_to;',
    N'@is_done bit, @assigned_to integer',
    @is_done = 0,
    @assigned_to = 101;
```

On **SQL Server 2025**, the first query seeked the filtered index and read 3 pages for 200 tasks. The second scanned the clustered index, 3,224 pages, in 50 to 70 ms, and its plan carried an Unmatched Indexes warning naming `assigned_to_open`. The first plan has the same warning: SQL Server tried simple parameterization first, gave up because of the filtered index, and used the index anyway. Adding `OPTION (RECOMPILE)` to the parameterized version also matched the index, in a separate test.

Only the filter needs to be literal:

```sql
/*Keep the filter literal, and parameterize the rest*/
EXECUTE sys.sp_executesql
    N'
SELECT
    t.id,
    t.created
FROM dbo.Tasks AS t
WHERE t.is_done = 0
AND   t.assigned_to = @assigned_to;',
    N'@assigned_to integer',
    @assigned_to = 101;
```

Seek, 3 pages, with a parameter for the person.

And the `SET` options. Each `SET` is in its own batch, because `QUOTED_IDENTIFIER` takes effect when SQL Server parses the next batch:

```sql
/*A session with the wrong SET options, like sqlcmd without -I*/
SET QUOTED_IDENTIFIER OFF;
GO

UPDATE
    t
SET
    t.is_done = 1
FROM dbo.Tasks AS t
WHERE t.id = 100;
GO

SET QUOTED_IDENTIFIER ON;
GO
```

Msg 1934: `UPDATE` failed because the following `SET` options have incorrect settings: '`QUOTED_IDENTIFIER`'. Indexed views and indexes on computed columns have the same requirement.
