# Don't ask twice: evidence

The card: [Don't ask twice](../cards/don-t-ask-twice.md)

Capturing identity values from a multi-row insert:

```sql
CREATE TABLE
    dbo.OutputOrders
(
    order_id integer IDENTITY(1, 1) NOT NULL
        PRIMARY KEY CLUSTERED,
    customer_id integer NOT NULL
);

CREATE TABLE
    #new_orders
(
    order_id integer NOT NULL,
    customer_id integer NOT NULL
);

INSERT
    dbo.OutputOrders
(
    customer_id
)
OUTPUT
    Inserted.order_id,
    Inserted.customer_id
INTO #new_orders
(
    order_id,
    customer_id
)
VALUES
    (42),
    (43),
    (44);

SELECT
    n.order_id,
    n.customer_id
FROM #new_orders AS n;

SELECT
    last_identity = SCOPE_IDENTITY();
```

The `#temp` table gets all three rows, each new `order_id` next to the customer it belongs to. `SCOPE_IDENTITY()` returns 3: the last one, and nothing about the other two. And if the table has a trigger that inserts into another table with its own identity column, `@@IDENTITY` returns the trigger's value instead of yours.

Moving rows to an archive in one statement:

```sql
CREATE TABLE
    dbo.OutputOrdersArchive
(
    order_id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    customer_id integer NOT NULL
);

DELETE
    oo
OUTPUT
    Deleted.order_id,
    Deleted.customer_id
INTO dbo.OutputOrdersArchive
(
    order_id,
    customer_id
)
FROM dbo.OutputOrders AS oo
WHERE oo.customer_id = 42;
```

The delete and the archive insert happen in one statement, so a failure rolls back both. And nothing can change the rows between being saved and being deleted. For a big archive job, run it in batches, and [Think in batches](../cards/think-in-batches.md) covers how.

Where `OUTPUT` sends the rows changes the plan. A five-million-row table:

```sql
CREATE TABLE
    dbo.OutputBig
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    v integer NOT NULL,
    filler char(100) NOT NULL
        DEFAULT 'x'
);

INSERT
    dbo.OutputBig
WITH
    (TABLOCK)
(
    id,
    v
)
SELECT
    x.id,
    v = x.id % 1000
FROM
(
    SELECT TOP (5000000)
        id = ROW_NUMBER() OVER (ORDER BY 1/0)
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x;
```

The same `UPDATE` three ways. Run the block as one batch, since `@changed` only exists inside the batch that declares it, and turn on the actual execution plan:

```sql
CREATE TABLE
    #changed
(
    id integer NOT NULL,
    v integer NOT NULL
);

DECLARE
    @changed table
(
    id integer NOT NULL,
    v integer NOT NULL
);

/*Into a #temp table*/
UPDATE
    ob
SET
    ob.v += 1
OUTPUT
    Inserted.id,
    Inserted.v
INTO #changed
(
    id,
    v
)
FROM dbo.OutputBig AS ob
WHERE ob.id % 997 = 3;

/*Into a table variable*/
UPDATE
    ob
SET
    ob.v += 1
OUTPUT
    Inserted.id,
    Inserted.v
INTO @changed
(
    id,
    v
)
FROM dbo.OutputBig AS ob
WHERE ob.id % 997 = 3;

/*To the client*/
UPDATE
    ob
SET
    ob.v += 1
OUTPUT
    Inserted.id,
    Inserted.v
FROM dbo.OutputBig AS ob
WHERE ob.id % 997 = 3;
```

On **SQL Server 2025**, with cost threshold for parallelism at 50, the `#temp` table version ran in parallel at a plan cost of about 58. The table variable version ran serially, and its plan's root operator lists `NonParallelPlanReason` as `TableVariableTransactionsDoNotSupportParallelNestedTransaction`. Sending the rows to the client did the same, with DMLQueryReturnsOutputToClient, and each version updated the same 5,016 rows. On a big modification, every operator in those serial plans runs on one core.

Plain `OUTPUT`, without `INTO`, fails outright with Msg 334 if the table being modified has an enabled trigger for that action. An `UPDATE ... OUTPUT` breaks on a table with an `UPDATE` trigger, and an `INSERT` trigger doesn't bother it. The error comes at compile time, so [TRY/CATCH](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/try-catch-transact-sql) in the same scope won't catch it. `OUTPUT INTO` a `#temp` table works on the same table.
