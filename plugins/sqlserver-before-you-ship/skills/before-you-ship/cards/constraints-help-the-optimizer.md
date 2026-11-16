# Constraints help the optimizer

Where it sits in the chart: A table > A new table > "NULLs, defaults, constraints?" (They help performance, too)

`NOT NULL`, `CHECK` constraints, and uniqueness look like correctness features. They're also information the optimizer (the part of SQL Server that picks the execution plan) gets to reason with. Declare what you know about your data and SQL Server can make better decisions and skip work. Leave everything nullable and unconstrained and it has to plan for values that may never exist.

Notice foreign keys aren't on this card. They're good for your data, but they do very little for the optimizer, and they cost you on the parent side. Every delete or key change on a parent row has to check the child table, so index the child's foreign key columns.

## What it costs

Constraints cost validation on writes, and uniqueness costs an index. That's the honest bill for data that stays trustworthy and plans that get to assume things.

## What it risks

A constraint created or re-enabled `WITH` [NOCHECK](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql) is untrusted, and untrusted constraints help the optimizer not at all. You paid for the constraint and forfeited the benefit.

## How fast it works

Immediate for new tables. Trusting existing data takes a validation scan when you enable checking.

## When it backfires

`CHECK` or `DEFAULT` constraints that call scalar functions. The function runs once per row on every modification, even when it qualifies for inlining (folding the function into the query). It also keeps those modifications out of parallel plans entirely, so the constraint you added for safety becomes the slowest part of every write.

## Evidence

Demo code and measurements: [evidence/constraints-help-the-optimizer.md](../evidence/constraints-help-the-optimizer.md). Open it to quote a number or run the demo.

## Reading

- [Check Constraints And Query Performance In SQL Server](https://erikdarling.com/check-constraints-and-query-performance-in-sql-server/)
- [A Little About Default Constraint UDFs in SQL Server](https://erikdarling.com/a-little-about-default-constraint-udfs-in-sql-server/)
