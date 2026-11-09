# The write tax

Where it sits in the chart: An index > A new index > "What does this index cost to keep?" (The write tax nobody budgets for)

Every index is a separate copy of some of your data, on disk and in memory. SQL Server maintains it on every insert and delete, plus any update that touches its columns, whether anything reads from it or not. That's all true, and none of it is a reason to be scared of indexes. The goal is an index whose creation and maintenance cost gets amortized over the many queries it makes faster. Enjoy responsibly.

## What it costs

Storage, backup size, log volume, and maintenance time all grow a little with every index. So does memory: SQL Server has to read an index into the buffer pool to change it, whether any query ever reads from it or not.

## What it risks

The danger is cumulative: each index is cheap, the fifteenth is not, and the new index isn't yours alone. The optimizer (which picks the plan) can start using it for other queries too, and some of them can be worse off with it.

Locks add up too, though not across indexes. Lock escalation (SQL Server trading thousands of row and page locks for one table lock) needs at least 5,000 locks on a single index, and locks on different indexes don't combine to reach it. They do share the count that decides when SQL Server checks, which happens each time the locks the transaction holds reach another multiple of 1,250. An extra index can carry a modification to a check it never used to reach, and if any one index is past 5,000 at that point, the whole table gets locked.

## How fast it works

Immediate. The next query that can use it, uses it, and so does every query you didn't test.

## When it backfires

An `INCLUDE` on a column the workload updates. An index on `c1` alone sits out every update to `age`, and with `age` in its `INCLUDE` list, every one of those updates maintains it. In the dive, the locks that one index added pushed a 4,500-row update to an escalation check it never used to reach, and the whole table ended up under one `X` lock.

## Deeper dive

A table with an index for the `UPDATE` to find its rows, plus three indexes nothing reads:

```sql
CREATE TABLE
    dbo.Users
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    reputation integer NOT NULL,
    age integer NOT NULL,
    c1 integer NOT NULL,
    c2 integer NOT NULL,
    c3 integer NOT NULL,
    filler char(100) NOT NULL
        DEFAULT ''
);

INSERT
    dbo.Users
WITH
    (TABLOCK)
(
    id,
    reputation,
    age,
    c1,
    c2,
    c3
)
SELECT
    x.n,
    x.n % 1000,
    x.n % 80,
    x.n % 7,
    x.n % 11,
    x.n % 13
FROM
(
    SELECT TOP (1500000)
        n = CONVERT(integer, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

/*The index the UPDATE uses to find its rows*/
CREATE INDEX
    reputation
ON dbo.Users
    (reputation);

/*Three indexes nothing reads*/
CREATE INDEX c1 ON dbo.Users (c1) INCLUDE (age);
CREATE INDEX c2 ON dbo.Users (c2) INCLUDE (age);
CREATE INDEX c3 ON dbo.Users (c3) INCLUDE (age);
```

Empty the buffer pool, change 1,500 rows, and look at what's in memory and what the usage stats say:

```sql
/*Test server only: empty the buffer pool first*/
CHECKPOINT;
DBCC DROPCLEANBUFFERS;

/*1,500 rows*/
UPDATE
    u
SET
    u.age += 1
FROM dbo.Users AS u
WHERE u.reputation = 191;

SELECT
    index_name = i.name,
    pages_in_memory = COUNT_BIG(*)
FROM sys.dm_os_buffer_descriptors AS bd
JOIN sys.allocation_units AS au
  ON au.allocation_unit_id = bd.allocation_unit_id
JOIN sys.partitions AS p
  ON p.hobt_id = au.container_id
JOIN sys.indexes AS i
  ON  i.object_id = p.object_id
  AND i.index_id = p.index_id
WHERE bd.database_id = DB_ID()
AND   p.object_id = OBJECT_ID(N'dbo.Users')
GROUP BY
    i.name
ORDER BY
    i.name;

SELECT
    index_name = i.name,
    us.user_seeks,
    us.user_scans,
    us.user_lookups,
    us.user_updates
FROM sys.dm_db_index_usage_stats AS us
JOIN sys.indexes AS i
  ON  i.object_id = us.object_id
  AND i.index_id = us.index_id
WHERE us.database_id = DB_ID()
AND   us.object_id = OBJECT_ID(N'dbo.Users')
ORDER BY
    i.name;
```

On **SQL Server 2025**, the three indexes nothing reads ended up almost entirely in memory: 3,349 to 3,353 pages each, out of about 3,355, roughly 26 MB apiece. The usage stats had them at zero seeks, scans, and lookups, and one update each. A one-row `INSERT` after another cold start still pulled 18 to 26 pages of each one into memory.

Locks pile up the same way. With the three extra indexes gone, a 4,500-row update inside a transaction:

