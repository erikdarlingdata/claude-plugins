# Soft deletes are a filter on every query: evidence

The card: [Soft deletes are a filter on every query](../cards/soft-deletes-are-a-filter-on-every-query.md)

A million accounts, four out of five of them deleted, with the two pieces every soft-delete table needs from the start: a unique index that only counts active rows, and a view that only returns them:

```sql
/*A million accounts, and most of them are gone*/
CREATE TABLE
    dbo.Accounts
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    email varchar(100) NOT NULL,
    created datetime NOT NULL,
    is_deleted bit NOT NULL
        DEFAULT 0
);

INSERT
    dbo.Accounts
WITH
    (TABLOCK)
(
    id,
    email,
    created,
    is_deleted
)
SELECT
    x.id,
    email = CONCAT('user', x.id, '@example.com'),
    created = DATEADD(MINUTE, x.id, CONVERT(datetime, '20220101', 112)),
    is_deleted = CASE WHEN x.id % 5 = 0 THEN 0 ELSE 1 END
FROM
(
    SELECT TOP (1000000)
        id = CONVERT(integer, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;
GO

/*One active row per email; deleted rows don't count*/
CREATE UNIQUE INDEX
    email_active
ON dbo.Accounts
    (email)
WHERE
    (is_deleted = 0);
GO

/*Every query that wants live rows goes through here*/
CREATE VIEW
    dbo.Accounts_Active
AS
SELECT
    a.id,
    a.email,
    a.created
FROM dbo.Accounts AS a
WHERE a.is_deleted = 0;
GO
```

The filtered unique index lets a deleted email come back, and still keeps it to one active row:

```sql
/*Delete account 5, then sign the same email up again*/
UPDATE
    a
SET
    a.is_deleted = 1
FROM dbo.Accounts AS a
WHERE a.id = 5;

INSERT
    dbo.Accounts
(
    id,
    email,
    created
)
VALUES
    (1000001, 'user5@example.com', SYSDATETIME());

/*A second active row with that email*/
INSERT
    dbo.Accounts
(
    id,
    email,
    created
)
VALUES
    (1000002, 'user5@example.com', SYSDATETIME());
```

The first `INSERT` worked. The second failed with Msg 2601 on `email_active`. With a plain `UNIQUE` constraint on email instead, the first one fails too, with Msg 2627, because the deleted row still holds the value.

Then an index for the active rows, and a query that goes through the view:

```sql
CREATE INDEX
    created_active
ON dbo.Accounts
    (created)
INCLUDE
    (is_deleted)
WHERE
    (is_deleted = 0);

SELECT
    c = COUNT_BIG(*)
FROM dbo.Accounts_Active AS a
WHERE a.created >= '20230101'
AND   a.created < '20230201';
```

On **SQL Server 2025**, the count of 8,928 read 24 pages from `created_active`, which holds 200,000 rows in 476 pages. The same index without the filter holds all million rows in 2,359 pages, and the count read 108. With no index on created, it scanned the table, 5,988 pages.

The view matters for more than remembering the filter. Against the table, with `is_deleted` = `@is_deleted`, the query scanned. With the database set to forced parameterization, the literal `is_deleted` = 0 written against the table got parameterized and scanned too. Through the view, it read 24 pages either way.
