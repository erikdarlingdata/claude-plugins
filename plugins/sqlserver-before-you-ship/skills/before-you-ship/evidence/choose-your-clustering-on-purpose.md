# Choose your clustering on purpose: evidence

The card: [Choose your clustering on purpose](../cards/choose-your-clustering-on-purpose.md)

The same million orders twice. One table is clustered on an identity, with a unique index on the order number. The other is clustered on the order number:

```sql
CREATE TABLE
    dbo.OrdersIdentity
(
    id bigint IDENTITY NOT NULL
        PRIMARY KEY CLUSTERED,
    order_number bigint NOT NULL,
    customer_id integer NOT NULL,
    order_date datetime2(0) NOT NULL,
    amount decimal(19, 2) NOT NULL,
    INDEX order_number UNIQUE NONCLUSTERED
        (order_number)
);

CREATE TABLE
    dbo.OrdersNatural
(
    order_number bigint NOT NULL
        PRIMARY KEY CLUSTERED,
    customer_id integer NOT NULL,
    order_date datetime2(0) NOT NULL,
    amount decimal(19, 2) NOT NULL
);

INSERT
    dbo.OrdersIdentity
WITH
    (TABLOCK)
(
    order_number,
    customer_id,
    order_date,
    amount
)
SELECT
    order_number = 50000000 + x.n,
    customer_id = x.n % 50000,
    order_date = DATEADD(MINUTE, x.n, CONVERT(datetime2(0), '20240101', 112)),
    amount = CONVERT(decimal(19, 2), x.n % 1000)
FROM
(
    SELECT TOP (1000000)
        n = CONVERT(bigint, ROW_NUMBER() OVER (ORDER BY 1/0))
    FROM sys.all_columns AS ac1
    CROSS JOIN sys.all_columns AS ac2
) AS x
ORDER BY
    x.n;

INSERT
    dbo.OrdersNatural
WITH
    (TABLOCK)
(
    order_number,
    customer_id,
    order_date,
    amount
)
SELECT
    oi.order_number,
    oi.customer_id,
    oi.order_date,
    oi.amount
FROM dbo.OrdersIdentity AS oi;

CREATE INDEX customer_id ON dbo.OrdersIdentity (customer_id);
CREATE INDEX customer_id ON dbo.OrdersNatural (customer_id);
```

How much room each takes:

```sql
SELECT
    table_name = OBJECT_NAME(ps.object_id),
    index_name = i.name,
    mb = CONVERT(decimal(9, 1), SUM(ps.used_page_count) * 8 / 1024.)
FROM sys.dm_db_partition_stats AS ps
JOIN sys.indexes AS i
  ON  i.object_id = ps.object_id
  AND i.index_id = ps.index_id
WHERE ps.object_id IN
      (
          OBJECT_ID(N'dbo.OrdersIdentity'),
          OBJECT_ID(N'dbo.OrdersNatural')
      )
GROUP BY
    ps.object_id,
    i.name
ORDER BY
    table_name,
    index_name;
```

- The identity table: 81.5 MB, across its clustered index (42.7 MB), the order number index (21.3 MB), and the `customer_id` index (17.5 MB).
- The natural key table: 52.5 MB, across its clustered index (35.0 MB) and the `customer_id` index (17.5 MB).

Looking orders up by number, the way most queries find them:

```sql
SELECT
    oi.customer_id,
    oi.order_date,
    oi.amount
FROM dbo.OrdersIdentity AS oi
WHERE oi.order_number = 50500000;

SELECT
    o.customer_id,
    o.order_date,
    o.amount
FROM dbo.OrdersNatural AS o
WHERE o.order_number = 50500000;

SELECT
    oi.customer_id,
    oi.order_date,
    oi.amount
FROM dbo.OrdersIdentity AS oi
WHERE oi.order_number BETWEEN 50500000 AND 50500999;

SELECT
    o.customer_id,
    o.order_date,
    o.amount
FROM dbo.OrdersNatural AS o
WHERE o.order_number BETWEEN 50500000 AND 50500999;
```

On **SQL Server 2025**:

- One order: 6 reads from the identity table, for a seek on the order number index and a key lookup, and 3 from the natural key table.
- 1,000 consecutive orders: about 3,000 reads from the identity table, one key lookup per order, and 8 from the natural key table.

Between `int` and `bigint`, the clustering key is in every nonclustered index row, so the difference shows up in each one:

```sql
CREATE TABLE
    dbo.KeyInteger
(
    id integer NOT NULL
        PRIMARY KEY CLUSTERED,
    customer_id integer NOT NULL
);

CREATE TABLE
    dbo.KeyBigint
(
    id bigint NOT NULL
        PRIMARY KEY CLUSTERED,
    customer_id integer NOT NULL
);

INSERT
    dbo.KeyInteger
WITH
    (TABLOCK)
(
    id,
    customer_id
)
SELECT
    CONVERT(integer, oi.id),
    oi.customer_id
FROM dbo.OrdersIdentity AS oi;

INSERT
    dbo.KeyBigint
WITH
    (TABLOCK)
(
    id,
    customer_id
)
SELECT
    oi.id,
    oi.customer_id
FROM dbo.OrdersIdentity AS oi;

CREATE INDEX customer_id ON dbo.KeyInteger (customer_id);
CREATE INDEX customer_id ON dbo.KeyBigint (customer_id);
```

With the same million rows, the `customer_id` index came out at 13.6 MB on the `integer` key and 17.5 MB on the `bigint` one, about 4 MB more per million rows, per index.
