# Indexed views move the work to the writes

**Requires:** the optimizer only uses the view for queries that don't name it on **Enterprise** and **Enterprise Developer**. On **Standard** and **Standard Developer**, queries have to name the view and use `WITH (NOEXPAND)`.

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

## Evidence

Demo code and measurements: [evidence/indexed-views-move-the-work-to-the-writes.md](../evidence/indexed-views-move-the-work-to-the-writes.md). Open it to quote a number or run the demo.

## Reading

- [Learn T-SQL With Erik: Indexed View Serializable Locking](https://erikdarling.com/learn-t-sql-with-erik-indexed-view-serializable-locking/)
- [Indexed View Maintenance Is Only As Bad As Your Indexes In SQL Server](https://erikdarling.com/indexed-view-maintenance-is-only-as-bad-as-your-indexes/)
- [Learn T-SQL With Erik: Indexed View Matching](https://erikdarling.com/learn-t-sql-with-erik-indexed-view-matching/)
