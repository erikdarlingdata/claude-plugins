# Table variables don't know what's in them: evidence

The card: [Table variables don't know what's in them](../cards/table-variables-don-t-know-what-s-in-them.md)

Using the two-million-row `dbo.ForumPosts` table from [Only search what was asked for](../cards/only-search-what-was-asked-for.md), first the insert:

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
