# NOT EXISTS says what you mean: evidence

The card: [NOT EXISTS says what you mean](../cards/not-exists-says-what-you-mean.md)

Using the tables from [Don't join on OR](../cards/don-t-join-on-or.md), users with no posts, both ways:

```sql
/*Users with no posts, the LEFT JOIN way*/
SELECT
    records = COUNT_BIG(u.id)
FROM dbo.Users AS u
LEFT JOIN dbo.Posts AS p
  ON p.owner_user_id = u.id
WHERE p.id IS NULL;


/*Users with no posts, the NOT EXISTS way*/
SELECT
    records = COUNT_BIG(u.id)
FROM dbo.Users AS u
WHERE NOT EXISTS
(
    SELECT
        1/0
    FROM dbo.Posts AS p
    WHERE p.owner_user_id = u.id
);
```

At compatibility level 170 on **SQL Server 2025**, both got the same plan: a Merge Join doing a Left Anti Semi Join. That plan returned 300,000 rows in 65 to 230 ms across runs. At compatibility level 160 on the same server, or on **SQL Server 2022**, the `LEFT JOIN` version became a Left Outer Join. It produced 2.3 million rows, and then a Filter kept the 300,000 users with no post.

`NOT IN`, against a column that allows `NULL`s:

```sql
/*Users who never last-edited anything, the NOT IN way*/
SELECT
    records = COUNT_BIG(u.id)
FROM dbo.Users AS u
WHERE u.id NOT IN
(
    SELECT
        p.last_editor_user_id
    FROM dbo.Posts AS p
);

/*The same question with NOT EXISTS*/
SELECT
    records = COUNT_BIG(u.id)
FROM dbo.Users AS u
WHERE NOT EXISTS
(
    SELECT
        1/0
    FROM dbo.Posts AS p
    WHERE p.last_editor_user_id = u.id
);
```

`NOT IN` returned 0. Its plan adds a Nested Loops with a Row Count Spool. The spool looks for a `NULL` in the list, finds one, and rules out every user. `NOT EXISTS` returned 310,000. Adding `WHERE p.last_editor_user_id IS NOT NULL` to the `NOT IN` subquery returns 310,000 too.

And the opposite question, users with at least one post:

```sql
/*Users with at least one post, the JOIN way*/
SELECT
    u.id,
    u.display_name
FROM dbo.Users AS u
JOIN dbo.Posts AS p
  ON p.owner_user_id = u.id
WHERE u.reputation >= 9990;

/*The JOIN way, with DISTINCT to undo the duplicates*/
SELECT DISTINCT
    u.id,
    u.display_name
FROM dbo.Users AS u
JOIN dbo.Posts AS p
  ON p.owner_user_id = u.id
WHERE u.reputation >= 9990;

/*The EXISTS way*/
SELECT
    u.id,
    u.display_name
FROM dbo.Users AS u
WHERE u.reputation >= 9990
AND EXISTS
(
    SELECT
        1/0
    FROM dbo.Posts AS p
    WHERE p.owner_user_id = u.id
);
```

The `JOIN` returned 2,200 rows for 220 users, one per post. `DISTINCT` got it back to 220 after building all 2,200 first, and `EXISTS` returned the 220 directly.

Qualify every column inside the subquery, too. Written as `WHERE p.owner_user_id = id`, the unqualified id binds to the nearest table that has one, which is `Posts`, so the subquery stops checking the user at all. In a test, that plan scanned `Posts` once per user, and it was still running when it was cancelled after nine minutes.
