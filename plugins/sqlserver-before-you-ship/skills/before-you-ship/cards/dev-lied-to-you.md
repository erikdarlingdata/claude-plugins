# Dev lied to you

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "It worked in dev" (Row counts, parameters, statistics)

A thousand rows and one friendly test parameter tell you nothing. Parameterized code gets one cached plan, built for whatever values it was last compiled with. A plan sized for the small case reused for the big case is a disaster. And it's a disaster you cannot see in dev because dev doesn't have the big case.

The other direction hides until there's load: a plan sized for the big case, reused for the small ones, only looks wasteful one call at a time. Under concurrency, every small call asks for the big plan's memory grant and parallel threads at once, and they queue for both.

## What it costs

Testing properly means testing selective and non-selective parameters (values that match few rows or many) in both execution orders. Both orders matter because plan reuse means whoever compiles first sets the plan for everyone after. Then run the small values concurrently with the big plan cached, because one call at a time won't show you the queue.

## What it risks

The local-variable "fix" for parameter sniffing (planning around the compile-time values) swaps the sniffed estimate for an average guess that's the same for every value. That's usually worse, and wrong the same way every time. [OPTIMIZE FOR UNKNOWN](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query) is the same trick in a costume, and both are red flags.

## How fast it works

An index that makes the plan shape stable across parameter values is the fastest lasting fix when there is one. Often there isn't, because no single plan is good for every value. Then dynamic SQL can give each bucket of values its own plan, with hints that fit the bucket, or a `#temp` table can hold the parameter-sensitive part so the rest of the query plans for the rows that actually came back. `RECOMPILE` works immediately too, but charges a compile on every execution.

## When it backfires

Buckets are a snapshot of your data. When the data shifts, a value can drift into the wrong bucket and nothing warns you, so check the counts behind them now and then. And the biggest outlier can be too big for a `#temp` table. In the test, `VoteTypeId` 2 took about 0.9 seconds through the `#temp` table against about 0.5 seconds with its own plan, which is why the course's hybrid version sends it down the original query instead.

## Deeper dive

From the course, on the `StackOverflow2013` database. One procedure, one parameter. `VoteTypeId` 4 is rare. `VoteTypeId` 2 is about 37 million rows. The indexes it runs with:

```sql
CREATE INDEX
    OwnerUserId_PostTypeId
ON dbo.Posts
    (OwnerUserId, PostTypeId)
WHERE
    (PostTypeId = 1)
WITH
    (SORT_IN_TEMPDB = ON, DATA_COMPRESSION = PAGE);

CREATE INDEX
    VoteTypeId_UserId_PostId
ON dbo.Votes
    (VoteTypeId, UserId, PostId)
INCLUDE
    (BountyAmount, CreationDate)
WITH
    (SORT_IN_TEMPDB = ON, DATA_COMPRESSION = PAGE);

CREATE INDEX
    UserId
ON dbo.Badges
    (UserId)
WITH
    (SORT_IN_TEMPDB = ON, DATA_COMPRESSION = PAGE);
```

The procedure:

```sql
CREATE OR ALTER PROCEDURE
    dbo.VoteSniffing
(
    @VoteTypeId integer
)
AS
BEGIN
    SET XACT_ABORT, NOCOUNT ON;

    SELECT
        UserId = ISNULL(v.UserId, 0),
        Votes2013 =
            SUM
            (
                CASE
                    WHEN v.CreationDate >= '20130101'
                    AND  v.CreationDate < '20140101'
                    THEN 1
                    ELSE 0
                END
            ),
        BountyCount =
            SUM
            (
                CASE
                    WHEN v.BountyAmount IS NULL
                    THEN 0
                    ELSE 1
                END
            ),
        PostCount = COUNT_BIG(DISTINCT v.PostId),
        VoteTypeId = @VoteTypeId
    FROM dbo.Votes AS v
    WHERE v.VoteTypeId = @VoteTypeId
    AND NOT EXISTS
        (
            SELECT
                1/0
            FROM dbo.Posts AS p
            JOIN dbo.Badges AS b
              ON b.UserId = p.OwnerUserId
            WHERE p.OwnerUserId = v.UserId
            AND   p.PostTypeId = 1
        )
    GROUP BY
        v.UserId
    ORDER BY
        PostCount DESC;
END;
```

Run it both ways, and recompile in between so each order starts clean:

