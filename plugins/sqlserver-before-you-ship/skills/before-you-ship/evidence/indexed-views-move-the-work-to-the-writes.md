# Indexed views move the work to the writes: evidence

The card: [Indexed views move the work to the writes](../cards/indexed-views-move-the-work-to-the-writes.md)

Using the posts from [Don't join on OR](../cards/don-t-join-on-or.md), the question that gets asked all day:

```sql
/*Post counts and total score per user, the slow way*/
SELECT TOP (10)
    p.owner_user_id,
    posts = COUNT_BIG(*),
    total_score = SUM(p.score)
FROM dbo.Posts AS p
GROUP BY
    p.owner_user_id
ORDER BY
    total_score DESC;

GO
```

On **SQL Server 2025**, that scanned `Posts`, 6,552 pages, in 160 to 230 ms. The view that answers it ahead of time:

```sql
/*Store the answer, and keep it current*/
CREATE VIEW
    dbo.UserPostTotals
WITH SCHEMABINDING
AS
SELECT
    p.owner_user_id,
    posts = COUNT_BIG(*), /*Required with GROUP BY*/
    total_score = SUM(p.score)
FROM dbo.Posts AS p
GROUP BY
    p.owner_user_id;
GO

CREATE UNIQUE CLUSTERED INDEX
    owner_user_id
ON dbo.UserPostTotals
    (owner_user_id);
```

Run the first query again, unchanged, and the plan reads `UserPostTotals` instead of `Posts`: 641 pages, 23 to 33 ms. That matching happens on **Enterprise** and **Enterprise Developer editions**. On **Standard** and **Standard Developer**, query `dbo.UserPostTotals` directly `WITH (NOEXPAND)`.

The price, on the write side:

```sql
/*Every write to Posts now updates the view too*/
INSERT
    dbo.Posts
(
    id,
    owner_user_id,
    last_editor_user_id,
    post_type_id,
    score
)
SELECT TOP (100000)
    id = p.id + 3000000,
    p.owner_user_id,
    p.last_editor_user_id,
    p.post_type_id,
    p.score
FROM dbo.Posts AS p
ORDER BY
    p.id;
```

1.3 to 2.6 seconds before the view existed, 3.9 to 4.8 seconds after, with about 400,000 extra page reads against the view. Two sessions, to see the locking. In the first:

```sql
/*Window 1: add a post, and keep the transaction open*/
BEGIN TRANSACTION;

INSERT
    dbo.Posts
(
    id,
    owner_user_id,
    last_editor_user_id,
    post_type_id,
    score
)
VALUES
    (3500001, 250001, NULL, 1, 0);
```

User 250001 has no posts yet, so this creates a new row in the view. In [sys.dm_tran_locks](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-tran-locks-transact-sql), the open transaction held a `RangeS-U` lock on the next key in the view's index and a `RangeX-X` lock on the new one. In the second:

```sql
/*Window 2: a post for a different new user*/
INSERT
    dbo.Posts
(
    id,
    owner_user_id,
    last_editor_user_id,
    post_type_id,
    score
)
VALUES
    (3500002, 250003, NULL, 1, 0);
```

```sql
/*Back in window 1, once window 2 is waiting*/
ROLLBACK TRANSACTION;

/*Put Posts back the way it was*/
DELETE
    p
FROM dbo.Posts AS p
WHERE p.id > 3000000;
```

A different user, and still it waited until the first window rolled back, 2.5 seconds after it started in the test, against 5 ms with no view. Both new rows belong in the same gap in the view's index, past the highest existing user, and the key-range lock covers the gap.

The wait was the same on **SQL Server 2022**, and with [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) (Read Committed Snapshot Isolation), Accelerated Database Recovery, and optimized locking on, in any combination. The same test with two users who already had posts took plain X locks on the view and didn't block.

The first post below shows the plain X locks a single-table view takes when existing view rows change. An insert that adds a row to the view is where the key-range locks come in.
