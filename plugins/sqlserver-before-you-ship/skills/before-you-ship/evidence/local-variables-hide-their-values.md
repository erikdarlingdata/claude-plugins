# Local variables hide their values: evidence

The card: [Local variables hide their values](../cards/local-variables-hide-their-values.md)

Two million votes with a lopsided spread of vote types:

```sql
/*Two million votes. Vote type 2 is 70% of them, type 11 is 10 rows, and user 1 cast a quarter of them*/
CREATE TABLE
    dbo.Votes
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    user_id integer NOT NULL,
    vote_type_id integer NOT NULL,
    created datetime NOT NULL
);

INSERT
    dbo.Votes
WITH
    (TABLOCK)
(
    id,
    user_id,
    vote_type_id,
    created
)
SELECT
    x.id,
    user_id =
        CASE
            WHEN x.id % 4 = 0
            THEN 1
            ELSE CONVERT(integer, x.id * 7919 % 400000 + 2)
        END,
    vote_type_id =
        CASE
            WHEN x.id % 200000 = 7
            THEN 11
            WHEN x.id % 10 < 7
            THEN 2
            WHEN x.id % 10 < 9
            THEN 1
            ELSE CONVERT(integer, 3 + x.id % 7)
        END,
    created = DATEADD(MINUTE, x.id, CONVERT(datetime, '20220101', 112))
FROM
(
    SELECT TOP (2000000)
        id = CONVERT(bigint, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

CREATE INDEX
    vote_type_id
ON dbo.Votes
    (vote_type_id);

CREATE INDEX
    user_id
ON dbo.Votes
    (user_id);
```

Ten distinct vote types means the average guess for any one of them is a tenth of the table, 200,000 rows. The local variable version:

```sql
/*A local variable: the plan gets built before the value is known*/
DECLARE
    @vote_type_id integer = 11;

SELECT
    v.id,
    v.user_id,
    v.created
FROM dbo.Votes AS v
WHERE v.vote_type_id = @vote_type_id
ORDER BY
    v.created DESC;

GO
```

On **SQL Server 2025**, that estimated 200,000 rows for vote type 11, which has 10. The plan scanned the clustered index in parallel, read 7,229 pages, and asked for a 19 MB grant to sort 10 rows. Change the value to 2, the 1.4 million row type, and the plan and the estimate don't move. It got the same 19 MB grant, and a sort that spilled.

The same query with a parameter:

```sql
/*The same value as a parameter*/
EXECUTE sys.sp_executesql
    N'
SELECT
    v.id,
    v.user_id,
    v.created
FROM dbo.Votes AS v
WHERE v.vote_type_id = @vote_type_id
ORDER BY
    v.created DESC;',
    N'@vote_type_id integer',
    @vote_type_id = 11;
```

For vote type 11 it estimated 10 rows, seeked the `vote_type_id` index, did 10 lookups, and read 33 pages. For vote type 2 it estimated 1.4 million and got a 127 MB grant. **SQL Server 2022** and later, at compatibility level 160 or higher, can also keep separate plans for rare and common values of a parameter. The feature is Parameter Sensitive Plan Optimization, and it did that here, but a local variable never qualifies for that.

When the value has to be computed in the batch, a statement-level recompile lets the optimizer see it:

```sql
/*Or let the statement see the variable's value*/
DECLARE
    @vote_type_id integer = 11;

SELECT
    v.id,
    v.user_id,
    v.created
FROM dbo.Votes AS v
WHERE v.vote_type_id = @vote_type_id
ORDER BY
    v.created DESC
OPTION (RECOMPILE);

GO
```

Same estimates and plans as the parameter version, at the cost of a compile every time it runs.

Ranges get a flat guess too. `WHERE v.created >= @created` estimated 600,000 rows, 30% of the table, whether 421,761 or 1,955,361 rows came back.

And the version that looks like a fix:

```sql
CREATE OR ALTER PROCEDURE
    dbo.VotesByType
(
    @vote_type_id integer
)
WITH RECOMPILE
AS
BEGIN
    SET NOCOUNT, XACT_ABORT ON;

    DECLARE
        @vote_type_id_inner integer = @vote_type_id;

    SELECT
        v.id,
        v.user_id,
        v.created
    FROM dbo.Votes AS v
    WHERE v.vote_type_id = @vote_type_id_inner
    ORDER BY
        v.created DESC;
END;
```

Both vote types got the 200,000-row estimate and the parallel scan. [Dev lied to you](../cards/dev-lied-to-you.md) covers why copying parameters into variables is the wrong answer to parameter sniffing.
