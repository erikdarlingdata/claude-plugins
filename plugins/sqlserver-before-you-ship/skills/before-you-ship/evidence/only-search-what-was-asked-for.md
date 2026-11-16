# Only search what was asked for: evidence

The card: [Only search what was asked for](../cards/only-search-what-was-asked-for.md)

A two-million-row table with one very busy user, a rare post type, and three indexes a search screen wants:

```sql
CREATE TABLE
    dbo.ForumPosts
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    owner_user_id integer NOT NULL,
    post_type_id integer NOT NULL,
    creation_date datetime NOT NULL,
    score integer NOT NULL,
    title nvarchar(200) NOT NULL,
    body nvarchar(2000) NOT NULL
);

INSERT
    dbo.ForumPosts
WITH
    (TABLOCK)
(
    id,
    owner_user_id,
    post_type_id,
    creation_date,
    score,
    title,
    body
)
SELECT
    x.id,
    owner_user_id =
        CASE
            WHEN x.id % 10 = 0
            THEN 1 /*One very busy user: 10% of all posts*/
            ELSE (ABS(CHECKSUM(NEWID())) % 100000) + 2
        END,
    post_type_id =
        CASE
            WHEN x.id % 100 = 1
            THEN 4
            WHEN x.id % 100 < 41
            THEN 1
            ELSE 2
        END,
    creation_date = DATEADD(MINUTE, x.id, CONVERT(datetime, '20090101', 112)),
    score = ABS(CHECKSUM(NEWID())) % 1000,
    title = REPLICATE(N't', 50),
    body = REPLICATE(N'b', 400)
FROM
(
    SELECT TOP (2000000)
        id = ROW_NUMBER() OVER (ORDER BY 1/0)
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

CREATE INDEX
    owner_user_id_score
ON dbo.ForumPosts
    (owner_user_id, score DESC)
INCLUDE
    (post_type_id);

CREATE INDEX
    creation_date
ON dbo.ForumPosts
    (creation_date)
INCLUDE
    (post_type_id);

CREATE INDEX
    post_type_id
ON dbo.ForumPosts
    (post_type_id)
INCLUDE
    (creation_date, owner_user_id, score);
```

The catch-all version:

```sql
CREATE OR ALTER PROCEDURE
    dbo.SearchPosts
(
    @owner_user_id integer = NULL,
    @creation_date datetime = NULL,
    @post_type_id integer = NULL
)
AS
BEGIN
    SET NOCOUNT, XACT_ABORT ON;

    SELECT TOP (5000)
        p.id,
        p.owner_user_id,
        p.score,
        p.creation_date,
        p.title,
        p.body
    FROM dbo.ForumPosts AS p
    WHERE (p.owner_user_id = @owner_user_id OR @owner_user_id IS NULL)
    AND   (p.creation_date >= @creation_date OR @creation_date IS NULL)
    AND   (p.post_type_id = @post_type_id OR @post_type_id IS NULL)
    ORDER BY
        p.score DESC,
        p.id;
END;
```

Run it in an unlucky order:

```sql
EXECUTE sys.sp_recompile
    @objname = N'dbo.SearchPosts';

EXECUTE dbo.SearchPosts
    @owner_user_id = 2; /*Compiles the plan*/

EXECUTE dbo.SearchPosts
    @creation_date = '20121015'; /*Reuses it*/
```

On **SQL Server 2022**, the first call scanned the `owner_user_id` index instead of seeking into it, about 5,600 reads. The date search reused that plan: about 6 million reads and over 3 seconds. Most of them were key lookups applying the date filter one row at a time.

**SQL Server 2025** did the same at compatibility level 160. At 170, optional parameter plan optimization split the plan on whether `@owner_user_id` was `NULL`. The user search seeked with under 100 reads. The date search got a plan of its own: about 31,500 reads and a quarter of a second.

The order still matters. After a recompile, a call for the busy user compiled a clustered index scan, and the quiet user's search reused it for about 250,000 reads. `OPTION (USE HINT ('DISABLE_OPTIONAL_PARAMETER_OPTIMIZATION'))` turns the feature off for one query.

