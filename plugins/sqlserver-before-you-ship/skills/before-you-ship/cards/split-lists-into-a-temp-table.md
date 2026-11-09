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

## Deeper dive

Using the votes from [Local variables hide their values](local-variables-hide-their-values.md) and the posts from [Don't join on OR](don-t-join-on-or.md), with user 1 casting a quarter of all votes:

```sql
/*One busy user and 99 quiet ones, the way an app might send them*/
DECLARE
    @user_ids varchar(8000) =
    (
        SELECT
            STRING_AGG(CONVERT(varchar(11), x.user_id), ',')
        FROM
        (
            SELECT
                user_id = 1
            UNION ALL
            (
                SELECT TOP (99)
                    v.user_id
                FROM dbo.Votes AS v
                WHERE v.user_id > 1
                GROUP BY
                    v.user_id
                ORDER BY
                    v.user_id
            )
        ) AS x
    );

/*Split it inline*/
SELECT
    votes = COUNT_BIG(*)
FROM STRING_SPLIT(@user_ids, ',') AS ss
JOIN dbo.Votes AS v
  ON v.user_id = ss.value
JOIN dbo.Posts AS p
  ON p.owner_user_id = v.user_id;

/*Split it into a #temp table first, with the right type*/
CREATE TABLE
    #user_ids
(
    user_id integer NOT NULL
        PRIMARY KEY
);

INSERT
    #user_ids
(
    user_id
)
SELECT DISTINCT
    user_id = CONVERT(integer, ss.value)
FROM STRING_SPLIT(@user_ids, ',') AS ss
WHERE ss.value <> '';

SELECT
    votes = COUNT_BIG(*)
FROM #user_ids AS ui
JOIN dbo.Votes AS v
  ON v.user_id = ui.user_id
JOIN dbo.Posts AS p
  ON p.owner_user_id = v.user_id;
```

On **SQL Server 2025**, the inline version estimated 50 values out of `STRING_SPLIT` and about 4,200 rows out of the joins. 5,004,950 rows came out, through two Nested Loops joins, in a third to half a second with actual plans off.

The `#temp` version knew it had 100 user ids and 500,495 votes. It joined the 100 users to their posts, counted them, then read each user's votes once. It got the same 5,004,950 rows in 40 to 100 ms, plus about 12 ms to fill the `#temp` table.

The `INSERT` is also where the list gets cleaned up. `DISTINCT` drops repeats, and `WHERE ss.value <> ''` drops the empty values a stray comma leaves behind.

## Reading

- [Software Vendor Mistakes With SQL Server: String Splitting With Functions](https://erikdarling.com/software-vendor-mistakes-with-sql-server-string-splitting-with-functions/)
