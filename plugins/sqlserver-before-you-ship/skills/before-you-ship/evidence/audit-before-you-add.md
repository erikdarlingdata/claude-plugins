# Audit before you add: evidence

The card: [Audit before you add](../cards/audit-before-you-add.md)

A table with five nonclustered indexes:

```sql
CREATE TABLE
    dbo.Accounts
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    account_number varchar(20) NOT NULL,
    region_id integer NOT NULL,
    created_date datetime2(0) NOT NULL,
    status tinyint NOT NULL,
    legacy_code varchar(20) NOT NULL
);

INSERT
    dbo.Accounts
WITH
    (TABLOCK)
(
    id,
    account_number,
    region_id,
    created_date,
    status,
    legacy_code
)
SELECT
    x.n,
    account_number = CONCAT('AC', 10000000 + x.n),
    region_id = x.n % 50,
    created_date = DATEADD(MINUTE, x.n, CONVERT(datetime2(0), '20240101', 112)),
    status = CONVERT(tinyint, x.n % 4),
    legacy_code = CONCAT('L', x.n % 1000)
FROM
(
    SELECT TOP (500000)
        n = CONVERT(integer, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

CREATE UNIQUE INDEX account_number ON dbo.Accounts (account_number);
CREATE INDEX region_id ON dbo.Accounts (region_id);
CREATE INDEX created_date ON dbo.Accounts (created_date);
CREATE INDEX status ON dbo.Accounts (status);
CREATE INDEX legacy_code ON dbo.Accounts (legacy_code);
```

Taking the database offline and back online clears its usage counters, the same way a restart does. Use your database's name in all three places:

```sql
USE master;

ALTER DATABASE
    YourDatabase
SET OFFLINE
WITH ROLLBACK IMMEDIATE;

ALTER DATABASE
    YourDatabase
SET ONLINE;

USE YourDatabase;
```

Then a few reads and an update, three times over:

```sql
SELECT
    a.id
FROM dbo.Accounts AS a
WHERE a.region_id = 7;

SELECT
    a.id
FROM dbo.Accounts AS a
WHERE a.created_date >= CONVERT(datetime2(0), '20240301', 112)
AND   a.created_date <  CONVERT(datetime2(0), '20240302', 112);

UPDATE
    a
SET
    a.status = 3
FROM dbo.Accounts AS a
WHERE a.id BETWEEN 1 AND 1000;
GO 3
```

The audit query most people write first joins to the usage DMV:

```sql
SELECT
    index_name = i.name,
    ius.user_seeks,
    ius.user_scans,
    ius.user_lookups,
    ius.user_updates
FROM sys.dm_db_index_usage_stats AS ius
JOIN sys.indexes AS i
  ON  i.object_id = ius.object_id
  AND i.index_id = ius.index_id
WHERE ius.database_id = DB_ID()
AND   ius.object_id = OBJECT_ID(N'dbo.Accounts')
ORDER BY
    i.index_id;
```

It returns four rows. `account_number` and `legacy_code` aren't there at all, because nothing has touched them since the reset, and starting from `sys.indexes` is how you find them:

```sql
SELECT
    index_name = i.name,
    user_seeks = ISNULL(ius.user_seeks, 0),
    user_scans = ISNULL(ius.user_scans, 0),
    user_lookups = ISNULL(ius.user_lookups, 0),
    user_updates = ISNULL(ius.user_updates, 0)
FROM sys.indexes AS i
LEFT JOIN sys.dm_db_index_usage_stats AS ius
  ON  ius.object_id = i.object_id
  AND ius.index_id = i.index_id
  AND ius.database_id = DB_ID()
WHERE i.object_id = OBJECT_ID(N'dbo.Accounts')
ORDER BY
    i.index_id;
```

- `account_number` and `legacy_code`: zero across the board.
- `status`: no reads and 3 updates, so all it does is cost something.
- `region_id` and `created_date`: 3 seeks each and no updates, because the update only changed `status`.

Before dropping `account_number` for having no reads, try a duplicate, then a new account, and run the left join again:

```sql
INSERT
    dbo.Accounts
(
    id,
    account_number,
    region_id,
    created_date,
    status,
    legacy_code
)
VALUES
    (500001, 'AC10000001', 1, SYSDATETIME(), 0, 'L1');

INSERT
    dbo.Accounts
(
    id,
    account_number,
    region_id,
    created_date,
    status,
    legacy_code
)
VALUES
    (500002, 'AC99999999', 1, SYSDATETIME(), 0, 'L1');
```

- The first insert failed with Msg 2601, so the unique index is doing its job, and its `user_seeks` stayed at 0.
- Both inserts, the failed one included, added an update to every index on the table.

[sp_IndexCleanup](https://github.com/erikdarlingdata/DarlingData/tree/main/sp_IndexCleanup) runs this audit across a whole database:

```sql
EXECUTE dbo.sp_IndexCleanup
    @database_name = N'YourDatabase';
```

On a server that had been up for less than a day, it didn't flag `account_number`, `legacy_code`, or `status` for removal. Its first row warned that server uptime was 0 days and usage data may be incomplete, and the rest were page compression scripts for all six indexes. Going by its README, it won't flag unused indexes until the server has been up more than seven days, and it keeps warning about them until 14.
