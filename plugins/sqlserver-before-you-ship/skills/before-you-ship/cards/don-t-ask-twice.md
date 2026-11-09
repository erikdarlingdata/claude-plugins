# Don't ask twice

Where it sits in the chart: A query > No NOLOCK > It changes data > "Do you need the rows you just changed?" (New identity values, archiving, before-and-after)

When code needs to know what a modification did, the usual move is a second query. That's `SELECT MAX(id)` afterward to find the row you just inserted, or a `SELECT` beforehand to save what a `DELETE` is about to remove. That second query is a race. Other sessions can change the table in between, and `SELECT MAX(id)` will happily hand you someone else's row.

[OUTPUT](https://learn.microsoft.com/en-us/sql/t-sql/queries/output-clause-transact-sql) returns the rows a modification touched as part of the modification itself. You get every generated identity value, every deleted row, the before and after of every update. [SCOPE_IDENTITY](https://learn.microsoft.com/en-us/sql/t-sql/functions/scope-identity-transact-sql)() is fine for one row, and it only ever gives you one value.

## What it costs

Next to nothing for a handful of rows. On big modifications, the destination matters: `OUTPUT` to the client, or into a table variable, forces the whole statement to run serially. `OUTPUT INTO` a `#temp` table leaves parallelism available.

## What it risks

`OUTPUT INTO` comes with rules for its target, `#temp` tables included. It can't have enabled triggers or `CHECK` constraints, and it can't be on either side of a foreign key. And the rows come back in no guaranteed order, so don't match them to your input by position. To tie new identity values back to source rows, use the [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql) trick on [What MERGE does better](what-merge-does-better.md).

## How fast it works

Immediately: one statement instead of two, and no gap for another session to slip into.

## When it backfires

Someone adds a trigger later. Every plain `OUTPUT` statement for that trigger's action starts failing with Msg 334, in code nobody changed. That's how EF Core 7 broke saves on tables with triggers: `SaveChanges` uses `OUTPUT`, and developers had to configure those tables with `HasTrigger`. `OUTPUT INTO` a `#temp` table keeps working. And on its own, `OUTPUT` is a poor audit trail: it only records changes made by the statements you remembered to add it to.

## Deeper dive

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

The delete and the archive insert happen in one statement, so a failure rolls back both. And nothing can change the rows between being saved and being deleted. For a big archive job, run it in batches, and [Think in batches](think-in-batches.md) covers how.

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

## Reading

- [Miscellaneous notes for SQL Server: SaveChanges and the OUTPUT clause](https://learn.microsoft.com/en-us/ef/core/providers/sql-server/misc) (Microsoft Learn, EF Core)
