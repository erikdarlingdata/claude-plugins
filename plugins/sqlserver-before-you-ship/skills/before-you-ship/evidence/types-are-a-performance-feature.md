# Types are a performance feature: evidence

The card: [Types are a performance feature](../cards/types-are-a-performance-feature.md)

One table, the same short strings in two columns. One column is `nvarchar(100)`, the other is `nvarchar(MAX)`:

```sql
CREATE TABLE
    dbo.TypeDemo
(
    id integer NOT NULL
       PRIMARY KEY CLUSTERED,
    category integer NOT NULL,
    score integer NOT NULL,
    sized_text nvarchar(100) NOT NULL,
    max_text nvarchar(MAX) NOT NULL
);

INSERT
    dbo.TypeDemo
WITH
    (TABLOCK)
(
    id,
    category,
    score,
    sized_text,
    max_text
)
SELECT
    x.id,
    category = x.id % 100,
    score = CONVERT(integer, x.id * 7919 % 100000),
    sized_text = N'Row number ' + CONVERT(nvarchar(11), x.id),
    max_text = N'Row number ' + CONVERT(nvarchar(11), x.id)
FROM
(
    SELECT TOP (100000)
        id = ROW_NUMBER() OVER (ORDER BY 1/0)
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

/*max_text can be included, but it can never be a key column*/
CREATE INDEX
    category
ON dbo.TypeDemo
    (category)
INCLUDE
    (sized_text, max_text);
```

Return each text column, sorted by score. Neither text column is the sort key, and score has no index, so both queries need a Sort, which you can see with the actual execution plan on:

```sql
/*score has no index, so both queries have to sort*/
SELECT
    td.id,
    td.sized_text
FROM dbo.TypeDemo AS td
ORDER BY
    td.score;

SELECT
    td.id,
    td.max_text
FROM dbo.TypeDemo AS td
ORDER BY
    td.score;
```

Same 100,000 rows, same data, same sort column. On **SQL Server 2025**, the query returning the `nvarchar(100)` column asked for 22,992 KB of memory, got it, and used 8,752 KB. The one returning the `nvarchar(MAX)` column asked for 559,488 KB, about 24 times as much, and got 355,672 KB, the most that test server gives a single query, and it used 11,128 KB. The rest stayed reserved until the query finished, off limits to every other query.

The `MAX` column only rides through the Sort, and the grant gets sized for it anyway. Memory grant feedback shrank both grants on the next run, to 14,240 and 18,128 KB, on editions that have it, but the first run still asks for the oversized grant.

The difference is all estimate. The plan sizes each row at 119 bytes with the `nvarchar(100)` column, which it assumes is half full. It sizes each row at 4,043 bytes with the `MAX` column, whatever is in it. Grants scale with server memory, so your numbers will differ, but the gap won't go away.

Then the filters. Both columns are in the index on category, so SQL Server can check both predicates without going back to the table:

```sql
SELECT
    td.id
FROM dbo.TypeDemo AS td
WHERE td.category = 42
AND   td.sized_text = N'Row number 42';

SELECT
    td.id
FROM dbo.TypeDemo AS td
WHERE td.category = 42
AND   td.max_text = N'Row number 42';
```

In the first plan, the seek checks `sized_text` as it reads each row. In the second, the seek hands all 1,000 rows for category 42 to a separate Filter operator. The Filter checks `max_text` and throws away 999 of them.

SQL Server won't evaluate a predicate on a `MAX` column inside a seek or scan. So the seek or scan reads every row and passes it along before the check happens.

Parameters and variables typed `MAX` do the same thing to columns that aren't `MAX`. Index `sized_text`, then compare it to a variable of each type:

```sql
CREATE INDEX
    sized_text
ON dbo.TypeDemo
    (sized_text);

DECLARE
    @max_text nvarchar(MAX) = N'Row number 42';

SELECT
    td.id
FROM dbo.TypeDemo AS td
WHERE td.sized_text = @max_text
OPTION (RECOMPILE);
GO

DECLARE
    @sized_text nvarchar(4000) = N'Row number 42';

SELECT
    td.id
FROM dbo.TypeDemo AS td
WHERE td.sized_text = @sized_text
OPTION (RECOMPILE);
```

The `nvarchar(MAX)` variable got a `GetRangeWithMismatchedTypes` seek plus a Filter, even with `OPTION` ([RECOMPILE](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query)), where the `nvarchar(4000)` variable got a plain seek. Don't send `MAX`-typed parameters at columns that aren't `MAX`. [The app picks your parameter types](../cards/the-app-picks-your-parameter-types.md) covers where those parameters come from.
