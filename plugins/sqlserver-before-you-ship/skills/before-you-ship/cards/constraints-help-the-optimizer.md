# Constraints help the optimizer

Where it sits in the chart: A table > A new table > "NULLs, defaults, constraints?" (They help performance, too)

`NOT NULL`, `CHECK` constraints, and uniqueness look like correctness features. They're also information the optimizer (the part of SQL Server that picks the execution plan) gets to reason with. Declare what you know about your data and SQL Server can make better decisions and skip work. Leave everything nullable and unconstrained and it has to plan for values that may never exist.

Notice foreign keys aren't on this card. They're good for your data, but they do very little for the optimizer, and they cost you on the parent side. Every delete or key change on a parent row has to check the child table, so index the child's foreign key columns.

## What it costs

Constraints cost validation on writes, and uniqueness costs an index. That's the honest bill for data that stays trustworthy and plans that get to assume things.

## What it risks

A constraint created or re-enabled `WITH` [NOCHECK](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-table-transact-sql) is untrusted, and untrusted constraints help the optimizer not at all. You paid for the constraint and forfeited the benefit.

## How fast it works

Immediate for new tables. Trusting existing data takes a validation scan when you enable checking.

## When it backfires

`CHECK` or `DEFAULT` constraints that call scalar functions. The function runs once per row on every modification, even when it qualifies for inlining (folding the function into the query). It also keeps those modifications out of parallel plans entirely, so the constraint you added for safety becomes the slowest part of every write.

## Deeper dive

Start with a trusted `CHECK` constraint. This table only allows three status values:

```sql
CREATE TABLE
    dbo.Orders
(
    order_id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    customer_id integer NOT NULL,
    status tinyint NOT NULL
        CONSTRAINT ck_status
            CHECK (status IN (1, 2, 3)),
    amount decimal(19, 2) NOT NULL,
    filler char(200) NOT NULL
        DEFAULT ''
);

INSERT
    dbo.Orders
WITH
    (TABLOCK)
(
    order_id,
    customer_id,
    status,
    amount
)
SELECT TOP (2000000)
    x.n,
    x.n % 100000 + 1,
    x.n % 3 + 1,
    x.n % 1000
FROM
(
    SELECT
        n = ROW_NUMBER() OVER (ORDER BY 1/0)
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;
```

A stored procedure asks for a status the constraint rules out:

```sql
CREATE OR ALTER PROCEDURE
    dbo.CountStatusNine
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        c = COUNT_BIG(*)
    FROM dbo.Orders AS o
    WHERE o.status = 9;
END;
GO

/*Trusted: a Constant Scan, no reads*/
EXECUTE dbo.CountStatusNine;

/*Untrusted: disable it, then turn it back on without checking the rows*/
ALTER TABLE
    dbo.Orders
NOCHECK CONSTRAINT
    ck_status;

ALTER TABLE
    dbo.Orders
WITH NOCHECK
CHECK CONSTRAINT
    ck_status;

SELECT
    cc.name,
    cc.is_not_trusted
FROM sys.check_constraints AS cc
WHERE cc.name = N'ck_status';

EXECUTE dbo.CountStatusNine;

/*Trusted again: WITH CHECK validates every row*/
ALTER TABLE
    dbo.Orders
WITH CHECK
CHECK CONSTRAINT
    ck_status;
```

With the constraint trusted, the plan was a Constant Scan with zero reads. SQL Server knew no row could have status 9, so it didn't look. Once the `NOCHECK` pair made the constraint untrusted, the same procedure scanned the table, 57,603 reads, to find nothing. Turning it back on `WITH CHECK` read every row (57,236 reads) to prove the constraint held, and the Constant Scan came back.

The stored procedure matters. Sent as an ad hoc query against this table, simple parameterization (SQL Server swapping literals for parameters so it can reuse the plan) turned the 9 into `@1`, and the plan scanned all 57,603 pages with the constraint trusted. A real parameter did the same, because a cached plan has to work for status 1 too. `OPTION (RECOMPILE)` brought the Constant Scan back for both.

`NOT NULL` pays off with `NOT IN`. These are the same values twice, once in columns that allow `NULL`s and once in `NOT NULL` columns, and neither copy has a `NULL` in it:

```sql
/*The same values twice, once in columns that allow NULLs and once in NOT NULL columns.
  Neither copy has any NULLs in it.*/
CREATE TABLE
    dbo.CustomerIdsNullable
(
    customer_id integer NULL
);

CREATE TABLE
    dbo.CustomerIdsNotNull
(
    customer_id integer NOT NULL
);

CREATE TABLE
    dbo.OrderCustomersNullable
(
    customer_id integer NULL
);

CREATE TABLE
    dbo.OrderCustomersNotNull
(
    customer_id integer NOT NULL
);

INSERT
    dbo.CustomerIdsNullable
WITH
    (TABLOCK)
(
    customer_id
)
SELECT TOP (100000)
    ROW_NUMBER() OVER (ORDER BY 1/0)
FROM sys.all_columns AS ac1
CROSS JOIN sys.all_columns AS ac2;

INSERT
    dbo.CustomerIdsNotNull
WITH
    (TABLOCK)
(
    customer_id
)
SELECT
    cin.customer_id
FROM dbo.CustomerIdsNullable AS cin;

/*Orders for half the customers*/
INSERT
    dbo.OrderCustomersNullable
WITH
    (TABLOCK)
(
    customer_id
)
SELECT
    o.customer_id
FROM dbo.Orders AS o
WHERE o.order_id % 2 = 0;

INSERT
    dbo.OrderCustomersNotNull
WITH
    (TABLOCK)
(
    customer_id
)
SELECT
    ocn.customer_id
FROM dbo.OrderCustomersNullable AS ocn;
```

