# Triggers fire per statement, not per row

Where it sits in the chart: A query > No NOLOCK > It changes data > "Is there a trigger on the table?" (Writing one, or modifying a table that has one)

Triggers get more hate than almost anything in SQL Server, and a lot of it is developers blaming the hammer for being blunt. A DML trigger (a trigger on `INSERT`, `UPDATE`, or `DELETE`) fires once per statement, not once per row. It runs inside the transaction that fired it, so its work and its locks are part of your modification.

Write every trigger as if `Inserted` and `Deleted` (the trigger's tables of new and old rows) hold a million rows, because one day they will. One trigger per action is shorter and harder to get wrong than one trigger juggling inserts, updates, and deletes.

## What it costs

Every statement against the table now does the trigger's work too, inside the same transaction, and holds locks for longer. Join to `Inserted` and `Deleted` in one set-based statement (all rows at once).

## What it risks

`SELECT @id = i.id FROM Inserted` grabs one row and silently ignores the rest. It passes every single-row test you'll ever write, so test triggers with multi-row modifications. And `IF` [UPDATE(column)](https://learn.microsoft.com/en-us/sql/t-sql/functions/update-trigger-functions-transact-sql) only means the column was in the `SET` list, so compare `Inserted` to `Deleted` to find the rows that actually changed.

## How fast it works

Set-based trigger code costs about one extra statement per modification. A cursor (a row-by-row loop) in a trigger scales with the row count, and the difference shows up the first time someone updates the whole table.

## When it backfires

Trusting the row-count early exit (`IF` [ROWCOUNT_BIG](https://learn.microsoft.com/en-us/sql/t-sql/functions/rowcount-big-transact-sql)() = 0 `RETURN`) under [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql). A `MERGE` fires your trigger for each action it handles that has a `WHEN` clause in the statement, even when that clause touched no rows, and `ROWCOUNT_BIG()` reports the whole `MERGE`'s count. Check whether `Inserted` or `Deleted` have rows instead of trusting the count.

## Evidence

Demo code and measurements: [evidence/triggers-fire-per-statement-not-per-row.md](../evidence/triggers-fire-per-statement-not-per-row.md). Open it to quote a number or run the demo.

## Reading

- [Learn T-SQL With Erik: Bad Trigger Habits](https://erikdarling.com/learn-t-sql-with-erik-bad-trigger-habits/)
- [Undocumented Query Plans: Equality Comparisons](https://www.sql.kiwi/2011/06/undocumented-query-plans-equality-comparisons/) (Paul White)
