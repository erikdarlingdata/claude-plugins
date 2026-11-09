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

One `DELETE` of every row, which did escalate to a table lock, still left 6,249. `DELETE ... WITH (TABLOCK)` gives the pages back, except under [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) (Read Committed Snapshot Isolation), snapshot isolation, or Accelerated Database Recovery (which optimized locking needs), where even that kept every page.

## Deeper dive

Two million narrow rows to load from, and three empty tables to load them into:

```sql
/*Two million rows to load from*/
CREATE TABLE
    dbo.LoadSource
(
    id integer NOT NULL,
    created datetime NOT NULL,
    note varchar(400) NOT NULL
);

INSERT
    dbo.LoadSource
WITH
    (TABLOCK)
(
    id,
    created,
    note
)
SELECT TOP (2000000)
    id = ROW_NUMBER() OVER (ORDER BY 1/0),
    created = CONVERT(datetime, '20260101', 112),
    note = REPLICATE('n', 10)
FROM sys.all_columns AS ac1
CROSS JOIN sys.all_columns AS ac2;

/*A bare heap, a heap with one nonclustered index, and a clustered table*/
CREATE TABLE
    dbo.LoadHeap
(
    id integer NOT NULL,
    created datetime NOT NULL,
    note varchar(400) NOT NULL
);

CREATE TABLE
    dbo.LoadHeapIndexed
(
    id integer NOT NULL,
    created datetime NOT NULL,
    note varchar(400) NOT NULL,
    INDEX id NONCLUSTERED (id)
);

CREATE TABLE
    dbo.LoadClustered
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    created datetime NOT NULL,
    note varchar(400) NOT NULL
);
```

Then the same load into each:

```sql
/*Run each with the actual plan on*/
INSERT
    dbo.LoadHeap
WITH
    (TABLOCK)
(
    id,
    created,
    note
)
SELECT
    ls.id,
    ls.created,
    ls.note
FROM dbo.LoadSource AS ls;

INSERT
    dbo.LoadHeapIndexed
WITH
    (TABLOCK)
(
    id,
    created,
    note
)
SELECT
    ls.id,
    ls.created,
    ls.note
FROM dbo.LoadSource AS ls;

INSERT
    dbo.LoadClustered
WITH
    (TABLOCK)
(
    id,
    created,
    note
)
SELECT
    ls.id,
    ls.created,
    ls.note
FROM dbo.LoadSource AS ls;
```

On **SQL Server 2025** with two CPUs, the bare heap's plan put the Table Insert below the Gather Streams, so both threads inserted rows, and the load took about half a second. The clustered table sorted the rows in parallel, then inserted them on one thread above the Gather Streams, in about 1.5 seconds. The heap with the nonclustered index got a serial plan. It inserted the rows into the heap, sorted them, and inserted them again into the index, in 5 to 5.6 seconds. Those timings are with actual plans off, since collecting them slowed every load down.

Parallel inserts like the first one need compatibility level 130 (**SQL Server 2016**) or higher and the `TABLOCK` hint. At compatibility level 120, or without the hint, the bare heap load ran serially too.

Indexing after the load instead:

```sql
/*Load the bare heap first, then index it*/
TRUNCATE TABLE dbo.LoadHeap;

INSERT
    dbo.LoadHeap
WITH
    (TABLOCK)
(
    id,
    created,
    note
)
SELECT
    ls.id,
    ls.created,
    ls.note
FROM dbo.LoadSource AS ls;

CREATE INDEX
    id
ON dbo.LoadHeap
    (id);
```

The load and the index together took 1.1 to 1.3 seconds.

Forwarded records. Copy the rows into a fresh heap, then look at it before and after an update that makes rows bigger:

