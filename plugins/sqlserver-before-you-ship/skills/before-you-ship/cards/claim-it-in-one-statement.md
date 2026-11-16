# Claim it in one statement

Where it sits in the chart: A query > No NOLOCK > It changes data > "Is the table a queue?" (Workers pulling the next job off a table)

Queues in a database kind of suck, but with some care they work fine. The hard part is the claim: many workers asking for the next unclaimed row at the same moment.

Written as a `SELECT` to find the row and an `UPDATE` to mark it, two workers find the same row and both process it. Written as one statement without the right hints, every worker lines up behind whichever one is busy.

Claim the row with one `UPDATE` through a [TOP](https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql) (1) that uses [READPAST](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table) (which skips locked rows), `ROWLOCK` and `UPDLOCK`. Index the table so the next row is a seek to the front of the line.

## What it costs

An index built for the claim, not for selectivity (how few rows a value matches). Lead with the column that marks a row as available, then the order you hand out work. In the course's queue that's a clustered key on (`in_process`, id). The key puts `in_process` first, even though it only has two values, because that's what lets every claim seek straight to the next row. [Key order decides the seek](key-order-decides-the-seek.md) has more on why selectivity isn't the rule.

## What it risks

Two traps. `READPAST` only works under the read committed and repeatable read isolation levels. Under `SERIALIZABLE` or `SNAPSHOT`, the claim fails with Msg 650, and serializable is what .NET's `TransactionScope` uses unless you tell it otherwise. Put `SET TRANSACTION ISOLATION LEVEL READ COMMITTED` inside the procedure that claims.

And a job can get queued twice. A unique index on whatever identifies the job stops that, and the course's queue uses [IGNORE_DUP_KEY](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) so SQL Server drops duplicates quietly. If finished rows stay in the table, SQL Server quietly drops a real re-run of the same job too. So either delete rows when they finish, or make the unique key cover something that changes per run, like a scheduled date.

## How fast it works

Immediately. Workers stop waiting on each other as soon as the claim skips rows that are already taken.

## When it backfires

Marking rows as claimed with nothing to release them. A worker that dies mid-job leaves its row claimed forever. Record when and where each row was claimed. Let any worker pick up a row that sits in process too long, with a cap on attempts.

## Evidence

Demo code and measurements: [evidence/claim-it-in-one-statement.md](../evidence/claim-it-in-one-statement.md). Open it to quote a number or run the demo.

## Reading

- [Building Reusable Queues In SQL Server Part 1](https://erikdarling.com/building-reusable-queues-part-1/)
- [Building Reusable Queues In SQL Server Part 2](https://erikdarling.com/building-reusable-queues-part-2/)
- [Using tables as Queues](https://rusanu.com/2010/03/26/using-tables-as-queues/) (Remus Rusanu)
