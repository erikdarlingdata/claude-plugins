# Disable, then drop

Where it sits in the chart: An index > Existing indexes > "How do I drop one safely?" (Disable first, wait and see)

Disabling an index keeps its definition in metadata while dropping its data and stopping its write cost. If something screams, one [REBUILD](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-index-transact-sql) brings the index back as it was, no archaeology required, and you can leave them disabled, since there's no meter running.

## What it costs

A disabled index costs nothing to keep and one rebuild to resurrect. The rebuild on a big table isn't instant, but it beats reconstructing a definition from memory at 2am.

## What it risks

Disabling the clustered index (the table itself) makes the whole table inaccessible. A disabled unique index stops enforcing uniqueness, so duplicates can land while it's off, and then the `REBUILD` fails. If other tables' foreign keys reference it, SQL Server disables them too, and the rebuild doesn't turn them back on. Queries that hint the index by name fail with Msg 315 while it's disabled.

Before you disable it, search code and plan guides (hints stored outside the code) for the name. This pattern is for plain, non-unique nonclustered indexes.

## How fast it works

The write savings start the moment you disable. You get the benefit of the drop and keep the undo button.

## When it backfires

Dumb index maintenance. A blanket rebuild-everything job will happily rebuild your disabled indexes, which re-enables them, and now the index you retired is back on the payroll. If maintenance runs unattended, either exclude disabled indexes from it or drop for real.

## Evidence

Demo code and measurements: [evidence/disable-then-drop.md](../evidence/disable-then-drop.md). Open it to quote a number or run the demo.

## Reading

- [The Quiet Death of Foreign Keys](https://erikdarling.com/the-quiet-death-of-foreign-keys/)
