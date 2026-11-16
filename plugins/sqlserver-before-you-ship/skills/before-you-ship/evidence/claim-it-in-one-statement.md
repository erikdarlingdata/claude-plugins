# Claim it in one statement: evidence

The card: [Claim it in one statement](../cards/claim-it-in-one-statement.md)

A self-contained version of the course's queue table:

```sql
CREATE TABLE
    dbo.JobQueue
(
    id bigint IDENTITY(1, 1) NOT NULL,
    in_process bit NOT NULL
        DEFAULT 0,
    job_key integer NOT NULL,
    claimed_at datetime2(3) NULL,
    CONSTRAINT JobQueue_in_process_id
        PRIMARY KEY CLUSTERED (in_process, id),
    INDEX JobQueue_job_key
        UNIQUE NONCLUSTERED (job_key)
    WITH
        (IGNORE_DUP_KEY = ON)
);

INSERT
    dbo.JobQueue
(
    job_key
)
SELECT TOP (10000)
    job_key = ROW_NUMBER() OVER (ORDER BY 1/0)
FROM sys.all_columns AS ac;

/*Queued again: dropped with a warning, not an error*/
INSERT
    dbo.JobQueue
(
    job_key
)
VALUES
    (1);
```

The key leads with `in_process`, so every claim seeks to the unclaimed rows and reads them in id order. The unique index on `job_key`, with `IGNORE_DUP_KEY`, quietly drops a job that's queued twice. The last insert returns a "Duplicate key was ignored." warning and adds nothing.

The claim, in window 1, with its transaction left open the way a slow worker holds it:

```sql
/*Window 1: claim a job, and keep the transaction open*/
BEGIN TRANSACTION;

WITH
    next_job AS
(
    SELECT TOP (1)
        jq.id,
        jq.in_process,
        jq.job_key,
        jq.claimed_at
    FROM dbo.JobQueue AS jq WITH (READPAST, ROWLOCK, UPDLOCK)
    WHERE jq.in_process = 0
    ORDER BY
        jq.id
)
UPDATE
    nj
SET
    nj.in_process = 1,
    nj.claimed_at = SYSDATETIME()
OUTPUT
    Inserted.id,
    Inserted.job_key
FROM next_job AS nj;
```

Run the same `UPDATE`, minus `BEGIN TRANSACTION`, in window 2. On **SQL Server 2025** it claimed the next job immediately and skipped the row window 1 had locked. Take `READPAST` out of window 2's hints and it waits instead, for as long as window 1 keeps its transaction open.

[OUTPUT](https://learn.microsoft.com/en-us/sql/t-sql/queries/output-clause-transact-sql) hands each worker the row it claimed. [Don't ask twice](../cards/don-t-ask-twice.md) covers `OUTPUT`.

Commit window 1 when you're done. **SQL Server 2025**'s optimized locking didn't change any of this in testing, with or without [RCSI](https://learn.microsoft.com/en-us/sql/relational-databases/sql-server-transaction-locking-and-row-versioning-guide) (Read Committed Snapshot Isolation).

In a real worker, the claim is a statement of its own and commits right away, and the job runs afterward, outside any transaction. Window 1 holds its transaction open only to freeze the moment. That's also why stale claims need a way back, which the backfire row covers.

The version to avoid:

```sql
/*Don't: find it, then claim it*/
DECLARE
    @id bigint;

SELECT TOP (1)
    @id = jq.id
FROM dbo.JobQueue AS jq
WHERE jq.in_process = 0
ORDER BY
    jq.id;

WAITFOR DELAY '00:00:02'; /*Widens the gap so you can see it*/

UPDATE
    jq
SET
    jq.in_process = 1,
    jq.claimed_at = SYSDATETIME()
FROM dbo.JobQueue AS jq
WHERE jq.id = @id;
```

Run it in two windows. Start the second within two seconds of the first, and both workers claim the same row: in the test, both claimed job 1.

Adding `AND jq.in_process = 0` to the `UPDATE` at least lets the loser find out. Its [@@ROWCOUNT](https://learn.microsoft.com/en-us/sql/t-sql/functions/rowcount-transact-sql) comes back 0, and it has to go around again.

For workers that die mid-job, part 2 of the queue series below adds columns so a restarted or surviving worker can pick up stale claims. The columns record when a job was scheduled, which app server has it, and how many attempts it's had.
