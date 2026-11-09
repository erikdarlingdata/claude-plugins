# Table variables don't know what's in them

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Using a table variable?" (@table instead of #temp, and why people pick it)

People pick table variables because they think they live in memory, or that they win under some magic number of rows. They're in tempdb like `#temp` tables, and no row count makes them safe.

What they're missing is statistics. SQL Server never knows what values a table variable holds, even with an index on it. Below compatibility level 150 (**SQL Server 2019**), it doesn't know how many rows it holds either, so it guesses one unless the statement recompiles. On every version, any modification to one runs single-threaded.

For intermediate results that feed another query, a `#temp` table is the better default.

## What it costs

Almost nothing to switch: `CREATE TABLE #name` instead of `DECLARE @name` table. A `#temp` table brings statistics, and statistics bring recompiles as its contents change, which is the point.

## What it risks

Code that runs constantly. A procedure called thousands of times a minute can lose more to tempdb contention from `#temp` tables than it ever lost to table variable estimates. That's the one case the first post below makes for table variables, so measure that one before you switch.

The other risk is `ROLLBACK`. Rows in a table variable survive one, and rows in a `#temp` table don't. So error logging that collects rows in a table variable inside a transaction stops working after the switch.

## How fast it works

The next compile. In a test at compatibility level 140, a join from 1,000 rows in a table variable to a two-million-row table took 2 to 4 seconds. The plan had a one-row estimate and a spill (its memory grant was too small, so it wrote to tempdb). The same rows in a `#temp` table took 1 to 1.7 seconds.

## When it backfires

`#temp` tables in stored procedures are cached between calls, and so are their statistics. When a call inserts different values, but not enough extra rows to trigger a recompile, it reuses the plan built from an earlier call's statistics. In a test, it kept a nested loops plan (one lookup per row) built for quiet users, and spilled once the busy user showed up. [UPDATE STATISTICS](https://learn.microsoft.com/en-us/sql/t-sql/statements/update-statistics-transact-sql) on the `#temp` table, plus `OPTION` ([RECOMPILE](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query)) on the query that reads it, fixed it.

## Deeper dive

Using the two-million-row `dbo.ForumPosts` table from [Only search what was asked for](only-search-what-was-asked-for.md), first the insert:

```sql
/*Table variable: the whole plan runs on one thread*/
DECLARE
    @posts table
(
    id integer NOT NULL,
    owner_user_id integer NOT NULL,
    score integer NOT NULL
);

INSERT
    @posts
(
    id,
    owner_user_id,
    score
)
SELECT
    p.id,
    p.owner_user_id,
    p.score
FROM dbo.ForumPosts AS p
WHERE p.score > 500;
GO

/*#temp table: free to go parallel*/
CREATE TABLE
    #posts
(
    id integer NOT NULL,
    owner_user_id integer NOT NULL,
    score integer NOT NULL
);

INSERT
    #posts
WITH
    (TABLOCK)
(
    id,
    owner_user_id,
    score
)
SELECT
    p.id,
    p.owner_user_id,
    p.score
FROM dbo.ForumPosts AS p
WHERE p.score > 500;
```

On **SQL Server 2022**, the table variable insert ran serially, with a `NonParallelPlanReason` of `TableVariableTransactionsDoNotSupportParallelNestedTransaction`, and took about 1.2 seconds. The `#temp` table insert ran in parallel in under 300 ms. Timings in this dive were taken with actual plans off.

Feeding a table variable through `INSERT ... EXEC` or dynamic SQL lets the query underneath go parallel, but the insert itself stays on one thread. It was slower overall: 4.2 to 4.7 seconds with `INSERT ... EXEC`, against 1.2 to 1.4 for the plain insert.

Then the estimates, with one busy user among 1,000:

```sql
DECLARE
    @owners table
(
    owner_user_id integer NOT NULL
        PRIMARY KEY
);

/*1,000 users, and one of them is the busy one*/
INSERT
    @owners
(
    owner_user_id
)
SELECT DISTINCT TOP (1000)
    p.owner_user_id
FROM dbo.ForumPosts AS p
ORDER BY
    p.owner_user_id;

SELECT TOP (1000)
    p.id,
    p.score,
    p.title,
    p.body
FROM @owners AS o
JOIN dbo.ForumPosts AS p
  ON p.owner_user_id = o.owner_user_id
ORDER BY
    p.score DESC,
    p.id;
```