```sql
/*Small to big*/
EXECUTE sys.sp_recompile
    @objname = N'dbo.VoteSniffing';

EXECUTE dbo.VoteSniffing
    @VoteTypeId = 4; /*Does fine to start*/

EXECUTE dbo.VoteSniffing
    @VoteTypeId = 2; /*Reuses the plan for 4, totally eats it*/

/*Big to small*/
EXECUTE sys.sp_recompile
    @objname = N'dbo.VoteSniffing';

EXECUTE dbo.VoteSniffing
    @VoteTypeId = 2; /*Much better start*/

EXECUTE dbo.VoteSniffing
    @VoteTypeId = 4; /*Reuses the plan for 2, a total waste*/
```

Small first, the plan built for a rare value gets reused for 37 million rows, and it falls over.

Big first, `VoteTypeId` 2 starts much better, and then 4 inherits a big parallel plan with a memory grant of around 3 GB. It takes about 100 ms where its own plan took 0 ms, which is a lot of server for a query that needed almost none. On **Enterprise edition**, memory grant feedback can shrink that inherited grant on later runs, once SQL Server sees how little of it got used, but the parallel plan stays.

Neither order is safe, which is why testing has to cover both.

Big first only looks wasteful one call at a time, and it falls over under load. To show that, a synthetic copy of these three tables ran on a 2-core test server with about 1.4 GB of memory for query grants: 3 million votes, with `VoteTypeId` 2 at 2.1 million rows and 4 at 100. Run alone, 4 took 1 ms on its own serial plan, and 47 to 80 ms on the plan compiled for 2, a parallel hash plan with a 33 to 39 MB memory grant.