```sql
/*A fresh heap with the same two million rows*/
SELECT
    ls.id,
    ls.created,
    ls.note
INTO dbo.HeapUpdates
FROM dbo.LoadSource AS ls;

/*LIMITED mode, the default, returns NULL for forwarded_record_count*/
SELECT
    pages = ips.page_count,
    forwarded_records = ips.forwarded_record_count
FROM sys.dm_db_index_physical_stats
(
    DB_ID(),
    OBJECT_ID(N'dbo.HeapUpdates'),
    0,
    NULL,
    'DETAILED'
) AS ips;

SET STATISTICS IO ON;

SELECT
    grown = COUNT_BIG(*)
FROM dbo.HeapUpdates AS hu
WHERE hu.note LIKE 'w%';

SET STATISTICS IO OFF;

/*Grow one row in ten from 10 characters to 300*/
UPDATE
    hu
SET
    hu.note = REPLICATE('w', 300)
FROM dbo.HeapUpdates AS hu
WHERE hu.id % 10 = 0;

/*Run the stats query and the count again, then rebuild and run them once more*/
ALTER TABLE
    dbo.HeapUpdates
REBUILD;
```

Before the update: 8,660 pages, no forwarded records, and the count read 8,660 pages. After it: 16,978 pages, 191,342 forwarded records, and the same count read 208,320, one read for every page plus one for every forwarded record. After `ALTER TABLE ... REBUILD`: 16,002 pages, no forwarded records, and 16,002 reads.

A copy with id as its clustered primary key, given the same update, split pages instead. It ended up with 17,317 pages, and the count read about 17,500.

A `REBUILD` on a heap also rebuilds every nonclustered index on it, because the rows get new physical locations. The first post below gets into working around that on a big heap.

Deletes. Empty a heap without a table lock, then look at what's left:

```sql
/*Empty a heap in batches small enough to avoid lock escalation*/
SELECT
    ls.id,
    ls.created,
    ls.note
INTO dbo.HeapDeletes
FROM dbo.LoadSource AS ls;

DECLARE
    @rows bigint = 1;

WHILE @rows > 0
BEGIN
    DELETE TOP (4000)
        hd
    FROM dbo.HeapDeletes AS hd;

    SET @rows = ROWCOUNT_BIG();
END;

/*No rows left, and every page still allocated*/
SELECT
    pages = ips.page_count,
    rows_left = ips.record_count
FROM sys.dm_db_index_physical_stats
(
    DB_ID(),
    OBJECT_ID(N'dbo.HeapDeletes'),
    0,
    NULL,
    'DETAILED'
) AS ips;

SET STATISTICS IO ON;

SELECT
    rows_left = COUNT_BIG(*)
FROM dbo.HeapDeletes AS hd;

SET STATISTICS IO OFF;
```

All 8,660 pages were still allocated, and counting zero rows read every one of them. Drop it, recreate it with the same `SELECT ... INTO`, and run the loop again with a table lock on the `DELETE`:

```sql
DELETE TOP (4000)
    hd
FROM dbo.HeapDeletes AS hd WITH (TABLOCK);
```

That left 1 page, and the count read 1. Lock escalation isn't a reliable substitute: one `DELETE` of all two million rows, with no hint, escalated to a table lock and still left 6,249 pages allocated, the ones it emptied before it escalated. For a staging table you're emptying all the way, `TRUNCATE TABLE` took it to 0 pages in every test here.

Row versioning changes this. In databases with `READ_COMMITTED_SNAPSHOT`, [ALLOW_SNAPSHOT_ISOLATION](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-set-options), or `ACCELERATED_DATABASE_RECOVERY` on, the `TABLOCK` loop kept every page. Optimized locking on **SQL Server 2025** needs Accelerated Database Recovery, so it keeps them too. With it on, both loops and the single `DELETE` all left 12,123 pages, and the single `DELETE` no longer escalated. `TRUNCATE TABLE` still took it to 0.

The heap started out bigger there too, 12,123 pages instead of 8,660. That's because rows inserted while row versioning is on carry 14 bytes of row versioning information: about 28 MB across two million rows. [Readers shouldn't wait on writers](readers-shouldn-t-wait-on-writers.md) covers the rest of what row versioning costs.

## Reading

- [Learn T-SQL With Erik: Heap Table Problems with Updates and Deletes](https://erikdarling.com/learn-t-sql-with-erik-heap-table-problems-with-updates-and-deletes/)
- [A Little About Forwarded Fetches In SQL Server](https://erikdarling.com/a-little-about-forwarded-fetches-in-sql-server/)
