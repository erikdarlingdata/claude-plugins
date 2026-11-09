# A Top above a scan means a missing index

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "Is there a Top right above a Scan?" (EXISTS, NOT EXISTS, or TOP reading the same table over and over)

[EXISTS](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/exists-transact-sql), `NOT EXISTS`, `IN`, and [TOP](https://learn.microsoft.com/en-us/sql/t-sql/queries/top-transact-sql) all tell SQL Server it can stop once it finds enough rows, and the optimizer plans around that, which is called a row goal. When the table being searched has no index on the column the subquery matches on, the optimizer can put a Top right above a scan. It bets each scan finds a match in the first few rows. When matches are missing, each execution reads the whole table, and when they're rare, close to it.

The estimated plan looks tiny, because its estimates assume the bet pays off. The actual plan shows what each scan read.

Index the column the subquery matches on.

## What it costs

One index, on the column in the subquery's `WHERE` clause that points back at the outer table.

## What it risks

Trusting the estimated plan. In a test, the whole query had an estimated cost of 0.80 and an estimate of 1 row per scan. The actual plan showed 210 executions of the scan and 40 million rows read. The scan's `EstimateRowsWithoutRowGoal` property, 20,000 here, is the optimizer's guess without the bet.

## How fast it works

Immediate. Finding the first ten stores with no sales read 228,700 pages in 2 to 3 seconds. With an index on `store_id`, it read about 700 pages in 1 ms.

## When it backfires

A new index for one query on a table that's written to all day. If an existing index already leads with the column, look at why the plan isn't seeking it, and if one almost works, [widen it](widen-before-you-add.md) instead. Every new index is part of [the write tax](the-write-tax.md).

When the index can't go in, `OPTION` ([USE HINT](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query) ('`DISABLE_OPTIMIZER_ROWGOAL`')) plans the query without the bet: one scan, 160 to 180 ms in the test. But it turns off every row goal in the statement, including any that were helping.

## Deeper dive

Using the four million sales from [Reporting tables want columnstore](reporting-tables-want-columnstore.md), where `store_id` runs from 1 to 200 and has no index, and a table of stores:

```sql
/*210 stores; the last ten opened this week and haven't sold anything*/
CREATE TABLE
    dbo.Stores
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    name nvarchar(40) NOT NULL
);

INSERT
    dbo.Stores
WITH
    (TABLOCK)
(
    id,
    name
)
SELECT
    x.id,
    name = CONCAT(N'store ', x.id)
FROM
(
    SELECT TOP (210)
        id = CONVERT(integer, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
) AS x;
```

```sql
/*The first ten stores with no sales*/
SELECT TOP (10)
    st.id
FROM dbo.Stores AS st
WHERE NOT EXISTS
(
    SELECT
        1/0
    FROM dbo.SalesRowstore AS s
    WHERE s.store_id = st.id
)
ORDER BY
    st.id;
```

On **SQL Server 2025**, the plan was a Top over a Nested Loops anti semi join. On the inner side, a Top sat over a Clustered Index Scan of `SalesRowstore`.

Stores 1 through 200 each found a sale within the first 200 rows. Stores 201 through 210 have none, so each of those scans read all 4 million rows before giving up. That came to 40,020,100 rows read across 210 executions, 228,700 logical reads, and 2 to 3 seconds.

The plan had an estimated cost of 0.80. The estimated plan draws thin arrows the whole way.

```sql
/*When the index can't go in: plan it without the row goal*/
SELECT TOP (10)
    st.id
FROM dbo.Stores AS st
WHERE NOT EXISTS
(
    SELECT
        1/0
    FROM dbo.SalesRowstore AS s
    WHERE s.store_id = st.id
)
ORDER BY
    st.id
OPTION (USE HINT ('DISABLE_OPTIMIZER_ROWGOAL'));
```

Run that before the index below goes in. Costed without the bet, the plan came out at 19.99 instead of 0.80. So the optimizer picked one parallel scan of `SalesRowstore` into a Hash Match: 22,968 logical reads, 160 to 180 ms.

The hint covers every row goal in the statement, so keep it for queries where the index can't go in. Joe Obbish's A Row Goal Request, below, calls it a workaround until the optimizer costs row goals better.

```sql
CREATE INDEX
    store_id
ON dbo.SalesRowstore
    (store_id);
```

Same query, no hint: a seek into the new index for each store, about 700 logical reads, 1 ms.

The pattern is easy to spot in estimated plans once you know it. It's a Top, then a Scan, on the inner side of a Nested Loops join.

On this data, [NOT IN](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/in-transact-sql) and [CROSS APPLY](https://learn.microsoft.com/en-us/sql/t-sql/queries/from-transact-sql) with `TOP (1)` got the same shape and read the same 40 million rows. `EXISTS` and `IN`, which looked for stores that do have sales, used a hash join instead.

## Reading

- [A Row Goal Request For SQL Server](https://erikdarling.com/a-row-goal-request/)
- [Row Goals: Part 2](https://erikdarling.com/row-goals-part-2/)
