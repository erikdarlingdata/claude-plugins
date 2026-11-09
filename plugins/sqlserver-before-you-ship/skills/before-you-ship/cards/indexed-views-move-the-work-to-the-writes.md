# Indexed views move the work to the writes

Where it sits in the chart: An index > A new index > "Pre-computing an aggregate?" (Indexed views: totals and counts kept current on every write)

An indexed view stores the result of a query, usually an aggregate or a join. SQL Server keeps it current as the tables underneath change.

Reading the answer gets cheap: totals for every user came from 641 pages of view instead of 6,552 pages of posts. Every write pays for it, because inserting, updating, or deleting a post now updates the view in the same statement. They're worth it for answers that get read far more often than the rows under them change.

On **Enterprise** and **Enterprise Developer editions**, the optimizer (which picks the plan) can use the view for queries that never mention it. On **Standard** and **Standard Developer**, a query has to name the view and use `WITH` ([NOEXPAND](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table)).

## What it costs

Slower writes, and a list of rules. Inserting 100,000 posts took 1.3 to 2.6 seconds without the view and 3.9 to 4.8 seconds with it. The view needs [SCHEMABINDING](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-view-transact-sql), two-part names (schema.table), [COUNT_BIG](https://learn.microsoft.com/en-us/sql/t-sql/functions/count-big-transact-sql)`(*)` when it groups, and the same `SET` options (connection settings) as [filtered indexes](filtered-indexes-need-to-see-the-filter.md). It can't use outer joins, `DISTINCT`, `MIN`, `MAX`, or `AVG`. `SUM` over a column that allows `NULL`s fails too, when you create the index, until you wrap it in [ISNULL](https://learn.microsoft.com/en-us/sql/t-sql/functions/isnull-transact-sql).

## What it risks

Writers blocking writers on different rows. When an insert creates a new row in the view, like a user's first post, the view's index takes key-range locks (locks that also cover gaps between keys). In a test, an open transaction adding one new user's first post made another new user's first post wait until the first rolled back, against 5 ms without the view.

Only inserts into the same gap in the view's key block each other. But with ascending user ids, every new user lands in the same gap, after the last one. Posts for users already in the view took ordinary row locks and didn't block.

## How fast it works

Immediate for reads. The top-10 query went from 160 to 230 ms reading `Posts` to 23 to 33 ms reading the view, without changing the query. Building the view took under 2 seconds here. The course's rule of thumb is that a view that's slow to build will be slow to maintain.

## When it backfires

A view with nothing to help its maintenance. Every write has to find the view rows it changes, and for a view that joins tables, the matching rows in the other tables. In the course's `StackOverflow2013` demo, a 100-row update took 8 seconds before the supporting indexes went in, and under 15 ms after. Views that join tables also run their maintenance at serializable (the strictest isolation level), which the first post below digs into.

## Deeper dive

Using the posts from [Don't join on OR](don-t-join-on-or.md), the question that gets asked all day:

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

## Reading

- [Learn T-SQL With Erik: Indexed View Serializable Locking](https://erikdarling.com/learn-t-sql-with-erik-indexed-view-serializable-locking/)
- [Indexed View Maintenance Is Only As Bad As Your Indexes In SQL Server](https://erikdarling.com/indexed-view-maintenance-is-only-as-bad-as-your-indexes/)
- [Learn T-SQL With Erik: Indexed View Matching](https://erikdarling.com/learn-t-sql-with-erik-indexed-view-matching/)
