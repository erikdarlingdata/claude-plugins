# Split lists into a #temp table: evidence

The card: [Split lists into a #temp table](../cards/split-lists-into-a-temp-table.md)

Using the votes from [Local variables hide their values](../cards/local-variables-hide-their-values.md) and the posts from [Don't join on OR](../cards/don-t-join-on-or.md), with user 1 casting a quarter of all votes:

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
            SELECT TOP (99)
                v.user_id
            FROM dbo.Votes AS v
            WHERE v.user_id > 1
            GROUP BY
                v.user_id
            ORDER BY
                v.user_id
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
