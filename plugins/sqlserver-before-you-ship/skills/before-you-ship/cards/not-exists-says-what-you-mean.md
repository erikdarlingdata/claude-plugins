# NOT EXISTS says what you mean

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Looking for rows with no match?" (LEFT JOIN ... IS NULL, NOT IN, NOT EXISTS)

To find users with no posts, a lot of code `LEFT JOIN`s to posts and keeps the rows where the post came back `NULL`. Below compatibility level 170 (**SQL Server 2025**'s level, set per database), that joins every user to every one of their posts, then throws the matches away.

[NOT EXISTS](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/exists-transact-sql) asks the question directly. [NOT IN](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/in-transact-sql) looks like the same question until the list it checks contains a `NULL`, and then it returns no rows at all.

The opposite question works the same way. `EXISTS` returns each user once, where a `JOIN` returns a row per matching post and needs a `DISTINCT` to undo it.

## What it costs

Nothing. `NOT EXISTS` is about as long as the `LEFT JOIN`, and it returns the same rows, as long as the column the `LEFT JOIN` tests with `IS NULL` can't be `NULL` on its own, the way `p.id` can't here.

## What it risks

A different answer, when the code being replaced is `NOT IN` on a column that allows `NULL`s. Asking which users never last-edited a post with `NOT IN` returned 0. That's because half the posts have no editor, and one `NULL` in the list makes `NOT IN` unknown for every row. `NOT EXISTS` returned the 310,000 users who never edited anything, and so did `NOT IN` once the subquery filtered out the `NULL`s.

## How fast it works

It depends on the version. Below compatibility level 170, **SQL Server 2022** included, the `LEFT JOIN` built 2.3 million joined rows and filtered them down to 300,000 afterward. It took longer than `NOT EXISTS` in every run: 140 to 400 ms against 75 to 260 ms. At compatibility level 170, **SQL Server 2025** rewrites that `LEFT JOIN` into the same anti semi join (a join that keeps only the rows with no match) that `NOT EXISTS` gets, and the two ran the same.

## When it backfires

A subquery that matches on a column with no index. `NOT EXISTS` only needs one matching row, so SQL Server can plan a Top over a scan of the inner table and bet that each scan finds a match early. When matches are missing, each scan reads the whole table.

In a test with 210 stores, 4 million sales, and no index on `store_id`, `NOT EXISTS` read 228,700 pages in 2 to 2.3 seconds. At compatibility level 160, the `LEFT JOIN` version hashed both tables once instead, 22,968 pages in 177 to 233 ms. At 170, **SQL Server 2025** rewrote the `LEFT JOIN` into the same plan as `NOT EXISTS`. [A Top above a scan means a missing index](a-top-above-a-scan-means-a-missing-index.md) has the fix.

## Deeper dive

Using the tables from [Don't join on OR](don-t-join-on-or.md), users with no posts, both ways:

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

## Reading

- [Why Not Exists Makes More Sense Than Left Joins For Performance](https://erikdarling.com/why-not-exists-makes-more-sense-than-left-joins/)
- [Software Vendor Mistakes With SQL Server: Using Left Joins To Find Rows That Don't Exist](https://erikdarling.com/software-vendor-mistakes-with-sql-server-using-left-joins-to-find-rows-that-dont-exist/)
- [How To Write SQL Server Queries Correctly: IN and NOT IN](https://erikdarling.com/how-to-write-sql-server-queries-correctly-in-and-not-in/)
