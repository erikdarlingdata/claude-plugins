# The most dangerous ALTER

Where it sits in the chart: A table > An existing table > "Changing a data type" (The one that locks the table)

Changing a column's data type usually rewrites every row under a schema modification lock (a lock that blocks every other query on the table). If the column is part of an index, key, or constraint, most type changes don't rebuild them for you. The `ALTER` fails, and you have to drop them, alter the column, and put them back.

Widening a string column is the common exception. It works even on a clustering key (the table's sort key), as long as no foreign key points at the column or from it. On a big, busy table this is an outage with a change inside it.

## What it costs

Log proportional to table size, blocking for the duration, and dropping and recreating every index, constraint, and foreign key that touches the column. `ONLINE = ON` doesn't get you out of that. Drop the nonclustered indexes before the clustered one, or each gets rebuilt twice.

With Accelerated Database Recovery on, it logs more and rolls back instantly. Changing `int` to `bigint` on 200,000 uncompressed rows logged 41 to 52 MB instead of 36.5 MB. Budget a maintenance window, not a deploy slot.

## What it risks

Some conversions also silently change semantics: precision, collation, truncation behavior. The performance pain at least announces itself. The semantic drift doesn't.

## How fast it works

The safe pattern is slower on purpose: add the new column, backfill in batches, keep both in sync briefly, swap names, drop the old one. Days of calm instead of hours of hostage negotiation. For a clustering key that doesn't work, because every index depends on it: build a new table, copy in batches, sync, and swap names.

## When it backfires

Assuming every type change is a rewrite, or that none are. On a `ROW`- or `PAGE`-compressed table, `int` to `bigint` on a column with no index is metadata-only. On an uncompressed one it rewrites every row. Guessing which one you've got is how `int` to `bigint` on a billion-row table happens on a Tuesday. Test the exact change on a production-sized copy first.

## Deeper dive

Before changing a column's type, find everything that depends on it. The dependencies fall into two sets: ones that stop the `ALTER`, and ones that let it through and cause trouble later.

These stopped `int` to `bigint` with Msg 5074 and 4922 until they were dropped. Disabling isn't enough: a disabled index, a `NOCHECK` constraint, and a security policy set to `STATE = OFF` all still blocked it.

- Indexes that use the column anywhere: as a key, as an included column, or only in a filtered index's `WHERE` clause
- Primary keys and unique constraints on the column, and foreign keys on either side of it
- `CHECK` and `DEFAULT` constraints
- Computed columns that use it
- Schema-bound views, indexed views, and schema-bound functions
- [Row-level security](https://learn.microsoft.com/en-us/sql/relational-databases/security/row-level-security) policies whose predicate takes the column
- User-created statistics. Auto-created statistics on the column were dropped by the `ALTER` instead of blocking it.
- Partitioning on the column, through the index built on the partition scheme
- Nonclustered columnstore indexes that include it. A clustered columnstore index didn't block the change.

These let the `ALTER` through and cause trouble afterward:

- Parameters and variables still declared with the old type. After `nvarchar(50)` became `nvarchar(100)`, a stored procedure with an `nvarchar(50)` parameter cut a 70-character value to 50 with no error. After `decimal(10, 2)` became `decimal(12, 4)`, a `decimal(10, 2)` parameter stored 1.2345 as 1.23. After `int` became `bigint`, passing 3,000,000,000 to an `integer` parameter failed with Msg 8114.
- Everywhere else the value gets copied in the old type: table variables, temp tables, table types, and audit or staging tables. Each failed with Msg 8115 as soon as a value went past the `integer` range.
- Parameters that no longer match the column. After `nvarchar` became `varchar`, an application still sending `nvarchar` parameters turned a 3-read seek into an 886-read index scan under the `SQL_Latin1_General_CP1_CI_AS` collation.
- Views that aren't schema-bound. They returned the new values, but `sys.columns` kept reporting the old types until [sp_refreshview](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-refreshview-transact-sql) ran.
- Result consumers outside the database: application code, ORM (object-relational mapper) mappings, ETL (extract, transform, load) packages, and reports built around the old type.

Length and precision changes within the same type follow different rules. Widening `nvarchar(50)` to `nvarchar(100)` went through with the column in a clustered primary key, nonclustered index keys and includes, a unique constraint, `CHECK` and `DEFAULT` constraints, user-created statistics, a nonclustered columnstore index, and as the partitioning column. Narrowing it back to `nvarchar(50)` failed on all of those except the `CHECK` and `DEFAULT` constraints.

Decimal precision changes behaved like narrowing in both directions: `decimal(5, 2)` to `decimal(10, 2)` failed on the same objects as `decimal(10, 2)` to `decimal(5, 2)`, and `CHECK` and `DEFAULT` constraints were fine either way. Filtered indexes, foreign keys, computed columns, schema-bound objects, and security policies blocked every change, wider or narrower.

Narrowing also checks the data. An 80-character value stopped `nvarchar(100)` to `nvarchar(50)` with Msg 2628, and 12,345.67 stopped `decimal(10, 2)` to `decimal(5, 2)` with Msg 8115.

## Reading

- [Changing a column from int to bigint, without downtime](https://am2.co/2019/12/changing-a-column-from-int-to-bigint-without-downtime/) (Andy Mallon)
- [Changing From Int to Bigint In SQL Server: Annoyances With Backfilling Tables](https://erikdarling.com/changing-from-int-to-bigint-in-sql-server-annoyances-with-backfilling-tables/)
- [The Great Integer To Bigint Compression Swindle](https://erikdarling.com/the-great-integer-to-bigint-compression-swindle/)
- [Things SQL Server vNext Should Address: Going From INT To BIGINT](https://erikdarling.com/things-sql-server-vnext-should-address-going-from-int-to-bigint/)
