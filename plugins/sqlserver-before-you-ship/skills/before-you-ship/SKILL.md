---
name: before-you-ship
description: Trade-offs to check before shipping SQL Server code, from Erik Darling's "Before you ship that" chart. Use when someone is writing or changing a T-SQL query, designing or altering a table, adding an index or cleaning up existing ones, or asks for a review of T-SQL code or a pull request that touches SQL Server. Each card gives one action and what it costs, what it risks, how fast it works, and when it backfires.
---

# Before you ship that

This is the agent version of the chart at https://erikdarling.com/before-you-ship. The chart walks a developer through questions about the code they're working on, and each question leads to a card with one action and its trade-offs. The cards are in `cards/`, next to this file.

## How to use it

1. Work out what's being changed:
   - a query: does it read data or change it, and is it new or already running?
   - a table: new, or already in use?
   - an index: a new one, or the ones already there?
2. Go through the questions for that path in the map below. Skip the ones that don't fit the code in front of you.
3. For each question that fits, read its card before saying anything about it. The title alone isn't enough.
4. If a card needs a plan, Query Store numbers, index usage stats or a production-sized test, ask the author for exactly that and mark the finding unverified. Do not infer it from the diff.
5. Report what applies: the card's action, and the trade-offs from its four sections. The numbers on the cards are what the tests showed, not what the user's server will do.
6. If nothing here covers the problem, say so. Don't stretch a card to fit.

## About the cards

- The demos build their own tables. Run one card's demo at a time in a scratch database: cards define `dbo.Orders`, `dbo.Posts` and `dbo.Tasks` differently, and some borrow a table from another card and say so. Cards that need [StackOverflow2013](https://go.erikdarling.com/Stack2013) say so.
- Tested on SQL Server 2025 CU10 at compatibility level 170, unless a card says otherwise. Check the user's version and edition before passing on advice that depends on them.
- Timings are from a two-core VM. Compare them to each other, not to the user's server.
- "The course" in the cards is Erik's SQL Server training, the video courses at https://training.erikdarling.com/catalog.

## First: NOLOCK

Before anything else on a query, look for `NOLOCK` hints or `READ UNCOMMITTED`. If there are any, the chart stops there: "Remove those first. Then come back."

`NOLOCK` does not mean your query takes no locks. It means your query ignores the locks other queries take. That's how you read uncommitted data that gets rolled back, count rows twice, or miss them entirely.

The damage gets permanent when a `NOLOCK` read decides what gets written. An `UPDATE` that joins to a table read `WITH (NOLOCK)` can copy in a value that later rolls back, and the copy stays. A `NOT EXISTS` check read with `NOLOCK` can skip an insert that needed to happen, or let a duplicate through. `NOLOCK` on the table an `UPDATE` or `DELETE` changes does nothing, because SQL Server ignores it there. Aaron Bertrand's [Dirty Reads, Permanent Damage](https://sqlperformance.com/2026/08/sql-performance/dirty-reads-permanent-damage) walks through these, and [Learn T-SQL With Erik: Writing Bad Data With NOLOCK Hints](https://erikdarling.com/learn-t-sql-with-erik-writing-bad-data-with-nolock-hints/) shows the first one on video.

If the query is only fast with the hints in, the hints aren't a fix, they're a confession.

Same goes for `SET TRANSACTION ISOLATION LEVEL READ UNCOMMITTED`. That's `NOLOCK` on every table in every query the session runs, until something sets it back.

If the hints went in because readers and writers kept blocking each other, the fix is [Read Committed Snapshot Isolation](cards/readers-shouldn-t-wait-on-writers.md). Readers get the last committed version of the row and stop waiting, without the wrong results. It fixes readers only. Code that reads a row and then writes based on it still needs the hints on [the upsert card](cards/upserts-break-under-concurrency.md).

Take them out, see what's slow, and walk back through the front door.

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
