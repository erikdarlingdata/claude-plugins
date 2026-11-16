# Index work on a live table: evidence

The card: [Index work on a live table](../cards/index-work-on-a-live-table.md)

What those short locks look like in practice. A million-row table:

```sql
CREATE TABLE
    dbo.LiveDemo
(
    id integer NOT NULL
       PRIMARY KEY CLUSTERED,
    a integer NOT NULL,
    filler char(100) NOT NULL
       DEFAULT 'x'
);

INSERT
    dbo.LiveDemo
WITH
    (TABLOCK)
(
    id,
    a
)
SELECT
    x.id,
    a = x.id % 1000
FROM
(
    SELECT TOP (1000000)
        id = ROW_NUMBER() OVER (ORDER BY 1/0)
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;
```

One session changes a row and leaves its transaction open, like an app that's slow to commit or a batch that's halfway through:

```sql
/*Window 1: change one row, don't commit yet*/
BEGIN TRANSACTION;

UPDATE
    ld
SET
    ld.a = ld.a
FROM dbo.LiveDemo AS ld
WHERE ld.id = 1;
```

A second session starts an online index build:

```sql
/*Window 2: build an index online*/
CREATE INDEX
    a
ON dbo.LiveDemo
    (a)
WITH
    (ONLINE = ON);
```

A third tries to change a row nobody else is touching:

```sql
/*Window 3: change a different row*/
UPDATE
    ld
SET
    ld.a = ld.a
FROM dbo.LiveDemo AS ld
WHERE ld.id = 500000;
```

On **SQL Server 2025**, the build waits for window 1. It needs a shared lock on the table to get started, and the open transaction is in the way.

Window 3 then queues behind the build. In the test it waited about four seconds for a row no one had locked. It would have kept waiting as long as window 1 stayed open. Readers got through, since a shared lock doesn't block them.

`ALTER INDEX ... REBUILD WITH (ONLINE = ON)` behaved the same way at the start. A rebuild finishes with a schema modification lock, though, and if a transaction is open at that moment, readers queue too. In a test that opened one partway through an online rebuild, a single-row read waited about 4.7 seconds.

[RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) (Read Committed Snapshot Isolation) and **SQL Server 2025**'s optimized locking don't change this. The open transaction still holds its table-level intent lock. With either or both on, window 3 still waited about 4 seconds behind the build, and the read still waited behind the rebuild's final lock.

When you're done watching, commit window 1, and drop the new index before trying the next version:

```sql
/*Window 1*/
COMMIT TRANSACTION;

/*Any window*/
DROP INDEX
    a
ON dbo.LiveDemo;
```

Start window 1 again, then run window 2 with `WAIT_AT_LOW_PRIORITY`, then window 3. The build waits in a separate low-priority queue that nothing lines up behind:

```sql
CREATE INDEX
    a
ON dbo.LiveDemo
    (a)
WITH
(
    ONLINE = ON
    (
        WAIT_AT_LOW_PRIORITY
        (
            MAX_DURATION = 1 MINUTES,
            ABORT_AFTER_WAIT = SELF
        )
    )
);
```

Same test: window 3 finished in a few milliseconds, and the build started as soon as window 1 committed.

`MAX_DURATION` is how long the build is willing to wait, in minutes, and `ABORT_AFTER_WAIT` says what happens after that. `SELF` cancels the build, `BLOCKERS` kills the sessions in its way, and `NONE` goes back to waiting at normal priority, queue and all. `SELF` is the one to put in a deploy script.

It covers the finishing lock too. With `WAIT_AT_LOW_PRIORITY` on the rebuild in the test above, the read went straight through. The rebuild waited for its schema modification lock at low priority.

`CREATE INDEX` accepts `WAIT_AT_LOW_PRIORITY` on **SQL Server 2022** and later. `ALTER INDEX ... REBUILD` got it in **2014**.
