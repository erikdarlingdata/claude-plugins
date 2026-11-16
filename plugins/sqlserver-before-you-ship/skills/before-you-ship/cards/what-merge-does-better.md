# What MERGE does better

Where it sits in the chart: A query > No NOLOCK > It changes data > MERGE > "Why MERGE at all?" (Two things it does that other statements don't)

Michael J. Swart's verdict, on [the avoid list card](swart-s-avoid-list.md), is to avoid [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql). My take is a bit less severe: avoid `MERGE` unless you're willing to write it correctly and test it thoroughly. Because it does two things normal modification queries don't:

- If a target row matches more than one source row, `MERGE` throws an error instead of quietly picking one. An `UPDATE` with a join finishes anyway, and it can even stitch together values from different source rows.
- Its [OUTPUT](https://learn.microsoft.com/en-us/sql/t-sql/queries/output-clause-transact-sql) clause can return source columns alongside the inserted ones, which a plain `INSERT` won't let you do.

## What it costs

Writing it correctly: the right hints for concurrency, a source that's unique on the join key, and an `ON` clause that matches only what you mean to match.

## What it risks

Everything on the avoid list still applies. The upsides don't cancel the bugs. They're reasons to take the risk on knowingly.

## How fast it works

Immediately. Duplicate source rows fail the statement with error 8672 the first time they show up, but the equivalent `UPDATE` finishes, and is wrong.

## When it backfires

A `USING` source that isn't unique on the join key. It passes every test where the source happens to be clean, then throws error 8672 in production the first time two source rows match one target row, and the statement rolls back. Make the source unique with `ROW_NUMBER` the way the evidence file does, and watch the `ORDER BY`: if it can tie, the winner is arbitrary and can change from run to run.

## Evidence

Demo code and measurements: [evidence/what-merge-does-better.md](../evidence/what-merge-does-better.md). Open it to quote a number or run the demo.

## Reading

- [In Defense Of Merge: Non-Deterministic Updates](https://erikdarling.com/in-defense-of-merge-non-deterministic-updates/)
- [Learn T-SQL With Erik: A Neat Thing with MERGE and OUTPUT](https://erikdarling.com/learn-t-sql-with-erik-a-neat-thing-with-merge-and-output/)
