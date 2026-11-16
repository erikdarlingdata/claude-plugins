# Filtered indexes need to see the filter

Where it sits in the chart: An index > A new index > "Indexing only some of the rows?" (Filtered indexes: open tasks, active rows, non-NULL values)

A filtered index only holds the rows that match its `WHERE` clause, like the 1% of tasks still open. So it's small, cheap to keep up, and gets statistics (what SQL Server uses to estimate row counts) on only those rows.

A query can only use it when SQL Server can tell at compile time that the query only wants rows inside the filter. Write the filter into the query as a literal, `is_done` = 0, and the index matches. Pass it in as a parameter, `is_done` = `@is_done`, and it can't, because the cached plan has to work for any value, including 1.

## What it costs

Keeping the filter literal in the queries meant to use the index, and putting the filter column in the index's [INCLUDE](https://learn.microsoft.com/en-us/sql/t-sql/statements/create-index-transact-sql) list. Everything else in those queries can stay parameterized.

## What it risks

Sessions with the wrong `SET` options (connection settings). Inserts, updates, and deletes on a table with a filtered index fail unless the session sets [QUOTED_IDENTIFIER](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-quoted-identifier-transact-sql), [ANSI_NULLS](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-ansi-nulls-transact-sql), and a few others the standard way. In a test, an `UPDATE` from a session with `QUOTED_IDENTIFIER OFF`, the default for sqlcmd without -I, failed with Msg 1934. Before you add a filtered index, check what your jobs and older tools connect with.

## How fast it works

Immediate, for the queries that match. Finding one person's 200 open tasks read 3 pages from a filtered index that holds 10,000 rows in 34 pages. The parameterized version scanned the table, 3,224 pages.

## When it backfires

Parameterizing the filter. A procedure that takes `@is_done` and filters on it never uses the index. The plan shows an Unmatched Indexes warning, but plans that did use the index can show it too, so look for the scan. `OPTION` ([RECOMPILE](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query)) lets it match, at the cost of a compile per run, or keep one query per filter value with the value written in.

## Evidence

Demo code and measurements: [evidence/filtered-indexes-need-to-see-the-filter.md](../evidence/filtered-indexes-need-to-see-the-filter.md). Open it to quote a number or run the demo.

## Reading

- [Common SQL Server Consulting Advice: Adding Filtered Indexes](https://erikdarling.com/adding-filtered-indexes/)
