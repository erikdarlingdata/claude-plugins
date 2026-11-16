# Don't ask twice

Where it sits in the chart: A query > No NOLOCK > It changes data > "Do you need the rows you just changed?" (New identity values, archiving, before-and-after)

When code needs to know what a modification did, the usual move is a second query. That's `SELECT MAX(id)` afterward to find the row you just inserted, or a `SELECT` beforehand to save what a `DELETE` is about to remove. That second query is a race. Other sessions can change the table in between, and `SELECT MAX(id)` will happily hand you someone else's row.

[OUTPUT](https://learn.microsoft.com/en-us/sql/t-sql/queries/output-clause-transact-sql) returns the rows a modification touched as part of the modification itself. You get every generated identity value, every deleted row, the before and after of every update. [SCOPE_IDENTITY](https://learn.microsoft.com/en-us/sql/t-sql/functions/scope-identity-transact-sql)() is fine for one row, and it only ever gives you one value.

## What it costs

Next to nothing for a handful of rows. On big modifications, the destination matters: `OUTPUT` to the client, or into a table variable, forces the whole statement to run serially. `OUTPUT INTO` a `#temp` table leaves parallelism available.

## What it risks

`OUTPUT INTO` comes with rules for its target, `#temp` tables included. It can't have enabled triggers or `CHECK` constraints, and it can't be on either side of a foreign key. And the rows come back in no guaranteed order, so don't match them to your input by position. To tie new identity values back to source rows, use the [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql) trick on [What MERGE does better](what-merge-does-better.md).

## How fast it works

Immediately: one statement instead of two, and no gap for another session to slip into.

## When it backfires

Someone adds a trigger later. Every plain `OUTPUT` statement for that trigger's action starts failing with Msg 334, in code nobody changed. That's how EF Core 7 broke saves on tables with triggers: `SaveChanges` uses `OUTPUT`, and developers had to configure those tables with `HasTrigger`. `OUTPUT INTO` a `#temp` table keeps working. And on its own, `OUTPUT` is a poor audit trail: it only records changes made by the statements you remembered to add it to.

## Evidence

Demo code and measurements: [evidence/don-t-ask-twice.md](../evidence/don-t-ask-twice.md). Open it to quote a number or run the demo.

## Reading

- [Miscellaneous notes for SQL Server: SaveChanges and the OUTPUT clause](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/misc) (Microsoft Learn, EF Core)
