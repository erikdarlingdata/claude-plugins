# Soft deletes are a filter on every query

Where it sits in the chart: A table > A new table > "Will rows be deleted, or just marked?" (is_deleted flags, and the filter every query needs)

A soft delete marks a row as deleted instead of removing it, usually with an `is_deleted` `bit`. From then on, every query that wants live rows has to say `is_deleted` = 0, including queries written by people who've never heard of the column. Don't count on them remembering: put a view on top with the filter written in, and another for the deleted rows if anyone needs them.

Make the flag `bit` `NOT NULL`, because a nullable `bit` has three states. And decide up front what happens to deleted rows, because until something moves them out, they sit in every index the table has.

## What it costs

A view, filtered indexes for the active rows when they're the minority, and a filtered unique index if each key can only have one active row. A plain unique constraint can't tell active rows from deleted ones: in the test, re-adding a soft-deleted email failed with Msg 2627. A unique index filtered to `is_deleted` = 0 let it back in, and still stopped a second active copy with Msg 2601.

## What it risks

Queries that don't show SQL Server the literal filter can't use the filtered indexes. A query against the table with `is_deleted` = `@is_deleted` scanned, and so did one with a literal `is_deleted` = 0 under forced parameterization. The same query through the view used the filtered index both times, because the literal in a view's definition doesn't get parameterized. [Filtered indexes need to see the filter](filtered-indexes-need-to-see-the-filter.md) has the rest of the rules.

## How fast it works

Immediate, for the queries that go through the view. With 80% of a million rows deleted, counting one month's active accounts read 5,988 pages with no index, 108 with an index on created that kept every row, and 24 with the same index filtered to active rows, which was a fifth the size. When deleted rows are a small share of the table, a filtered index buys you little besides uniqueness.

## When it backfires

Never purging. Deleted rows pile up in the clustered index and every unfiltered index, and every scan reads them. Move them to an archive table after a retention period, in batches ([Think in batches](think-in-batches.md)), so the table stays sized for the rows people actually use.

## Deeper dive

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

## Reading

- [So You Want To Implement Soft Deletes In SQL Server](https://erikdarling.com/so-you-want-to-implement-soft-deletes-in-sql-server/)
- [Considerations For Implementing Soft Deletes In SQL Server](https://erikdarling.com/considerations-for-implementing-soft-deletes/)