At compatibility level 140, the table variable's estimate was 1 row, and the join came out at 27 rows against 217,949 actual. The plan was serial nested loops with a 1.2 MB memory grant that spilled, and took 2 to 4 seconds in testing.

Swap in `CREATE TABLE #owners` for the `DECLARE`, and `#owners` for `@owners`. The `#temp` table version estimated 220,999 rows, used a hash join, and finished in 1 to 1.7 seconds.

At compatibility level 150 and up, table variable deferred compilation fixes the row count, 1,000, but not the contents. The join estimate was still 27,376, and the plan still spilled.

Deferred compilation happens once, though. At compatibility level 150 or higher, in a procedure:

```sql
CREATE OR ALTER PROCEDURE
    dbo.OwnerPostsTv
(
    @first_owner integer,
    @owner_count integer
)
AS
BEGIN
    SET NOCOUNT, XACT_ABORT ON;

    DECLARE
        @owners table
    (
        owner_user_id integer NOT NULL
            PRIMARY KEY
    );

    INSERT
        @owners
    (
        owner_user_id
    )
    SELECT DISTINCT TOP (@owner_count)
        p.owner_user_id
    FROM dbo.ForumPosts AS p
    WHERE p.owner_user_id >= @first_owner
    ORDER BY
        p.owner_user_id;

    SELECT TOP (1000)
        p.id,
        p.score,
        p.title,
        p.body
    FROM @owners AS o
    JOIN dbo.ForumPosts AS p
      ON p.owner_user_id = o.owner_user_id
    ORDER BY
        p.score DESC,
        p.id;
END;
GO

EXECUTE sys.sp_recompile
    @objname = N'dbo.OwnerPostsTv';

EXECUTE dbo.OwnerPostsTv
    @first_owner = 2,
    @owner_count = 5; /*Compiles the plan for 5 rows*/

EXECUTE dbo.OwnerPostsTv
    @first_owner = 1,
    @owner_count = 1000; /*Reuses it for 1,000*/
```

The plan compiled for 5 rows got reused for 1,000: the same 5-row estimate, a 1.7 MB grant, and a spill.

`#temp` tables in procedures have their own version of that, because SQL Server caches them between calls, statistics included (Paul White's posts below explain how). This is the fixed version:

```sql
CREATE OR ALTER PROCEDURE
    dbo.OwnerPostsTemp
(
    @first_owner integer,
    @owner_count integer
)
AS
BEGIN
    SET NOCOUNT, XACT_ABORT ON;

    CREATE TABLE
        #owners
    (
        owner_user_id integer NOT NULL
            PRIMARY KEY
    );

    INSERT
        #owners
    (
        owner_user_id
    )
    SELECT DISTINCT TOP (@owner_count)
        p.owner_user_id
    FROM dbo.ForumPosts AS p
    WHERE p.owner_user_id >= @first_owner
    ORDER BY
        p.owner_user_id;

    /*Fresh statistics for this call's rows*/
    UPDATE STATISTICS
        #owners;

    SELECT TOP (1000)
        p.id,
        p.score,
        p.title,
        p.body
    FROM #owners AS o
    JOIN dbo.ForumPosts AS p
      ON p.owner_user_id = o.owner_user_id
    ORDER BY
        p.score DESC,
        p.id
    OPTION (RECOMPILE); /*So the plan uses them*/
END;
GO

EXECUTE sys.sp_recompile
    @objname = N'dbo.OwnerPostsTemp';

EXECUTE dbo.OwnerPostsTemp
    @first_owner = 2,
    @owner_count = 1000; /*1,000 quiet users*/

EXECUTE dbo.OwnerPostsTemp
    @first_owner = 1,
    @owner_count = 1000; /*1,000 users, busy one included*/
```

Without the two marked lines, the second call reused a nested loops plan built from the first call's statistics on quiet users, and spilled. With them, it got a hash join and a 693 MB grant that fit.

## Reading

- [When Should You Use Table Variables In SQL Server? When Queries Execute Thousands Of Times A Minute](https://erikdarling.com/when-should-you-use-table-variables/)
- [Temporary Table Caching Explained](https://www.sql.kiwi/2012/08/temporary-object-caching-explained/) (Paul White)
- [Temporary Table Caching in Stored Procedures](https://www.sql.kiwi/2012/08/temporary-tables-in-stored-procedures/) (Paul White)
