# Mind your query consumers

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "Who else depends on this?" (API calls, dashboards, INSERT/EXEC)

Performance tuning done right improves a query without changing its logic: same rows out, less work getting them. Queries do have to change sometimes, to fix bugs, take in new data, or shed vestigial data, but that's not performance work. The moment logic changes, consumers matter. API calls, inserts, `INSERT/EXEC` targets, dashboards: a lot of them will never show up in a SQL Server dependency report.

## What it costs

Time with the codebase. Dependency DMVs (system views that track which objects reference which) only see what lives in the database. Application-side callers and readers need a thorough examination of the code, and that's the part everyone skips.

## What it risks

Missing a caller. `INSERT ... EXEC` is the classic: change a procedure's output columns and every `INSERT ... EXEC` consuming it breaks. Callers in other procedures show up as references, but nothing records that they depend on the column list. Dynamic SQL and application callers don't show up at all.

## How fast it works

Slow on purpose: auditing callers can take days in a big codebase. Changes that keep the result contract identical, like rewrites, index changes, and hints, skip the consumer audit. They still need a regression check on the other queries that hit those tables.

## When it backfires

This space reserved for your excuses.

## Deeper dive

Two demos elsewhere in the chart show the added-column problem in action. In [Widen before you add](widen-before-you-add.md), a query asks for one column its index doesn't have. The plan picks up 2,000 key lookups: about 6,100 reads, where the widened index needs 12. Whether SQL Server keeps doing lookups or gives up and scans the table depends on how many rows the parameter brings back.

[Dev lied to you](dev-lied-to-you.md) shows what happens when a plan like that gets cached and reused for values it wasn't built for.
