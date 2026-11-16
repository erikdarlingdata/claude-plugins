# Convert the search value, not the column: evidence

The card: [Convert the search value, not the column](../cards/convert-the-search-value-not-the-column.md)

Using the votes from [Local variables hide their values](../cards/local-variables-hide-their-values.md), one a minute, stored in UTC, with an index on created:

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
