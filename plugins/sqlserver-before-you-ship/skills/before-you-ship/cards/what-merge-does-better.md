# What MERGE does better

Where it sits in the chart: A query > No NOLOCK > It changes data > MERGE > "Why MERGE at all?" (Two things it does that other statements don't)

Michael J. Swart's verdict, on [the avoid list card](swart-s-avoid-list.md), is to avoid [MERGE](https://learn.microsoft.com/en-us/sql/t-sql/statements/merge-transact-sql). My take is a bit less severe: avoid `MERGE` unless you're willing to write it correctly and test it thoroughly. Because it does two things normal modification queries don't:

- If a target row matches more than one source row, `MERGE` throws an error instead of quietly picking one. An `UPDATE` with a join finishes anyway, and it can even stitch together values from different source rows.
- Its [OUTPUT](https://learn.microsoft.com/en-us/sql/t-sql/queries/output-clause-transact-sql) clause can return source columns alongside the inserted ones, which a plain `INSERT` won't let you do.

## What it costs

Writing it correctly: the right hints for concurrency, a source that's unique on the join key, and an `ON` clause that matches only what you mean to match.

## What it risks

Everything on the avoid list still applies. The upsides don't cancel the bugs. They're reasons to take the risk on knowingly.

## How fast it works

Immediately. Duplicate source rows fail the statement with error 8672 the first time they show up, but the equivalent `UPDATE` finishes, and is wrong.

## When it backfires

You were warned at the door.

## Deeper dive

The `OUTPUT` upside matters most with inserts. Say you're copying rows into a table with an identity column and need to know which new `Id` each old row got, which `INSERT`'s `OUTPUT` can't tell you, because it can only see `inserted` columns. `MERGE`'s can see the source too:

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

The `ON 1 = 0` guarantees nothing matches, so every source row goes down the insert branch. And `#IdMap` ends up holding old-to-new key pairs you can use for child tables.

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

## Reading

- [In Defense Of Merge: Non-Deterministic Updates](https://erikdarling.com/in-defense-of-merge-non-deterministic-updates/)
- [Learn T-SQL With Erik: A Neat Thing with MERGE and OUTPUT](https://erikdarling.com/learn-t-sql-with-erik-a-neat-thing-with-merge-and-output/)
