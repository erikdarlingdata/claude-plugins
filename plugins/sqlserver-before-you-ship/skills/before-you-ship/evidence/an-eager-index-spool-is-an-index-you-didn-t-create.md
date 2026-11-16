# An Eager Index Spool is an index you didn't create: evidence

The card: [An Eager Index Spool is an index you didn't create](../cards/an-eager-index-spool-is-an-index-you-didn-t-create.md)

Using the users from [Don't join on OR](../cards/don-t-join-on-or.md), and a comments table with no index on who wrote them:

```sql
/*Two million comments, and no index on who wrote them*/
CREATE TABLE
    dbo.Comments
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    user_id integer NOT NULL,
    created datetime NOT NULL,
    score integer NOT NULL
);

INSERT
    dbo.Comments
WITH
    (TABLOCK)
(
    id,
    user_id,
    created,
    score
)
SELECT
    x.id,
    user_id = CONVERT(integer, x.id * 7919 % 500000 + 1),
    created = DATEADD(MINUTE, CONVERT(integer, x.id), CONVERT(datetime, '20220101', 112)),
    score = CONVERT(integer, x.id * 31 % 50)
FROM
(
    SELECT TOP (2000000)
        id = CONVERT(bigint, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;
```

```sql
/*Each high-reputation user's most recent comment*/
SELECT
    u.id,
    lc.created,
    lc.score
FROM dbo.Users AS u
CROSS APPLY
(
    SELECT TOP (1)
        c.created,
        c.score
    FROM dbo.Comments AS c
    WHERE c.user_id = u.id
    ORDER BY
        c.created DESC
) AS lc
WHERE u.reputation >= 9900;
```

On **SQL Server 2025**, the plan scanned `Users` for 5,050 high-reputation users. On the inner side of the Nested Loops, an Eager Index Spool read all two million comments once and built a temporary index on `user_id`. Every user then seeked the spool, and a Sort above it picked the latest comment.

It took 5 to 7.5 seconds across runs, with 6.2 seconds of `EXECSYNC` waits in the run with a plan captured. That was the parallel threads waiting on the one that built the spool.

The spool's properties showed a seek predicate on `user_id` and an output list of created and score, which is the index it wanted.

```sql
/*The index the spool wanted, with the sort column moved into the key*/
CREATE INDEX
    user_id_created
ON dbo.Comments
    (user_id, created DESC)
INCLUDE
    (score);
```

With it, the plan is a Top over an Index Seek for each user: 16,160 page reads and 30 to 47 ms. The spool and the Sort are both gone, because created is in the key.

Sometimes you get a spool when you already have the index. This query is adapted from [Index Spools When You Have An Index](https://erikdarling.com/index-spools-when-you-have-an-index/), on a table with wide rows:

```sql
/*Two million documents, each with a 400-character body*/
CREATE TABLE
    dbo.Documents
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    last_edit_date datetime NULL,
    body nvarchar(max) NOT NULL
);

INSERT
    dbo.Documents
WITH
    (TABLOCK)
(
    id,
    last_edit_date,
    body
)
SELECT
    x.id,
    last_edit_date =
        CASE
            WHEN x.id % 5 < 2
            THEN NULL
            ELSE DATEADD(MINUTE, CONVERT(integer, x.id), CONVERT(datetime, '20220101', 112))
        END,
    body = REPLICATE(N'x', 400)
FROM
(
    SELECT TOP (2000000)
        id = CONVERT(bigint, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

CREATE INDEX
    last_edit_date
ON dbo.Documents
    (last_edit_date);
```

```sql
/*The table joined to itself, twice*/
SELECT
    records = SUM(x.records)
FROM dbo.Documents AS d
CROSS APPLY
(
    SELECT
        COUNT(d2.id)
    FROM dbo.Documents AS d2
    WHERE d2.last_edit_date >= '20250101'
    AND   d2.id = d.id

    UNION ALL

    SELECT
        COUNT(d2.id)
    FROM dbo.Documents AS d2
    WHERE d2.last_edit_date IS NULL
    AND   d2.id = d.id
) AS x (records);
```

The plan had two Eager Index Spools, each built from a scan of the `last_edit_date` index, and took 11.7 to 12.2 seconds. The clustered primary key on id could have handled every lookup. What tipped it was width: on the same rows without the `body` column, the query seeked the clustered index and took about 4 seconds. Both spools had a seek predicate on id and `last_edit_date`, so here's that index:

```sql
/*The index both spools asked for*/
CREATE INDEX
    id_last_edit_date
ON dbo.Documents
    (id, last_edit_date);
```

It didn't help, unique or not. Both spools stayed, building the same index that now existed, in 10.3 to 11.2 seconds. [FORCESEEK](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table) on its own went back to the wide clustered index and took about 20 seconds, which fits Paul White's explanation in the post: the unique clustered index keeps index matching from finding the better nonclustered index. Naming the narrow index in the hint got rid of the spools, at 4.3 to 4.5 seconds:

```sql
/*Name the index, and the seek column*/
SELECT
    records = SUM(x.records)
FROM dbo.Documents AS d
CROSS APPLY
(
    SELECT
        COUNT(d2.id)
    FROM dbo.Documents AS d2 WITH (FORCESEEK (id_last_edit_date (id)))
    WHERE d2.last_edit_date >= '20250101'
    AND   d2.id = d.id

    UNION ALL

    SELECT
        COUNT(d2.id)
    FROM dbo.Documents AS d2 WITH (FORCESEEK (id_last_edit_date (id)))
    WHERE d2.last_edit_date IS NULL
    AND   d2.id = d.id
) AS x (records);
```

The better fix is not joining the table to itself at all, and this version took 41 to 42 ms:

```sql
/*No self-join: count each kind of row once*/
SELECT
    records = SUM(x.records)
FROM
(
    SELECT
        COUNT_BIG(*)
    FROM dbo.Documents AS d
    WHERE d.last_edit_date >= '20250101'

    UNION ALL

    SELECT
        COUNT_BIG(*)
    FROM dbo.Documents AS d
    WHERE d.last_edit_date IS NULL
) AS x (records);
```