Customers with no orders, both ways:

```sql
/*Customers with no orders, against columns that allow NULLs*/
SELECT
    c = COUNT_BIG(*)
FROM dbo.CustomerIdsNullable AS ci
WHERE ci.customer_id NOT IN
(
    SELECT
        oc.customer_id
    FROM dbo.OrderCustomersNullable AS oc
);

/*The same question, against NOT NULL columns*/
SELECT
    c = COUNT_BIG(*)
FROM dbo.CustomerIdsNotNull AS ci
WHERE ci.customer_id NOT IN
(
    SELECT
        oc.customer_id
    FROM dbo.OrderCustomersNotNull AS oc
);
```

Both returned the same 50,000 customers. Against the `NOT NULL` columns, it took 45 ms. Against the nullable ones, it took 7.7 to 8 seconds.

A `NULL` in the subquery makes `NOT IN` return no rows, and a `NULL` `customer_id` on the outside can never qualify, so the nullable plan adds branches that look for `NULL`s on both sides. One of them scanned `OrderCustomersNullable` once per customer: 100,000 scans and nearly all of the time, looking for `NULL`s that weren't there.

`NOT EXISTS` against the nullable columns ran in 47 ms. [NOT EXISTS says what you mean](not-exists-says-what-you-mean.md) covers what `NOT IN` does when the `NULL`s are real.

Uniqueness lets SQL Server skip joins. This view `LEFT JOIN`s orders to two lookup tables:

```sql
CREATE TABLE
    dbo.Customers
(
    customer_id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    name nvarchar(100) NOT NULL
);

CREATE TABLE
    dbo.StatusNames
(
    status tinyint NOT NULL,
    status_name varchar(20) NOT NULL
);

INSERT
    dbo.Customers
WITH
    (TABLOCK)
(
    customer_id,
    name
)
SELECT
    ci.customer_id,
    N'Customer ' + CONVERT(nvarchar(11), ci.customer_id)
FROM dbo.CustomerIdsNotNull AS ci;

INSERT
    dbo.StatusNames
(
    status,
    status_name
)
VALUES
    (1, 'open'),
    (2, 'shipped'),
    (3, 'closed');
GO

CREATE OR ALTER VIEW
    dbo.OrderDetails
AS
SELECT
    o.order_id,
    o.amount,
    c.name,
    sn.status_name
FROM dbo.Orders AS o
LEFT JOIN dbo.Customers AS c
  ON c.customer_id = o.customer_id
LEFT JOIN dbo.StatusNames AS sn
  ON sn.status = o.status;
GO
```

A query that only wants order columns:

```sql
/*Only order columns, so neither lookup table is needed*/
SELECT
    total = SUM(od.amount)
FROM dbo.OrderDetails AS od;
```

`Customers` has a primary key, so each order matches at most one customer. A `LEFT JOIN` like that can't add rows or remove them, and nothing reads its columns, so SQL Server took it out of the plan.

`StatusNames` has three rows and nothing that says they're unique. A second row for status 1 would double every open order, so SQL Server kept that join: a hash join over 2 million orders, with an 8.5 MB memory grant, in about 140 ms. With a unique constraint on status, both joins were gone and the query took about 115 ms:

```sql
ALTER TABLE
    dbo.StatusNames
ADD CONSTRAINT
    uq_status
UNIQUE CLUSTERED
    (status);
```

No foreign key is involved. Views and queries generated by an ORM (object-relational mapper) `LEFT JOIN` to lookup tables whether the query needs them or not, and a unique key on each lookup table is what lets SQL Server skip the ones it doesn't need.

What foreign keys buy the optimizer is the same trick for inner joins. It needs a trusted foreign key on a `NOT NULL` column. Then a query that joins to the parent table but never uses its columns can skip the join entirely. It's real, and it's a very narrow benefit.

The overhead is less narrow. Deleting a parent row, or changing its key, means checking the child table for rows that point at it. If the child's foreign key column isn't indexed, that check is a scan of the child table, and it holds locks while it runs.

Cascading actions go further. `ON DELETE CASCADE` and `ON UPDATE CASCADE` run at the serializable isolation level, range locks and all. So a cascade can block far more than the rows it changes.

Optimized locking on **SQL Server 2025** shortens that. With it on, the cascade's range locks were gone when the `DELETE` finished. An insert next to the deleted rows went through in 6 ms instead of waiting 2 seconds for the open transaction. A transaction that asks for [SERIALIZABLE](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-transaction-isolation-level-transact-sql) still held its range locks to the end.

How the cascade gets planned also depends on the optimizer. Forrest McDaniel's [Cascading Delete Troubles](https://forrestmcdaniel.com/2018/11/02/cascading-delete-troubles/) shows the same delete flipping plans depending on the cardinality estimation model.

## Reading

- [Check Constraints And Query Performance In SQL Server](https://erikdarling.com/check-constraints-and-query-performance-in-sql-server/)
- [A Little About Default Constraint UDFs in SQL Server](https://erikdarling.com/a-little-about-default-constraint-udfs-in-sql-server/)
