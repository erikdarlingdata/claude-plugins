# Ask for less

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "How much data are you asking for?" (SELECT *, wide rows)

`SELECT *` is a bad habit, and I say that as someone who types it in demos and apologizes for it.

Every column you drag along makes the query harder to cover with an index (an index that holds every column the query needs). It also makes a narrow nonclustered index less of a guarantee. Every row the index finds needs a key lookup, a trip back to the table for the columns the index doesn't have, and the optimizer weighs all those lookups against scanning the table instead. Which one wins changes with the parameter values, and that's how `SELECT *` contributes to [parameter sensitivity](dev-lied-to-you.md).

And it inflates the memory grant: memory a query reserves up front to sort or hash rows. SQL Server sizes the grant from estimates of how many rows there are and how wide they are. Row width is a tax on everything downstream of the read.

## What it costs

On a new query, typing out the columns you need, and nothing at runtime.

## What it risks

On a query that already runs, removing columns is a contract change: something downstream might read them. Check [Who else depends on this?](mind-your-query-consumers.md) before you trim.

## How fast it works

The next execution. A narrower select gets a smaller memory grant. SQL Server estimates variable-length columns at half their declared size, and each `MAX` column at about 4,000 bytes. So a few `MAX` columns you never needed can turn a small query into a grant hog that makes other queries wait.

## When it backfires

When your queries don't use indexes they could, and use way more memory than they should.

## Deeper dive

A table with a few string columns, and a narrow index on `customer_id`. Customer 1 has 100,000 orders and customer 3 has 20:

```sql
CREATE TABLE
    dbo.Orders
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    customer_id integer NOT NULL,
    order_date datetime2(0) NOT NULL,
    amount decimal(19, 2) NOT NULL,
    status varchar(20) NOT NULL,
    ship_to nvarchar(200) NOT NULL,
    notes nvarchar(max) NULL
);

INSERT
    dbo.Orders
WITH
    (TABLOCK)
(
    id,
    customer_id,
    order_date,
    amount,
    status,
    ship_to,
    notes
)
SELECT
    x.n,
    customer_id =
        CASE
            WHEN x.n % 10 = 0
            THEN 1
            ELSE x.n % 50000 + 2
        END,
    order_date = DATEADD(MINUTE, x.n, CONVERT(datetime2(0), '20240101', 112)),
    amount = CONVERT(decimal(19, 2), x.n % 1000),
    status =
        CASE x.n % 3
            WHEN 0 THEN 'shipped'
            WHEN 1 THEN 'open'
            ELSE 'returned'
        END,
    ship_to = CONCAT(N'Suite ', x.n % 900, N', Long Street'),
    notes =
        CASE
            WHEN x.n % 5 = 0
            THEN N'call first'
        END
FROM
(
    SELECT TOP (1000000)
        n = CONVERT(integer, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;

CREATE INDEX
    customer_id
ON dbo.Orders
    (customer_id);
```

Two queries that read the same 50,000 rows, one asking for three columns and one asking for all of them:

```sql
SELECT
    o.id,
    o.order_date,
    o.amount
FROM dbo.Orders AS o
WHERE o.id <= 50000
ORDER BY
    o.amount DESC;

SELECT
    o.*
FROM dbo.Orders AS o
WHERE o.id <= 50000
ORDER BY
    o.amount DESC;
```

On **SQL Server 2025**, both sorted the same 50,000 rows:

- Three columns: one thread, 577 pages read, estimated at 26 bytes a row, a 6.5 MB memory grant, 3 MB used.
- Every column: two threads, 603 pages read, estimated at 4,272 bytes a row, a 289 MB memory grant, 7 MB used.

The estimate comes from each column's declared type, not from what's in it, which shows when you add the columns one at a time:

```sql
SELECT
    o.id,
    o.amount
FROM dbo.Orders AS o
WHERE o.id <= 50000
ORDER BY
    o.amount DESC;

SELECT
    o.id,
    o.amount,
    o.status
FROM dbo.Orders AS o
WHERE o.id <= 50000
ORDER BY
    o.amount DESC;

SELECT
    o.id,
    o.amount,
    o.ship_to
FROM dbo.Orders AS o
WHERE o.id <= 50000
ORDER BY
    o.amount DESC;

SELECT
    o.id,
    o.amount,
    o.notes
FROM dbo.Orders AS o
WHERE o.id <= 50000
ORDER BY
    o.amount DESC;
```

- `id` and `amount`: 20 bytes a row.
- Adding `status`, a `varchar(20)`: 34 bytes, half its declared size plus a few bytes of row overhead.
- Adding `ship_to`, an `nvarchar(200)` that can hold 400 bytes: 224 bytes. The longest value in it is 44.
- Adding `notes`, an `nvarchar(max)`: 4,048 bytes, and a 274 MB grant on its own. The longest value in it is 20 bytes.

Every column also changes what the index is good for:

```sql
SELECT
    o.*
FROM dbo.Orders AS o
WHERE o.customer_id = 3;

SELECT
    o.*
FROM dbo.Orders AS o
WHERE o.customer_id = 1;

SELECT
    o.id,
    o.customer_id
FROM dbo.Orders AS o
WHERE o.customer_id IN (1, 3);
```

- Customer 3 got a seek on `customer_id` and 20 key lookups: 63 reads.
- Customer 1 got a scan of the whole table, 11,490 pages, because 100,000 key lookups would have cost more.
- The last query asks only for columns the index holds, so it sought for both customers: 181 reads.

Put the `SELECT *` version in a stored procedure, and whichever customer compiles it first picks the plan for the other:

```sql
CREATE OR ALTER PROCEDURE
    dbo.OrdersByCustomer
(
    @customer_id integer
)
AS
BEGIN
    SET NOCOUNT ON;

    SELECT
        o.*
    FROM dbo.Orders AS o
    WHERE o.customer_id = @customer_id;
END;
```

```sql
EXECUTE dbo.OrdersByCustomer
    @customer_id = 3;

EXECUTE dbo.OrdersByCustomer
    @customer_id = 1;
```

Compiled for customer 3, customer 1 reused the seek and did 100,000 key lookups: 300,177 reads in about 400 ms, against 11,490 for the scan.

```sql
EXECUTE sys.sp_recompile
    @objname = N'dbo.OrdersByCustomer';

EXECUTE dbo.OrdersByCustomer
    @customer_id = 1;

EXECUTE dbo.OrdersByCustomer
    @customer_id = 3;
```

Compiled for customer 1, customer 3 reused the scan and read 11,490 pages to return 20 rows. Parameter Sensitive Plan Optimization didn't step in either way.

## Reading

- [All The Performance Problems With Select * Queries In SQL Server](https://erikdarling.com/all-the-problems-with-select/)
- [Learn T-SQL With Erik: TOP and OFFSET/FETCH](https://erikdarling.com/learn-t-sql-with-erik-top-and-offset-fetch/)
