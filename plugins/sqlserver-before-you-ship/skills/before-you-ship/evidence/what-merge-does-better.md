# What MERGE does better: evidence

The card: [What MERGE does better](../cards/what-merge-does-better.md)

The `OUTPUT` upside matters most with inserts. Say you're copying rows into a table with an identity column and need to know which new `Id` each old row got, which `INSERT`'s `OUTPUT` can't tell you, because it can only see `inserted` columns. `MERGE`'s can see the source too. A target with an identity, a staging table with the old keys, and a table for the map:

```sql
CREATE TABLE
    dbo.Target
(
    Id integer IDENTITY NOT NULL
        PRIMARY KEY CLUSTERED,
    Name nvarchar(50) NOT NULL
);

CREATE TABLE
    #Staging
(
    OldId integer NOT NULL,
    Name nvarchar(50) NOT NULL
);

CREATE TABLE
    #IdMap
(
    OldId integer NOT NULL,
    NewId integer NOT NULL
);

INSERT
    #Staging
(
    OldId,
    Name
)
VALUES
    (101, N'first'),
    (102, N'second');
```

Then the `MERGE`:

```sql
MERGE
    dbo.Target AS t
USING #Staging AS s
  ON 1 = 0
WHEN NOT MATCHED
THEN
    INSERT
    (
        Name
    )
    VALUES
    (
        s.Name
    )
OUTPUT
    s.OldId,
    inserted.Id
INTO #IdMap
(
    OldId,
    NewId
);
```

The `ON 1 = 0` guarantees nothing matches, so every source row goes down the insert branch. And `#IdMap` ends up holding old-to-new key pairs you can use for child tables. A `MERGE` that upserts in production takes `WITH (HOLDLOCK)` on the target, per [the upsert card](../cards/upserts-break-under-concurrency.md). This insert-only `MERGE` with `ON 1 = 0` doesn't need it.

The duplicate-row protection, adapted from the course. One target row, four source rows that all match it:

```sql
CREATE TABLE
    dbo.Transactions
(
    TransactionID bigint NOT NULL,
    ClientID integer NULL,
    TransactionDate datetime2(2) NULL,
    CONSTRAINT PK_dbo_Transactions
        PRIMARY KEY CLUSTERED (TransactionID),
    INDEX dbo_Transactions_ClientID_TranDate
        (ClientID, TransactionDate)
);

CREATE TABLE
    #Working
(
    WorkingID integer IDENTITY NOT NULL,
    TransactionID bigint NULL,
    ClientID integer NULL,
    TransactionDate datetime2(2) NULL,
    INDEX cx CLUSTERED (TransactionID)
);

INSERT
    dbo.Transactions
(
    TransactionID,
    ClientID,
    TransactionDate
)
VALUES
    (1, 1, '2026-01-01');

/*Four source rows for one target row*/
INSERT
    #Working
(
    TransactionID,
    ClientID,
    TransactionDate
)
VALUES
    (1, 2, NULL),
    (1, NULL, '2026-03-03'),
    (1, 3, NULL),
    (1, NULL, '2026-02-02');
```

```sql
UPDATE
    t
SET
    t.ClientID = w.ClientID,
    t.TransactionDate = w.TransactionDate
FROM #Working AS w
JOIN dbo.Transactions AS t
  ON t.TransactionID = w.TransactionID;

SELECT
    t.TransactionID,
    t.ClientID,
    t.TransactionDate
FROM dbo.Transactions AS t;
```

The `UPDATE` finished, and the row came back with `ClientID` 2 and a `TransactionDate` of 2026-03-03. None of the four source rows looks like that.

The plan grouped the matches with a Stream Aggregate using `ANY`, which took the `ClientID` from one row and the `TransactionDate` from another. It came out the same in every run, so a test won't flag it. Now try the same change as a `MERGE` instead:

```sql
/*Put the original row back, then try the same change as a MERGE*/
UPDATE
    t
SET
    t.ClientID = 1,
    t.TransactionDate = '2026-01-01'
FROM dbo.Transactions AS t
WHERE t.TransactionID = 1;

MERGE
    dbo.Transactions AS t
USING #Working AS w
  ON t.TransactionID = w.TransactionID
WHEN MATCHED
THEN UPDATE
    SET
        t.ClientID = w.ClientID,
        t.TransactionDate = w.TransactionDate;
```

That failed with Msg 8672, because a target row matched more than one source row, and the row stayed as it was, so `MERGE` at least tells you. The `UPDATE` never will, so that's where deciding which source row wins matters most. Sometimes the source can be unique on the join key, but plenty of relationships are one-to-many. Then number the rows per key with [ROW_NUMBER](https://learn.microsoft.com/en-us/sql/t-sql/functions/row-number-transact-sql), order by something that breaks ties deterministically, and keep the first one:

```sql
/*Put the original row back, then pick one source row per key on purpose*/
UPDATE
    t
SET
    t.ClientID = 1,
    t.TransactionDate = '2026-01-01'
FROM dbo.Transactions AS t
WHERE t.TransactionID = 1;

UPDATE
    t
SET
    t.ClientID = x.ClientID,
    t.TransactionDate = x.TransactionDate
FROM dbo.Transactions AS t
JOIN
(
    SELECT
        w.TransactionID,
        w.ClientID,
        w.TransactionDate,
        n =
            ROW_NUMBER() OVER
            (
                PARTITION BY
                    w.TransactionID
                ORDER BY
                    w.WorkingID DESC /*Unique, so ties can't happen*/
            )
    FROM #Working AS w
) AS x
  ON x.TransactionID = t.TransactionID
WHERE x.n = 1;

SELECT
    t.TransactionID,
    t.ClientID,
    t.TransactionDate
FROM dbo.Transactions AS t;
```

That ran every time and left the row exactly as the last-loaded source row had it, `NULL` `ClientID` and all, instead of a row nobody wrote. The same numbered source works as a `MERGE`'s `USING`, which then stops throwing 8672. If the `ORDER BY` can tie, `ROW_NUMBER` picks between the tied rows arbitrarily, and you're back where you started.
