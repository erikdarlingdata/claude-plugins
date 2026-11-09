# Don't join on OR

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Joining on one column OR another?" (ON u.id = p.owner_user_id OR u.id = p.last_editor_user_id)

A join that matches on one column or another reads naturally, and SQL Server runs it badly. It can't seek on two columns at once. So for every row on one side, it builds a short list of the values that can match and sorts the list. Then it looks each value up separately, one row at a time.

Split the join into two queries, one per column, glued together with [UNION ALL](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/set-operators-union-transact-sql). Each half then gets a plan SQL Server knows how to run well. SQL Server doesn't make that rewrite for you, **2025** included.

## What it costs

A longer query. The `OR` turns into two `SELECT`s inside a [CROSS APPLY](https://learn.microsoft.com/en-us/sql/t-sql/queries/from-transact-sql), and you repeat every filter in both halves. If the query counts or sums anything, the second half also has to rule out the rows the first half already matched.

## What it risks

Duplicates. A post whose owner also last edited it matches the `OR` once and the `UNION ALL` twice. That's harmless under `MAX`, but a `COUNT` or `SUM` comes out too high. For users 1 to 1,000, the `OR` counted 11,200 posts and a plain `UNION ALL` 13,200. Ruling out the overlap in the second half, with `AND p.owner_user_id <> u.id`, brought it back to 11,200.

## How fast it works

Immediate. With 500,000 users and two million posts, the `OR` join took 11 to 15 seconds. The `UNION ALL` rewrite took under a second, and a version that reads the posts once took 0.3 to 0.6 seconds.

## When it backfires

Ruling out the overlap with a column that allows `NULL`s. Putting `AND p.last_editor_user_id <> u.id` in the owner half instead dropped every post that was never edited, and the count fell to 6,200, because a comparison with `NULL` is never true. Put the check on a `NOT NULL` column, or add `OR ... IS NULL` to it.

## Deeper dive

Users, and posts with an owner and a last editor. Half the posts were never edited, and some were last edited by their owner:

```sql
/*500,000 users*/
CREATE TABLE
    dbo.Users
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    reputation integer NOT NULL,
    display_name nvarchar(40) NOT NULL
);

INSERT
    dbo.Users
WITH
    (TABLOCK)
(
    id,
    reputation,
    display_name
)
SELECT
    x.id,
    reputation = x.id * 7 % 10000 + 1,
    display_name = CONCAT(N'user ', x.id)
FROM
(
    SELECT TOP (500000)
        id = CONVERT(integer, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

/*Two million posts, owned by the first 200,000 users*/
CREATE TABLE
    dbo.Posts
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    owner_user_id integer NOT NULL,
    last_editor_user_id integer NULL,
    post_type_id integer NOT NULL,
    score integer NOT NULL
);

INSERT
    dbo.Posts
WITH
    (TABLOCK)
(
    id,
    owner_user_id,
    last_editor_user_id,
    post_type_id,
    score
)
SELECT
    x.id,
    owner_user_id = x.owner_user_id,
    last_editor_user_id =
        CASE
            WHEN x.id % 10 < 5
            THEN NULL /*Half the posts were never edited*/
            WHEN x.id % 10 < 7
            THEN x.owner_user_id /*Some were edited by their owner*/
            ELSE CONVERT(integer, x.id * 7919 % 500000 + 1)
        END,
    post_type_id =
        CASE
            WHEN x.id % 20 = 0
            THEN 3
            WHEN x.id % 20 < 9
            THEN 1
            ELSE 2
        END,
    score =
        CASE
            WHEN x.id % 5000 = 7
            THEN 5000 + x.id % 997 /*A few big ones*/
            ELSE CONVERT(integer, x.id * 31 % 200)
        END
FROM
(
    SELECT
        g.id,
        owner_user_id = CONVERT(integer, g.id * 104729 % 200000 + 1)
    FROM
    (
        SELECT TOP (2000000)
            id = CONVERT(bigint, ROW_NUMBER() OVER (ORDER BY 1/0))
        FROM sys.all_columns AS ac1
        CROSS JOIN sys.all_columns AS ac2
    ) AS g
) AS x;
```

An index leading with each of the two columns:

```sql
CREATE INDEX
    owner_user_id_last_editor_user_id_post_type_id
ON dbo.Posts
    (owner_user_id, last_editor_user_id, post_type_id)
INCLUDE
    (score);

CREATE INDEX
    last_editor_user_id_owner_user_id_post_type_id
ON dbo.Posts
    (last_editor_user_id, owner_user_id, post_type_id)
INCLUDE
    (score);
```

The highest score each user has, as owner or last editor:

```sql
/*OR in the join*/
SELECT
    u.id,
    max_score = MAX(p.score)
FROM dbo.Users AS u
JOIN dbo.Posts AS p
  ON u.id = p.owner_user_id
  OR u.id = p.last_editor_user_id
WHERE p.post_type_id IN (1, 2)
GROUP BY
    u.id
HAVING
    MAX(p.score) >= 5000
ORDER BY
    max_score DESC;
```

On **SQL Server 2025**, the plan read 1.9 million posts. For each one, it ran two Constant Scans, one per column, into a Concatenation, a Top N Sort, and a Merge Interval, then seeked into `Users`. That came to 1.9 million rounds, 2.5 million seeks, and 11 to 15 seconds. That Constant Scan, Merge Interval, Nested Loops shape is the one to look for, and it shows up in estimated plans too.

Narrowing the join to users 1 to 1,000 made it slower. The plan spooled all two million posts and replayed them for every user, and took almost seven minutes to count 11,200 posts.

One `SELECT` per column instead, inside `CROSS APPLY`:

```sql
/*One seek per column, glued back together*/
SELECT
    u.id,
    max_score = MAX(p.score)
FROM dbo.Users AS u
CROSS APPLY
(
    SELECT
        p.score
    FROM dbo.Posts AS p
    WHERE p.owner_user_id = u.id
    AND   p.post_type_id IN (1, 2)

    UNION ALL

    SELECT
        p.score
    FROM dbo.Posts AS p
    WHERE p.last_editor_user_id = u.id
    AND   p.post_type_id IN (1, 2)
) AS p
GROUP BY
    u.id
HAVING
    MAX(p.score) >= 5000
ORDER BY
    max_score DESC;
```

Same 140 rows, checked both ways with [EXCEPT](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/set-operators-except-and-intersect-transact-sql), in under a second, and no Merge Interval anywhere in the plan.

The course's other shape is meant for when there's no index for each column. It turns each post into one row per user column:

```sql
/*No helpful indexes: one pass over Posts, both columns unpivoted*/
SELECT
    u.id,
    p.max_score
FROM dbo.Users AS u
JOIN
(
    SELECT
        pu.user_id,
        max_score = MAX(p.score)
    FROM dbo.Posts AS p
    CROSS APPLY
    (
        VALUES
            (p.owner_user_id),
            (p.last_editor_user_id)
    ) AS pu (user_id)
    WHERE p.post_type_id IN (1, 2)
    GROUP BY
        pu.user_id
    HAVING
        MAX(p.score) >= 5000
) AS p
  ON p.user_id = u.id
ORDER BY
    p.max_score DESC;
```

It reads the table once and doesn't need either index: same 140 rows, in 0.3 to 0.6 seconds. It beat the `CROSS APPLY` version here even with the indexes in place, because this query wants every user anyway.

Narrowed to users 1 to 1,000, the `APPLY` version took about 10 ms and `VALUES` 0.7 to 1 second. `VALUES` still read every post. For one user, the `APPLY` version took 0 ms against about 0.2 seconds for `VALUES`.

It double counts the same way `UNION ALL` does. Wrapping the second column in [NULLIF](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/nullif-transact-sql)`(p.last_editor_user_id, p.owner_user_id)` brought the count for users 1 to 1,000 back from 13,200 to 11,200.

When the query counts or sums, the second half has to skip what the first half already found:

```sql
/*When duplicates matter: count each user's posts*/
SELECT
    u.id,
    posts = COUNT_BIG(*)
FROM dbo.Users AS u
CROSS APPLY
(
    SELECT
        p.id
    FROM dbo.Posts AS p
    WHERE p.owner_user_id = u.id

    UNION ALL

    SELECT
        p.id
    FROM dbo.Posts AS p
    WHERE p.last_editor_user_id = u.id
    AND   p.owner_user_id <> u.id /*Already counted in the first half*/
) AS p
WHERE u.id <= 1000
GROUP BY
    u.id;
```

For users 1 to 1,000, this counted 11,200 posts, the same as the `OR` join. Without the `p.owner_user_id <> u.id` line it counted 13,200. That's because 2,000 of those posts were last edited by their own owner and got counted in both halves.

## Reading

- [Software Vendor Mistakes With SQL Server: Joining On OR Conditions](https://erikdarling.com/software-vendor-mistakes-with-sql-server-joining-on-or-conditions/)
- [How To Write SQL Server Queries Correctly: Joins With OR Clauses Part 2](https://erikdarling.com/how-to-write-sql-server-queries-correctly-joins-with-or-clauses-part-2/)