```sql
DROP INDEX c1 ON dbo.Users;
DROP INDEX c2 ON dbo.Users;
DROP INDEX c3 ON dbo.Users;

BEGIN TRANSACTION;

/*4,500 rows*/
UPDATE
    u
SET
    u.age += 1
FROM dbo.Users AS u
WHERE u.reputation IN (191, 192, 193);

SELECT
    dtl.resource_type,
    dtl.request_mode,
    locks = COUNT_BIG(*)
FROM sys.dm_tran_locks AS dtl
WHERE dtl.request_session_id = @@SPID
AND   dtl.resource_database_id = DB_ID()
AND   dtl.resource_type IN (N'OBJECT', N'PAGE', N'KEY')
GROUP BY
    dtl.resource_type,
    dtl.request_mode
ORDER BY
    dtl.resource_type;

ROLLBACK TRANSACTION;
```

That held 4,500 key locks and 1,500 page locks on the clustered index, under an `IX` lock on the table. Add one index that includes `age` and run the transaction again:

```sql
/*One index that includes the column being updated*/
CREATE INDEX c1 ON dbo.Users (c1) INCLUDE (age);
```

This time it ended holding a single `X` lock on the whole table. The `lock_escalation` extended event showed the clustered index escalating with 6,000 locks, the same 6,000 it held when nothing escalated. The new index didn't add to that count, but its locks did change when SQL Server checked it:

- SQL Server checks for escalation each time the locks the transaction holds reach another multiple of 1,250, starting at 2,500. It only escalates when one index (or one partition) has at least 5,000 locks at that check, not counting the table lock or the lock being taken.
- Without the new index, the clustered index was still under 5,000 at the check at 5,000 held locks, and the statement finished before holding 6,250.
- With it, the update moved on to the new index once the clustered index was done, and about 250 locks in, the count hit 6,250. The event counted 6,248 locks released by the escalation: the clustered index's 6,000 plus 248 on the new index.
- The plan was parallel, and each thread in a parallel plan keeps its own count, so the locks the worker threads took on `reputation` while finding rows didn't count toward those checks.

More from the same table, with optimized locking off:

- Spread across indexes, locks don't combine. With all three included-column indexes, a 3,000-row update took about 19,000 locks, the most on any one index was 4,979 (on `c1`), and it stayed at row level.
- With `age` as a key column instead of an included one, each changed row moves inside that index and takes two key locks there. Updating 3,000 rows escalated on that index by itself, with 5,062 locks on it when the check fired. Updating 1,500 rows put 3,274 locks on it and stayed at row level.
- Locks from earlier statements in the same transaction move the checks too. On another test table, a serial 5,500-row update stayed at row level on its own and after an update that held 506 locks, and escalated after one that held 607. The parallel update here stayed at row level even after 1,005, because its threads started their own counts.
- Because the check only runs at multiples of 1,250 held locks, there's no clean row count where escalation starts. On that other test table, a key-column update escalated at 2,400 rows, stayed at row level at 2,500 and 2,600, and escalated again at 3,000.

With optimized locking on (**SQL Server 2025**):

- Row and page locks are mostly released as each row is changed, so the 4,500-row update with the new index and the 3,000-row key-column update both stayed at row level, with RCSI on or off. Some page locks on the nonclustered indexes did stay until the transaction ended, up to 1,979 on one index.
- Without RCSI, plans that hold on to the locks they take while finding rows can still escalate. A 10,500-row update that scanned the clustered index escalated on it. On the other test table, an update that looked rows up with nested loops prefetch held its locks until the statement finished, and escalated at the same point it did with optimized locking off. With prefetch turned off (trace flag 8744, on a test server), it didn't.
- With RCSI on too, lock after qualification finds rows without locking them, and the 10,500-row update stayed at row level. It still isn't a guarantee: with one wider included-column index and one narrow one, a 4,500-row update escalated on the wider index. Its plan read rows through two indexes at once, which turns lock after qualification off.

## Reading

- [A Little About How Overindexing Can Hurt SQL Server Performance](https://erikdarling.com/a-little-about-how-overindexing-can-hurt-sql-server-performance/)
- [How Unused Indexes Hurt: Lock Escalation](https://erikdarling.com/how-unused-indexes-hurt-lock-escalation/)
- [The Lock Escalation Threshold, Part 1](https://www.sql.kiwi/2022/09/lock-escalation-threshold-part-1/) (Paul White)
- [The Lock Escalation Threshold, Part 2](https://www.sql.kiwi/2022/10/lock-escalation-threshold-part-2/) (Paul White)
- [The Lock Escalation Threshold, Part 3](https://www.sql.kiwi/2022/10/lock-escalation-threshold-part-3/) (Paul White)