Then 60 sessions ran `VoteTypeId` 4 five times each, all at once, which is the kind of load ostress (from Microsoft's RML Utilities) is good for. With 4's own plan cached, that managed 79 to 90 calls a second. With 2's plan cached, it managed 7.4 to 7.9, and the median call took over 7 seconds. Up to 55 sessions at a time sat waiting for a memory grant ([RESOURCE_SEMAPHORE](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-os-wait-stats-transact-sql) waits), and thousands of `THREADPOOL` waits piled up behind the parallel threads.

Memory grant feedback had already cut that grant from 305 MB to under 40 MB after a single run, and it still wasn't enough.

Parameter Sensitive Plan Optimization (**SQL Server 2022** and later, at compatibility level 160 or higher) doesn't help here, because the `Votes` histogram isn't skewed enough by its rules. It only steps in when the gap between the most and least common values in the histogram is wide enough. In the course, inserting a single row with a brand-new `VoteTypeId` widens that gap, and the feature kicks in.

When no index makes one plan good for every value, give the values different plans. Dynamic SQL does that by giving each group of values its own query text, because different text gets a different cached plan, and it can add a hint that fits each group. Here, the groups come from the course's lists of slow and fast vote types, and each one is optimized for a value that represents it:

```sql
CREATE OR ALTER PROCEDURE
    dbo.VoteSniffing
(
    @VoteTypeId integer
)
AS
BEGIN
    SET XACT_ABORT, NOCOUNT ON;

    DECLARE
        @sql nvarchar(MAX) = N'
SELECT
    UserId = ISNULL(v.UserId, 0),
    Votes2013 =
        SUM
        (
            CASE
                WHEN v.CreationDate >= ''20130101''
                AND  v.CreationDate < ''20140101''
                THEN 1
                ELSE 0
            END
        ),
    BountyCount =
        SUM
        (
            CASE
                WHEN v.BountyAmount IS NULL
                THEN 0
                ELSE 1
            END
        ),
    PostCount = COUNT_BIG(DISTINCT v.PostId),
    VoteTypeId = @VoteTypeId
FROM dbo.Votes AS v
WHERE v.VoteTypeId = @VoteTypeId
AND NOT EXISTS
    (
        SELECT
            1/0
        FROM dbo.Posts AS p
        JOIN dbo.Badges AS b
          ON b.UserId = p.OwnerUserId
        WHERE p.OwnerUserId = v.UserId
        AND   p.PostTypeId = 1
    )
GROUP BY
    v.UserId
ORDER BY
    PostCount DESC';

    /*Each bucket gets its own query text, so its own plan, built for a value that fits*/
    IF @VoteTypeId = 2
    BEGIN
        SET @sql += N'
OPTION (OPTIMIZE FOR (@VoteTypeId = 2));';
    END;
    ELSE IF @VoteTypeId IN (1, 3, 5, 10)
    BEGIN
        SET @sql += N'
OPTION (OPTIMIZE FOR (@VoteTypeId = 1));';
    END;
    ELSE
    BEGIN
        SET @sql += N'
OPTION (OPTIMIZE FOR (@VoteTypeId = 4));';
    END;

    EXECUTE sys.sp_executesql
        @sql,
      N'@VoteTypeId integer',
        @VoteTypeId;
END;
```

On the synthetic copy, every value got a plan that fit it, in either order: 4 in 0 to 1 ms, 2 in 380 to 430 ms, and 1, 3, and 5 in 58 to 98 ms on the plan built for 1.

Separate buckets without the hints still left a gap, because whoever compiled a bucket first set its plan. When 5 compiled the middle bucket's plan, 1 took 670 ms on it instead of about 100.

Under the same 60-session load, with 2 compiled first, the dynamic version kept up 76 to 87 calls a second with no grant waits.

The other way is to fence off the part that cares about the parameter. Put the rows for this vote type into a `#temp` table first, then run the rest of the query against the temp table, which has statistics and a row count of its own:

```sql
CREATE OR ALTER PROCEDURE
    dbo.VoteSniffing
(
    @VoteTypeId integer
)
AS
BEGIN
    SET XACT_ABORT, NOCOUNT ON;

    CREATE TABLE
        #votes
    (
        UserId integer NULL UNIQUE CLUSTERED,
        Votes2013 integer NOT NULL,
        BountyCount integer NOT NULL,
        PostCount bigint NOT NULL
    );

    /*The part that cares about @VoteTypeId*/
    INSERT
        #votes
    WITH
        (TABLOCKX)
    (
        UserId,
        Votes2013,
        BountyCount,
        PostCount
    )
    SELECT
        UserId = v.UserId,
        Votes2013 =
            SUM
            (
                CASE
                    WHEN v.CreationDate >= '20130101'
                    AND  v.CreationDate < '20140101'
                    THEN 1
                    ELSE 0
                END
            ),
        BountyCount =
            SUM
            (
                CASE
                    WHEN v.BountyAmount IS NULL
                    THEN 0
                    ELSE 1
                END
            ),
        PostCount = COUNT_BIG(DISTINCT v.PostId)
    FROM dbo.Votes AS v
    WHERE v.VoteTypeId = @VoteTypeId
    GROUP BY
        v.UserId;

    /*The rest, against however many rows actually came back*/
    SELECT
        UserId = ISNULL(v.UserId, 0),
        v.Votes2013,
        v.BountyCount,
        v.PostCount,
        VoteTypeId = @VoteTypeId
    FROM #votes AS v
    WHERE NOT EXISTS
        (
            SELECT
                1/0
            FROM dbo.Posts AS p
            JOIN dbo.Badges AS b
              ON b.UserId = p.OwnerUserId
            WHERE p.OwnerUserId = v.UserId
            AND   p.PostTypeId = 1
        )
    ORDER BY
        v.PostCount DESC;
END;
```

The final `SELECT` recompiled when the temp table's row count changed enough, so it always planned for the rows that came back, and `VoteTypeId` 4 never inherited the parallel plan. After 2 ran first, 4 took 1 ms, and under the 60-session load it kept up 60 to 84 calls a second with no grant waits.

The `INSERT` can still be sensitive, but it's a much simpler query, so the damage is smaller. Compiled for 4, it took 2.1 seconds for `VoteTypeId` 2 against 0.9 seconds with its own plan, which still beats the 8 seconds 2 took on the original procedure's plan for 4.

There are plenty of other flavors, and the course has several of them:

- an `IF` branch that sends the biggest value down the original query and everything else through the `#temp` table
- separate procedures for the outliers
- `OPTIMIZE FOR` one specific value
- `RECOMPILE` only for the values that need it

The average guess has two flavors. For an equality predicate it comes from the statistics' density vector: one value for how many rows an average key returns. For a range predicate it's a fixed percentage of the table. Neither one looks at the value you passed.

## Reading

- [What Parameter Sniffing Looks Like In SQL Server's Plan Cache](https://erikdarling.com/what-parameter-sniffing-looks-like-in-the-plan-cache/)
- [Yet Another Post About Local Variables In SQL Server](https://go.erikdarling.com/LocalVariables)
- [Defeating Parameter Sniffing With Dynamic SQL In SQL Server](https://erikdarling.com/defeating-parameter-sniffing-with-dynamic-sql/)
- [All About SQL Server Stored Procedures: Dynamic SQL For Performance](https://erikdarling.com/all-about-sql-server-stored-procedures-dynamic-sql-for-performance/)
