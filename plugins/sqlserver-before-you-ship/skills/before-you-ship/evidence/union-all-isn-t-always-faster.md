# UNION ALL isn't always faster: evidence

The card: [UNION ALL isn't always faster](../cards/union-all-isn-t-always-faster.md)

Using the posts from [Don't join on OR](../cards/don-t-join-on-or.md) and the votes from [Local variables hide their values](../cards/local-variables-hide-their-values.md). First, two halves that can't share a row:

```sql
/*Two sets that can't overlap: a post has one type*/
SELECT
    posts = COUNT_BIG(*)
FROM
(
    SELECT
        p.id
    FROM dbo.Posts AS p
    WHERE p.post_type_id = 1

    UNION /*Swap in UNION ALL*/

    SELECT
        p.id
    FROM dbo.Posts AS p
    WHERE p.post_type_id = 2
) AS x;
```

On **SQL Server 2025**, `UNION` merged the two clustered index scans to remove duplicates that couldn't exist, serially, in 380 to 490 ms. `UNION ALL` let the optimizer count each half on its own and add the counts, in parallel, in 120 to 190 ms, and came up with the same 1.9 million.

Then two halves that overlap: post owners and last editors, 3 million ids for 290,000 distinct users:

```sql
/*Two sets that overlap a lot, feeding a join: everyone who owns or last edited a post, and their latest vote*/
SELECT
    users = COUNT_BIG(*),
    latest_vote = MAX(lv.last_vote)
FROM
(
    SELECT
        x.user_id,
        last_vote = MAX(v.created)
    FROM
    (
        SELECT
            user_id = p.owner_user_id
        FROM dbo.Posts AS p

        UNION /*Swap in UNION ALL*/

        SELECT
            user_id = p.last_editor_user_id
        FROM dbo.Posts AS p
        WHERE p.last_editor_user_id IS NOT NULL
    ) AS x
    JOIN dbo.Votes AS v
      ON v.user_id = x.user_id
    GROUP BY
        x.user_id
) AS lv;
```

`UNION` hashed the 3 million ids down to 290,000 before the join, and took 350 to 680 ms with a 142 MB memory grant. `UNION ALL` joined all 3 million and produced 15.6 million rows on the way to the same answer: the 190,000 of those users who have votes. It took 710 to 880 ms with a 328 MB grant. In the course's version on `StackOverflow2013`, the same choice was 3 seconds against 33.
