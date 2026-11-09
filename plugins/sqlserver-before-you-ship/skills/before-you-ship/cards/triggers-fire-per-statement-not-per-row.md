# Triggers fire per statement, not per row

Where it sits in the chart: A query > No NOLOCK > It changes data > "Is there a trigger on the table?" (Writing one, or modifying a table that has one)

Triggers get more hate than almost anything in SQL Server, and a lot of it is developers blaming the hammer for being blunt. A DML trigger (a trigger on `INSERT`, `UPDATE`, or `DELETE`) fires once per statement, not once per row. It runs inside the transaction that fired it, so its work and its locks are part of your modification.

Write every trigger as if `Inserted` and `Deleted` (the trigger's tables of new and old rows) hold a million rows, because one day they will. One trigger per action is shorter and harder to get wrong than one trigger juggling inserts, updates, and deletes.

## What it costs

Every statement against the table now does the trigger's work too, inside the same transaction, and holds locks for longer. Join to `Inserted` and `Deleted` in one set-based statement (all rows at once).

## What it risks

`SELECT @id = i.id FROM Inserted` grabs one row and silently ignores the rest. It passes every single-row test you'll ever write, so test triggers with multi-row modifications. And `IF` [UPDATE(column)](https://learn.microsoft.com/en-us/sql/t-sql/functions/update-trigger-functions-transact-sql) only means the column was in the `SET` list, so compare `Inserted` to `Deleted` to find the rows that actually changed.

## How fast it works

Set-based trigger code costs about one extra statement per modification. A cursor (a row-by-row loop) in a trigger scales with the row count, and the difference shows up the first time someone updates the whole table.

## When it backfires

Trusting the row-count early exit (`IF` [ROWCOUNT_BIG](https://learn.microsoft.com/en-us/sql/t-sql/functions/rowcount-big-transact-sql)() = 0 `RETURN`) under [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql). A `MERGE` fires your trigger for each action it handles that has a `WHEN` clause in the statement, even when that clause touched no rows, and `ROWCOUNT_BIG()` reports the whole `MERGE`'s count. Check whether `Inserted` or `Deleted` have rows instead of trusting the count.

## Deeper dive

The bug that ships most often, from the course, on a table of 255 rows:

```sql
CREATE TABLE
    dbo.create_me
(
    id tinyint NOT NULL
        PRIMARY KEY CLUSTERED,
    some_value integer NOT NULL,
    some_column datetime2(7) NULL
);

INSERT
    dbo.create_me
(
    id,
    some_value
)
SELECT TOP (255)
    id = ROW_NUMBER() OVER (ORDER BY 1/0),
    some_value = 0
FROM sys.all_columns AS ac;
```

```sql
CREATE OR ALTER TRIGGER
    dbo.tr_create_me
ON dbo.create_me
AFTER
    UPDATE
AS
BEGIN
    DECLARE
        @id tinyint;

    SELECT
        @id = i.id
    FROM Inserted AS i; /*One row. Whichever one.*/

    UPDATE
        cm
    SET
        cm.some_column =
            CONVERT(datetime2(7), '99991231', 112)
    FROM dbo.create_me AS cm
    WHERE cm.id = @id;
END;
```

Update all 255 rows, and count what the trigger touched:

```sql
UPDATE
    cm
SET
    cm.some_value += 1
FROM dbo.create_me AS cm;

SELECT
    touched = COUNT_BIG(*)
FROM dbo.create_me AS cm
WHERE cm.some_column IS NOT NULL;
```

One row. The fix is to stop pretending there's one row. Exit early when nothing changed, and set [NOCOUNT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-nocount-transact-sql) and `ROWCOUNT` so the trigger behaves the same no matter what the caller set. ([XACT_ABORT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-xact-abort-transact-sql) is already on inside a trigger, so setting it costs nothing.)

```sql
CREATE OR ALTER TRIGGER
    dbo.tr_create_me
ON dbo.create_me
AFTER
    UPDATE
AS
BEGIN
    /*THIS ALWAYS GOES FIRST*/
    IF ROWCOUNT_BIG() = 0
        RETURN;

    /*MERGE can fire this with nothing in Inserted*/
    IF NOT EXISTS (SELECT 1/0 FROM Inserted AS i)
        RETURN;

    SET NOCOUNT, XACT_ABORT ON;
    SET ROWCOUNT 0;

    UPDATE
        cm
    SET
        cm.some_column =
            SYSDATETIME()
    FROM dbo.create_me AS cm
    WHERE EXISTS
    (
        SELECT
            1/0
        FROM Inserted AS i
        WHERE i.id = cm.id
    );
END;
```

The same update and count, after clearing `some_column`, came back 255. The second check is for `MERGE`, which can fire an `AFTER UPDATE` trigger with nothing in `Inserted` while `ROWCOUNT_BIG()` still reports every row the statement touched. Tested on **SQL Server 2025**: a `MERGE` that only inserted fired this trigger once, and the guard caught it.

With optimized locking on (**SQL Server 2025** and **Azure SQL Database**), the trigger's changes still block writers on those rows until the outer transaction commits, but a big modification mostly stops escalating. Without it, a 10,000-row update escalated both the table and the trigger's audit table, and an update of an unrelated audit row waited 2.2 seconds, against 4 ms with it on.

A trigger that keeps a `last_modified` column current is the usual way a trigger ends up firing from inside itself, because it updates the table it's on:

```sql
CREATE TABLE
    dbo.Customers
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    name varchar(50) NOT NULL,
    email varchar(100) NULL,
    last_modified datetime2(7) NOT NULL
        DEFAULT SYSDATETIME()
);

INSERT
    dbo.Customers
(
    id,
    name,
    email
)
VALUES
    (1, 'Ann', NULL),
    (2, 'Bob', 'bob@example.com'),
    (3, 'Cy', NULL);
GO

CREATE OR ALTER TRIGGER
    dbo.Customers_LastModified
ON dbo.Customers
AFTER
    UPDATE
AS
BEGIN
    /*THIS ALWAYS GOES FIRST*/
    IF ROWCOUNT_BIG() = 0
        RETURN;

    /*Only the outermost firing of this trigger does the work*/
    IF TRIGGER_NESTLEVEL(@@PROCID, 'AFTER', 'DML') > 1
        RETURN;

    SET NOCOUNT, XACT_ABORT ON;
    SET ROWCOUNT 0;

    UPDATE
        c
    SET
        c.last_modified = SYSDATETIME()
    FROM dbo.Customers AS c
    JOIN Inserted AS i
      ON i.id = c.id
    JOIN Deleted AS d
      ON d.id = i.id
    WHERE NOT EXISTS
    (
        /*INTERSECT treats two NULLs as equal*/
        SELECT
            i.name,
            i.email
        INTERSECT
        SELECT
            d.name,
            d.email
    );
END;
```

The [TRIGGER_NESTLEVEL](https://learn.microsoft.com/en-us/sql/t-sql/functions/trigger-nestlevel-transact-sql) check stops the trigger's own `UPDATE` from running it again. With [RECURSIVE_TRIGGERS](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-set-options) off, the database default, SQL Server doesn't fire a trigger directly from itself, so in the test this one fired once either way, but that setting doesn't stop indirect recursion.

When a trigger on another table wrote back to `Customers`, the version without the check looped until Msg 217 (nesting level 32) and failed the original update. With the check, it stopped at the second firing. With `RECURSIVE_TRIGGERS` on, the version without the check hit Msg 217 by itself.

`UPDATE(name)` only tells you name was in the `SET` list, not that its value changed. This statement makes `UPDATE(name)` true and changes nothing:

```sql
/*UPDATE(name) is true here, and nothing changed*/
UPDATE
    c
SET
    c.name = c.name
FROM dbo.Customers AS c
WHERE c.id = 2;
```

A version of the trigger that tested `UPDATE(name)` stamped `last_modified` on that row anyway. The one comparing `Inserted` to `Deleted` left it alone.

The comparison has to handle `NULL`. A check like `i.email <> d.email` is unknown when either side is `NULL`, so it misses this change:

```sql
/*A NULL becoming a value is a change*/
UPDATE
    c
SET
    c.email = 'cy@example.com'
FROM dbo.Customers AS c
WHERE c.id = 3;
```

With `<>`, that row kept its old `last_modified`. [NOT EXISTS](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/exists-transact-sql) with [INTERSECT](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/set-operators-except-and-intersect-transact-sql), from Paul White's [Undocumented Query Plans: Equality Comparisons](https://www.sql.kiwi/2011/06/undocumented-query-plans-equality-comparisons/), treats two `NULL`s as equal and caught it. So did i.email [IS DISTINCT FROM](https://learn.microsoft.com/en-us/sql/t-sql/queries/is-distinct-from-transact-sql) d.email, which is available from **SQL Server 2022**.

## Reading

- [Learn T-SQL With Erik: Bad Trigger Habits](https://erikdarling.com/learn-t-sql-with-erik-bad-trigger-habits/)
- [Undocumented Query Plans: Equality Comparisons](https://www.sql.kiwi/2011/06/undocumented-query-plans-equality-comparisons/) (Paul White)
