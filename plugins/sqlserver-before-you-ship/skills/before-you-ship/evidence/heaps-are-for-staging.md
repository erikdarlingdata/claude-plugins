# Heaps are for staging: evidence

The card: [Heaps are for staging](../cards/heaps-are-for-staging.md)

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

The heap started out bigger there too, 12,123 pages instead of 8,660. That's because rows inserted while row versioning is on carry 14 bytes of row versioning information: about 28 MB across two million rows. [Readers shouldn't wait on writers](../cards/readers-shouldn-t-wait-on-writers.md) covers the rest of what row versioning costs.