The statement-level fix:

```sql
CREATE OR ALTER PROCEDURE
    dbo.SearchPosts
(
    @owner_user_id integer = NULL,
    @creation_date datetime = NULL,
    @post_type_id integer = NULL
)
AS
BEGIN
    SET NOCOUNT, XACT_ABORT ON;

    SELECT TOP (5000)
        p.id,
        p.owner_user_id,
        p.score,
        p.creation_date,
        p.title,
        p.body
    FROM dbo.ForumPosts AS p
    WHERE (p.owner_user_id = @owner_user_id OR @owner_user_id IS NULL)
    AND   (p.creation_date >= @creation_date OR @creation_date IS NULL)
    AND   (p.post_type_id = @post_type_id OR @post_type_id IS NULL)
    ORDER BY
        p.score DESC,
        p.id
    OPTION (RECOMPILE); /*The fix*/
END;
```

Same two calls: the user search seeked with under 100 reads, and the date search seeked into the `creation_date` index, about 25,000 reads and 40 ms.

`OPTION (RECOMPILE)` lets SQL Server treat the parameter values as constants (the parameter embedding optimization), so the predicates for `NULL` parameters drop out of the plan. `WITH RECOMPILE` on the procedure, after the parameter list, recompiles too, but without that step. In the same test it scanned every time. [Local variables hide their values](../cards/local-variables-hide-their-values.md) hits the same trap for a different reason.

The dynamic SQL version, which only adds the filters that were passed:

```sql
CREATE OR ALTER PROCEDURE
    dbo.SearchPostsDynamic
(
    @owner_user_id integer = NULL,
    @creation_date datetime = NULL,
    @post_type_id integer = NULL,
    @debug bit = 0
)
AS
BEGIN
    SET NOCOUNT, XACT_ABORT ON;

    DECLARE
        @sql nvarchar(MAX) = N'
SELECT TOP (5000)
    /*dbo.SearchPostsDynamic*/
    p.id,
    p.owner_user_id,
    p.score,
    p.creation_date,
    p.title,
    p.body
FROM dbo.ForumPosts AS p
WHERE 1 = 1',
        @parameters nvarchar(MAX) = N'
    @owner_user_id integer,
    @creation_date datetime,
    @post_type_id integer';

    IF @owner_user_id IS NOT NULL
    BEGIN
        SET @sql += N'
AND   p.owner_user_id = @owner_user_id';
    END;

    IF @creation_date IS NOT NULL
    BEGIN
        SET @sql += N'
AND   p.creation_date >= @creation_date';
    END;

    IF @post_type_id IS NOT NULL
    BEGIN
        SET @sql += N'
AND   p.post_type_id = @post_type_id';
    END;

    SET @sql += N'
ORDER BY
    p.score DESC,
    p.id;';

    IF @debug = 1
    BEGIN
        PRINT @sql; /*See exactly what's about to run*/
    END;

    /*Values travel as parameters, never concatenated into @sql*/
    EXECUTE sys.sp_executesql
        @sql,
        @parameters,
        @owner_user_id,
        @creation_date,
        @post_type_id;
END;
```

It got the same seeks as `OPTION (RECOMPILE)`, without a compile on every call, because each combination of filters gets its own cached plan. Run it with `@debug = 1` to see the query it built.

That per-combination caching is also where it can still go wrong:

```sql
DBCC FREEPROCCACHE; /*Dynamic SQL plans aren't cleared by sp_recompile. Dev server only.*/

EXECUTE dbo.SearchPostsDynamic
    @creation_date = '20090101'; /*All of history: compiles a scan*/

EXECUTE dbo.SearchPostsDynamic
    @creation_date = '20121015'; /*The last week: reuses it*/
```

The first call compiled a clustered index scan, which suits a search across all of history. The second reused it for one week of rows and took over 4 seconds, where a fresh plan seeked and finished in about 50 ms. When you know which values cause it, have the dynamic SQL add `OPTION (RECOMPILE)` for those values only.
