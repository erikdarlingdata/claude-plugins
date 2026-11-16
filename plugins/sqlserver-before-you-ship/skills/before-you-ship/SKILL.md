---
name: before-you-ship
description: Trade-offs to check before shipping SQL Server code, from Erik Darling's "Before you ship that" chart. Use when someone is writing or changing a T-SQL query, designing or altering a table, adding an index or cleaning up existing ones, or asks for a review of T-SQL code or a pull request that touches SQL Server. Each card gives one action and what it costs, what it risks, how fast it works, and when it backfires.
---

# Before you ship that

This is the agent version of the chart at https://erikdarling.com/before-you-ship. The chart walks a developer through questions about the code they're working on, and each question leads to a card with one action and its trade-offs. The cards are in `cards/`, and each card's demo code and measurements are in `evidence/`, both next to this file.

## How to use it

1. If you have code to review (a diff, a script, a stored procedure), start with [Start from the code](#start-from-the-code) and note every card it points to. If you're helping someone design something, start with [the map](#the-map): work out whether it's a query (reads or changes data, new or already running), a table (new or already in use), or an index (new, or the ones already there), and go through that path's questions.
2. Skip what doesn't fit the code in front of you.
3. Read each card that fits before saying anything about it. The title alone isn't enough. The card has the action and its trade-offs. Open its evidence file only to quote a number or run the demo.
4. If a card needs a plan, Query Store numbers, index usage stats or a production-sized test, ask the author for exactly that and mark the finding unverified. Do not infer it from the diff.
5. Report in the format under [Reporting](#reporting). The numbers on the cards are what the tests showed, not what the user's server will do.
6. If nothing here covers the problem, say so. Don't stretch a card to fit.

## About the cards

- A **Requires** line under a card's title gives the version, edition or compatibility level limits the card states. Check the user's server against it before passing the advice on.
- The demos build their own tables. Run one card's demo at a time in a scratch database: cards define `dbo.Orders`, `dbo.Posts` and `dbo.Tasks` differently, and some borrow a table from another card and say so. Cards that need [StackOverflow2013](https://go.erikdarling.com/Stack2013) say so.
- Tested on SQL Server 2025 CU10 at compatibility level 170, unless a card says otherwise. Check the user's version and edition before passing on advice that depends on them.
- Timings are from a two-core VM. Compare them to each other, not to the user's server.
- "The course" in the cards is Erik's SQL Server training, the video courses at https://training.erikdarling.com/catalog.

## First: NOLOCK

Look for `NOLOCK` or `READUNCOMMITTED` table hints and `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` before anything else. Report every one first, above every other finding. If you can ask the author, ask them to take the hints out, or to confirm the dirty reads are acceptable, before you review the rest of that query. If you can't ask, review the rest anyway, and say your other findings assume the hints come out.

What to tell the author:

- `NOLOCK` doesn't mean the query takes no locks. It means the query ignores the locks other queries take, so it can read data that later rolls back, count rows twice, or miss them entirely.
- The damage is permanent when a `NOLOCK` read decides what gets written. An `UPDATE` that joins to a table read `WITH (NOLOCK)` can copy in a value that later rolls back, and the copy stays. A `NOT EXISTS` check read with `NOLOCK` can skip an insert that needed to happen, or let a duplicate through.
- `NOLOCK` on the table an `UPDATE` or `DELETE` changes does nothing, because SQL Server ignores it there.
- `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED` is `NOLOCK` on every table in every query the session runs, until something sets it back.
- If the hints went in because readers and writers kept blocking each other, the fix is [Read Committed Snapshot Isolation](cards/readers-shouldn-t-wait-on-writers.md). It fixes readers only. Code that reads a row and then writes based on it still needs the hints on [the upsert card](cards/upserts-break-under-concurrency.md).

Sources: Aaron Bertrand's [Dirty Reads, Permanent Damage](https://sqlperformance.com/2026/08/sql-performance/dirty-reads-permanent-damage), and [Learn T-SQL With Erik: Writing Bad Data With NOLOCK Hints](https://erikdarling.com/learn-t-sql-with-erik-writing-bad-data-with-nolock-hints/), which shows the first one on video.

## Start from the code

Scan the code for these and read the cards they point to. One statement can match several rows. The map covers what the code can't show, like how a query runs today and who depends on it.

### Queries that read

- `SELECT *`, or more columns than the caller uses → [Ask for less](cards/ask-for-less.md)
- `OFFSET ... FETCH`, `ROW_NUMBER()` paging, `COUNT(*) OVER ()` next to a page of rows → [Find the page, then fetch the rows](cards/find-the-page-then-fetch-the-rows.md)
- A function on a column in `WHERE` or `ON` (`YEAR(col)`, `ISNULL(col, ...)`, `COALESCE(col, ...)`), `LIKE '%...'`, a column compared to a value of another type → [Filter so indexes can help you](cards/filter-so-indexes-can-help-you.md)
- `col = @p OR @p IS NULL`, one query that handles every combination of optional filters → [Only search what was asked for](cards/only-search-what-was-asked-for.md)
- `DECLARE @x = ...` followed by `WHERE col = @x` → [Local variables hide their values](cards/local-variables-hide-their-values.md)
- `DATEDIFF`, `DATEADD`, `CONVERT` or `AT TIME ZONE` on a column, `BETWEEN` on a datetime column → [Convert the search value, not the column](cards/convert-the-search-value-not-the-column.md)
- `STRING_SPLIT`, comma-separated list parameters, table-valued parameters → [Split lists into a #temp table](cards/split-lists-into-a-temp-table.md)
- `OR` in a join's `ON` clause → [Don't join on OR](cards/don-t-join-on-or.md)
- `LEFT JOIN ... WHERE x.col IS NULL`, `NOT IN (SELECT ...)` → [NOT EXISTS says what you mean](cards/not-exists-says-what-you-mean.md)
- `UNION` or `UNION ALL` → [UNION ALL isn't always faster](cards/union-all-isn-t-always-faster.md)
- A CTE referenced more than once, or a long chain of them → [CTEs aren't temp tables](cards/ctes-aren-t-temp-tables.md)
- `DECLARE @t table` → [Table variables don't know what's in them](cards/table-variables-don-t-know-what-s-in-them.md)
- Scalar UDFs, multi-statement table-valued functions (`RETURNS @t TABLE`) → [Most functions hide their work](cards/most-functions-hide-their-work.md)
- A plan with an Eager Index Spool, or a Top right above a Scan → [An Eager Index Spool is an index you didn't create](cards/an-eager-index-spool-is-an-index-you-didn-t-create.md), [A Top above a scan means a missing index](cards/a-top-above-a-scan-means-a-missing-index.md)
- Application code that builds parameters: `AddWithValue`, `nvarchar` parameters against `varchar` columns, `DateTime` against `datetime2` → [The app picks your parameter types](cards/the-app-picks-your-parameter-types.md)
- Any change to a query that already runs in production → [Look before you touch](cards/look-before-you-touch.md), [Know how it runs today](cards/know-how-it-runs-today.md), [Dev lied to you](cards/dev-lied-to-you.md)

### Queries that change data

- `WITH (NOLOCK)`, `READUNCOMMITTED`, `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED`: report these first, per [First: NOLOCK](#first-nolock) → [Readers shouldn't wait on writers](cards/readers-shouldn-t-wait-on-writers.md)
- Loops, cursors, a stored procedure called once per row → [Think in batches](cards/think-in-batches.md)
- Slow reads, calculations or calls out to anything else between `BEGIN TRANSACTION` and `COMMIT`; a modification with no index to find its rows → [Locks last as long as the transaction](cards/locks-last-as-long-as-the-transaction.md)
- `SET IMPLICIT_TRANSACTIONS ON`, `INSERT ... EXEC`, error paths that skip `COMMIT` or `ROLLBACK` → [Transactions you didn't know you opened](cards/transactions-you-didn-t-know-you-opened.md)
- `IF EXISTS (...) UPDATE ... ELSE INSERT`, or any update-then-insert → [Upserts break under concurrency](cards/upserts-break-under-concurrency.md)
- `MERGE` → [What MERGE does better](cards/what-merge-does-better.md), [Upserts break under concurrency](cards/upserts-break-under-concurrency.md), [Swart's avoid list](cards/swart-s-avoid-list.md)
- `SELECT TOP (1)` and then an `UPDATE` to claim a row, `READPAST` → [Claim it in one statement](cards/claim-it-in-one-statement.md)
- `TRY ... CATCH`, `XACT_ABORT`, `THROW`, `RAISERROR` → [Know what you'll do with the error first](cards/know-what-you-ll-do-with-the-error-first.md)
- `CREATE TRIGGER`, `SELECT @id = i.id FROM inserted`, writes to a table that has a trigger → [Triggers fire per statement, not per row](cards/triggers-fire-per-statement-not-per-row.md)
- `SELECT MAX(id)` after an insert, re-reading rows just written, `SCOPE_IDENTITY()` → [Don't ask twice](cards/don-t-ask-twice.md)
- A changed `SELECT` list on a stored procedure or view other code reads → [Mind your query consumers](cards/mind-your-query-consumers.md)

### Tables

- `nvarchar(max)` or `varchar(max)` by default, dates stored as strings, a column type that doesn't match what it's compared to → [Types are a performance feature](cards/types-are-a-performance-feature.md)
- An `int` identity on a table that could reach billions of rows, `bigint` on small lookup tables, an identity next to a natural key that's already narrow, unique, static and ever-increasing → [Choose your clustering on purpose](cards/choose-your-clustering-on-purpose.md)
- `CREATE TABLE` with no clustered index, `DELETE` from a heap → [Heaps are for staging](cards/heaps-are-for-staging.md)
- Tables for reporting, history or facts, read with `GROUP BY` over millions of rows → [Reporting tables want columnstore](cards/reporting-tables-want-columnstore.md)
- Columns left nullable or unconstrained, constraints created or re-enabled `WITH NOCHECK`, `CHECK` or `DEFAULT` constraints that call scalar functions, foreign key columns with no index → [Constraints help the optimizer](cards/constraints-help-the-optimizer.md)
- One very wide table, or a table split into several narrow ones → [Normalize until it hurts, then measure](cards/normalize-until-it-hurts-then-measure.md)
- `DELETE ... WHERE date_column < ...` to purge or archive old rows → [Move partitions, not rows](cards/move-partitions-not-rows.md)
- `is_deleted` or similar flags → [Soft deletes are a filter on every query](cards/soft-deletes-are-a-filter-on-every-query.md)
- `ALTER TABLE ... ADD` → [Some ALTERs are free. Some aren't.](cards/some-alters-are-free-some-aren-t.md)
- `ALTER TABLE ... ALTER COLUMN` → [The most dangerous ALTER](cards/the-most-dangerous-alter.md)

### Indexes

- `CREATE INDEX`, `ALTER INDEX ... REBUILD` or `DROP INDEX` in a deploy script for a live table → [Index work on a live table](cards/index-work-on-a-live-table.md)
- A new index built from a missing index request → [Audit before you add](cards/audit-before-you-add.md), [Key order decides the seek](cards/key-order-decides-the-seek.md), [Widen before you add](cards/widen-before-you-add.md)
- A new index whose leading keys match an existing one → [Widen before you add](cards/widen-before-you-add.md), [Merge the near-duplicates](cards/merge-the-near-duplicates.md)
- Two inequality predicates on the same index's keys → [Key order decides the seek](cards/key-order-decides-the-seek.md)
- `ORDER BY` columns sitting in `INCLUDE` → [Keys sort. Includes ride along.](cards/keys-sort-includes-ride-along.md)
- `CREATE INDEX ... WHERE` → [Filtered indexes need to see the filter](cards/filtered-indexes-need-to-see-the-filter.md)
- An expression in `WHERE` across two columns or inside a function, like `DATEDIFF(MINUTE, opened, closed) > 1440` → [Index the expression with a computed column](cards/index-the-expression-with-a-computed-column.md)
- `CREATE VIEW ... WITH SCHEMABINDING` with a unique clustered index on it → [Indexed views move the work to the writes](cards/indexed-views-move-the-work-to-the-writes.md)
- `CREATE INDEX` with no `DATA_COMPRESSION` → [Start with page compression](cards/start-with-page-compression.md)
- An index on a write-heavy table, or an `INCLUDE` on a column the workload updates → [The write tax](cards/the-write-tax.md)
- `DROP INDEX` because usage stats say it's unused → [Unused since when?](cards/unused-since-when.md), [Disable, then drop](cards/disable-then-drop.md)

## Reporting

Order the findings by what they cost the user, worst first:

1. Wrong or lost data: `NOLOCK` reads that decide writes, upserts and `MERGE` under concurrency, transactions left open, errors that leave work half done, triggers that assume one row.
2. Blocking: long transactions, lock escalation, index or `ALTER` work on a live table.
3. Speed: everything else.

For each finding:

- **Where:** the file and line, or the statement.
- **Card:** its title, linked.
- **Do:** the card's action, applied to this code.
- **Costs:** the trade-off from the card that matters most here.
- **Check:** what you couldn't confirm from the code (a plan, Query Store numbers, index usage, row counts, the version or edition), or "nothing".

Keep to what the cards back. If you spot something else, list it separately and say no card covers it.

## The map

### A query

Check for `NOLOCK` first (see above).

#### It reads data: a new query

- How much data are you asking for? *(SELECT *, wide rows)* → [Ask for less](cards/ask-for-less.md)
- Showing results a page at a time? *(OFFSET/FETCH, ROW_NUMBER, page 1 of 10,000)* → [Find the page, then fetch the rows](cards/find-the-page-then-fetch-the-rows.md)
- How are you filtering? *(Functions on columns, mismatched types, leading wildcards)* → [Filter so indexes can help you](cards/filter-so-indexes-can-help-you.md)
- Is it a search with optional filters? *(Any combination of parameters, where NULL means "don't filter on this")* → [Only search what was asked for](cards/only-search-what-was-asked-for.md)
- Filtering on a local variable? *(DECLARE @x = ...; then WHERE column = @x)* → [Local variables hide their values](cards/local-variables-hide-their-values.md)
- Filtering by date or time zone? *(DATEDIFF, AT TIME ZONE, or BETWEEN on a datetime column)* → [Convert the search value, not the column](cards/convert-the-search-value-not-the-column.md)
- Passing in a list of values? *(Comma-separated strings, STRING_SPLIT, table-valued parameters)* → [Split lists into a #temp table](cards/split-lists-into-a-temp-table.md)
- Joining on one column OR another? *(ON u.id = p.owner_user_id OR u.id = p.last_editor_user_id)* → [Don't join on OR](cards/don-t-join-on-or.md)
- Looking for rows with no match? *(LEFT JOIN ... IS NULL, NOT IN, NOT EXISTS)* → [NOT EXISTS says what you mean](cards/not-exists-says-what-you-mean.md)
- Combining results with UNION? *(UNION, UNION ALL, and the duplicates in between)* → [UNION ALL isn't always faster](cards/union-all-isn-t-always-faster.md)
- Reaching for a CTE or a temp table? *(When each one helps)* → [CTEs aren't temp tables](cards/ctes-aren-t-temp-tables.md)
- Using a table variable? *(@table instead of #temp, and why people pick it)* → [Table variables don't know what's in them](cards/table-variables-don-t-know-what-s-in-them.md)
- Are you calling a function? *(Scalar UDFs, multi-statement and inline TVFs)* → [Most functions hide their work](cards/most-functions-hide-their-work.md)

#### It reads data: an existing query

- What plan does it have today? *(Will your change blow it up?)* → [Look before you touch](cards/look-before-you-touch.md)
- How does it run today? *(CPU, duration, timeouts, and errors)* → [Know how it runs today](cards/know-how-it-runs-today.md)
- Is there an Eager Index Spool in the plan? *(SQL Server building a temporary index every time the query runs)* → [An Eager Index Spool is an index you didn't create](cards/an-eager-index-spool-is-an-index-you-didn-t-create.md)
- Is there a Top right above a Scan? *(EXISTS, NOT EXISTS, or TOP reading the same table over and over)* → [A Top above a scan means a missing index](cards/a-top-above-a-scan-means-a-missing-index.md)
- Who else depends on this? *(API calls, dashboards, INSERT/EXEC)* → [Mind your query consumers](cards/mind-your-query-consumers.md)
- It worked in dev *(Row counts, parameters, statistics)* → [Dev lied to you](cards/dev-lied-to-you.md)
- Is application code sending it? *(ORMs, AddWithValue, parameter types)* → [The app picks your parameter types](cards/the-app-picks-your-parameter-types.md)
- Is it waiting on writers? *(Readers blocked by modifications, the reason NOLOCK gets added)* → [Readers shouldn't wait on writers](cards/readers-shouldn-t-wait-on-writers.md)

#### It changes data

- Are you doing this row by row? *(Loops, cursors, calling a stored procedure per row)* → [Think in batches](cards/think-in-batches.md)
- How long are you holding locks? *(Every lock lasts until the transaction ends)* → [Locks last as long as the transaction](cards/locks-last-as-long-as-the-transaction.md)
- Could a transaction stay open by accident? *(Implicit transactions, INSERT EXEC, errors)* → [Transactions you didn't know you opened](cards/transactions-you-didn-t-know-you-opened.md)
- Is it an upsert? *(Update it if it's there, insert it if it isn't)* → [Upserts break under concurrency](cards/upserts-break-under-concurrency.md)
- Is it a MERGE? *(Or an upsert by any other name)* The chart asks "Are you sure you want to do this?" before going on:
  - Why MERGE at all? *(Two things it does that other statements don't)* → [What MERGE does better](cards/what-merge-does-better.md)
  - Is this an upsert? *(The upsert card lives on the write side. This jumps there.)* → [Upserts break under concurrency](cards/upserts-break-under-concurrency.md)
  - What's on the target table? *(The avoid list)* → [Swart's avoid list](cards/swart-s-avoid-list.md)
- Is the table a queue? *(Workers pulling the next job off a table)* → [Claim it in one statement](cards/claim-it-in-one-statement.md)
- What happens when it fails? *(Decide before you write TRY/CATCH)* → [Know what you'll do with the error first](cards/know-what-you-ll-do-with-the-error-first.md)
- Is there a trigger on the table? *(Writing one, or modifying a table that has one)* → [Triggers fire per statement, not per row](cards/triggers-fire-per-statement-not-per-row.md)
- Do you need the rows you just changed? *(New identity values, archiving, before-and-after)* → [Don't ask twice](cards/don-t-ask-twice.md)

### A table

#### A new table

- What types are these columns, really? *(nvarchar(MAX) everywhere, mismatched types, dates as strings)* → [Types are a performance feature](cards/types-are-a-performance-feature.md)
- What's the key, and what's clustered? *(Identity, and int or bigint)* → [Choose your clustering on purpose](cards/choose-your-clustering-on-purpose.md)
- Leaving it without a clustered index? *(A heap, on purpose or by accident)* → [Heaps are for staging](cards/heaps-are-for-staging.md)
- Will it mostly be summed and counted? *(Reporting, history, and fact tables (one row per recorded event), read a few columns at a time)* → [Reporting tables want columnstore](cards/reporting-tables-want-columnstore.md)
- NULLs, defaults, constraints? *(They help performance, too)* → [Constraints help the optimizer](cards/constraints-help-the-optimizer.md)
- One wide table or several narrow ones? *(When denormalizing is honest vs lazy)* → [Normalize until it hurts, then measure](cards/normalize-until-it-hurts-then-measure.md)
- Will old data get archived or purged in bulk? *(Months of history that age out on a schedule)* → [Move partitions, not rows](cards/move-partitions-not-rows.md)
- Will rows be deleted, or just marked? *(is_deleted flags, and the filter every query needs)* → [Soft deletes are a filter on every query](cards/soft-deletes-are-a-filter-on-every-query.md)

#### An existing table

- Adding a column *(Metadata-only, or size-of-data?)* → [Some ALTERs are free. Some aren't.](cards/some-alters-are-free-some-aren-t.md)
- Changing a data type *(The one that locks the table)* → [The most dangerous ALTER](cards/the-most-dangerous-alter.md)
- Touching indexes on a live table *(Building or dropping while people use it)* → [Index work on a live table](cards/index-work-on-a-live-table.md)

### An index

#### A new index

- Do you already have one that almost works? *(Widen vs add, near-duplicates)* → [Widen before you add](cards/widen-before-you-add.md)
- What order do the key columns go in? *(Why isn't SQL Server using my index?)* → [Key order decides the seek](cards/key-order-decides-the-seek.md)
- Key columns or included columns? *(What each one costs)* → [Keys sort. Includes ride along.](cards/keys-sort-includes-ride-along.md)
- Indexing only some of the rows? *(Filtered indexes: open tasks, active rows, non-NULL values)* → [Filtered indexes need to see the filter](cards/filtered-indexes-need-to-see-the-filter.md)
- Filtering on an expression you can't rewrite? *(Math across two columns, function results, CASE expressions)* → [Index the expression with a computed column](cards/index-the-expression-with-a-computed-column.md)
- Pre-computing an aggregate? *(Indexed views: totals and counts kept current on every write)* → [Indexed views move the work to the writes](cards/indexed-views-move-the-work-to-the-writes.md)
- Should it be compressed? *(ROW, PAGE, and what they cost)* → [Start with page compression](cards/start-with-page-compression.md)
- What does this index cost to keep? *(The write tax nobody budgets for)* → [The write tax](cards/the-write-tax.md)

#### Existing indexes

- Which ones do queries use? *(Usage stats, reads vs writes)* → [Audit before you add](cards/audit-before-you-add.md)
- Can these be merged? *(Consolidation without breaking the one query)* → [Merge the near-duplicates](cards/merge-the-near-duplicates.md)
- It says unused. Is it? *(Why three quiet weeks prove nothing)* → [Unused since when?](cards/unused-since-when.md)
- How do I drop one safely? *(Disable first, wait and see)* → [Disable, then drop](cards/disable-then-drop.md)
- Are they compressed? *(The compression card lives on the new-index side. This jumps there.)* → [Start with page compression](cards/start-with-page-compression.md)
