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

## Evidence

Demo code and measurements: [evidence/don-t-join-on-or.md](../evidence/don-t-join-on-or.md). Open it to quote a number or run the demo.

## Reading

- [Software Vendor Mistakes With SQL Server: Joining On OR Conditions](https://erikdarling.com/software-vendor-mistakes-with-sql-server-joining-on-or-conditions/)
- [How To Write SQL Server Queries Correctly: Joins With OR Clauses Part 2](https://erikdarling.com/how-to-write-sql-server-queries-correctly-joins-with-or-clauses-part-2/)
