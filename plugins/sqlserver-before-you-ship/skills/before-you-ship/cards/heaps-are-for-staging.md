# Heaps are for staging

Where it sits in the chart: A table > A new table > "Leaving it without a clustered index?" (A heap, on purpose or by accident)

A table with no clustered index is a heap. Rows go wherever there's room, in no particular order, which is what makes heaps quick to load. With no indexes on it, `INSERT ... WITH` ([TABLOCK](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table)) into a heap can run fully parallel. That suits staging tables, which get loaded, worked on, and truncated.

Heaps get worse the longer rows stay and change. An update that makes a row too big for its page moves the row and leaves a forwarding pointer behind. A delete without a `TABLOCK` hint (which locks the whole table) can leave the emptied pages allocated, and scans keep reading them.

A table that will take updates and deletes for years wants a clustered index: [Choose your clustering on purpose](choose-your-clustering-on-purpose.md).

## What it costs

Slower loads into the tables that get a clustered index. In a test, two million rows went into an index-free heap `WITH (TABLOCK)` in about half a second, fully parallel. The same rows went into a clustered table in about 1.5 seconds, sorted first and inserted on one thread.

## What it risks

Heaps that take updates. Growing 10% of the rows in a two-million-row heap left 191,342 forwarded records. A scan went from 8,660 reads to 208,320: one per page, now 16,978, plus one per forwarded record. A clustered table given the same update split pages instead, and its scan read about 17,500. `ALTER TABLE` ... [REBUILD](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql) clears forwarded records, but it also rebuilds every nonclustered index on the heap.

## How fast it works

The next load. Indexes slow heap loads down too: one nonclustered index made the same load run on one thread, in about 5 seconds. Loading the bare heap and creating the index afterward took about 1.2 seconds in all.

## When it backfires

Emptying a staging heap with `DELETE` instead of [TRUNCATE](https://learn.microsoft.com/en-us/sql/t-sql/statements/truncate-table-transact-sql) `TABLE`. Without a `TABLOCK` hint, a delete leaves emptied pages allocated. After deleting every row 4,000 at a time, the heap still had all 8,660 of its pages. A scan of the empty table read every one.

One `DELETE` of every row, which did escalate to a table lock, still left 6,249. `DELETE ... WITH (TABLOCK)` gives the pages back, except under [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) (Read Committed Snapshot Isolation), snapshot isolation, or Accelerated Database Recovery (which optimized locking needs), where even that kept every page. So does an `AFTER DELETE` trigger on a heap with a LOB column, or with columns wide enough that a row could overflow.

## Evidence

Demo code and measurements: [evidence/heaps-are-for-staging.md](../evidence/heaps-are-for-staging.md). Open it to quote a number or run the demo.

## Reading

- [Learn T-SQL With Erik: Heap Table Problems with Updates and Deletes](https://erikdarling.com/learn-t-sql-with-erik-heap-table-problems-with-updates-and-deletes/)
- [A Little About Forwarded Fetches In SQL Server](https://erikdarling.com/a-little-about-forwarded-fetches-in-sql-server/)
- [Deletes that Split Pages and Forwarded Ghosts](https://www.sql.kiwi/2012/08/deletes-that-split-pages-and-forwarded-ghosts/) (Paul White)
