# CTEs aren't temp tables: evidence

The card: [CTEs aren't temp tables](../cards/ctes-aren-t-temp-tables.md)

Two ways to watch a CTE run once per reference, and both work in any database. First, a CTE that picks a random number, referenced twice:

```sql
WITH
    pick AS
(
    SELECT
        n = ABS(CHECKSUM(NEWID()))
)
SELECT
    first_reference = p1.n,
    second_reference = p2.n
FROM pick AS p1
CROSS JOIN pick AS p2;
```

If SQL Server runs the CTE once and reuses the result, both columns will match. In five runs on **SQL Server 2022**, and again on **2025**, they never did.

Second, the reads. Build a 100,000-row table:

```sql
CREATE TABLE
    dbo.CteDemo
(
    id integer NOT NULL
       PRIMARY KEY CLUSTERED,
    filler char(200) NOT NULL
       DEFAULT 'x'
);

INSERT
    dbo.CteDemo
WITH
    (TABLOCK)
(
    id
)
SELECT TOP (100000)
    id = ROW_NUMBER() OVER (ORDER BY 1/0)
FROM sys.all_columns AS ac1
CROSS JOIN sys.all_columns AS ac2;
```

Count it in a CTE, and join the CTE to itself:

```sql
SET STATISTICS IO ON;

WITH
    totals AS
(
    SELECT
        records = COUNT_BIG(*)
    FROM dbo.CteDemo AS cd
)
SELECT
    t1.records
FROM totals AS t1
JOIN totals AS t2
  ON t2.records = t1.records;
```

`STATISTICS IO` shows `CteDemo` scanned twice: 5,278 logical reads, where counting the table once takes 2,639. Five references will put five scans in the plan.

Load the count into a `#temp` table once, and join that instead:

```sql
CREATE TABLE
    #totals
(
    records bigint NOT NULL
);

INSERT
    #totals
(
    records
)
SELECT
    records = COUNT_BIG(*)
FROM dbo.CteDemo AS cd;

SELECT
    t1.records
FROM #totals AS t1
JOIN #totals AS t2
  ON t2.records = t1.records;
```

`CteDemo` goes back to one scan and 2,639 reads, and each reference to the `#temp` table costs one page. The more expensive the query inside the CTE, the more that trade pays.

The course runs the same comparison on a five-reference query against `StackOverflow2013`, where the plan shows the same branch repeated five times. The post below walks through it on video.
