# Soft deletes are a filter on every query

Where it sits in the chart: A table > A new table > "Will rows be deleted, or just marked?" (is_deleted flags, and the filter every query needs)

A soft delete marks a row as deleted instead of removing it, usually with an `is_deleted` `bit`. From then on, every query that wants live rows has to say `is_deleted` = 0, including queries written by people who've never heard of the column. Don't count on them remembering: put a view on top with the filter written in, and another for the deleted rows if anyone needs them.

Make the flag `bit` `NOT NULL`, because a nullable `bit` has three states. And decide up front what happens to deleted rows, because until something moves them out, they sit in every index the table has.

## What it costs

A view, filtered indexes for the active rows when they're the minority, and a filtered unique index if each key can only have one active row. A plain unique constraint can't tell active rows from deleted ones: in the test, re-adding a soft-deleted email failed with Msg 2627. A unique index filtered to `is_deleted` = 0 let it back in, and still stopped a second active copy with Msg 2601.

## What it risks

Queries that don't show SQL Server the literal filter can't use the filtered indexes. A query against the table with `is_deleted` = `@is_deleted` scanned, and so did one with a literal `is_deleted` = 0 under forced parameterization. The same query through the view used the filtered index both times, because the literal in a view's definition doesn't get parameterized. [Filtered indexes need to see the filter](filtered-indexes-need-to-see-the-filter.md) has the rest of the rules.

## How fast it works

Immediate, for the queries that go through the view. With 80% of a million rows deleted, counting one month's active accounts read 5,988 pages with no index, 108 with an index on created that kept every row, and 24 with the same index filtered to active rows, which was a fifth the size. When deleted rows are a small share of the table, a filtered index buys you little besides uniqueness.

## When it backfires

Never purging. Deleted rows pile up in the clustered index and every unfiltered index, and every scan reads them. Move them to an archive table after a retention period, in batches ([Think in batches](think-in-batches.md)), so the table stays sized for the rows people actually use.

## Evidence

Demo code and measurements: [evidence/soft-deletes-are-a-filter-on-every-query.md](../evidence/soft-deletes-are-a-filter-on-every-query.md). Open it to quote a number or run the demo.

## Reading

- [So You Want To Implement Soft Deletes In SQL Server](https://erikdarling.com/so-you-want-to-implement-soft-deletes-in-sql-server/)
- [Considerations For Implementing Soft Deletes In SQL Server](https://erikdarling.com/considerations-for-implementing-soft-deletes/)
