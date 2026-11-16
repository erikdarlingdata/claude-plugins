# The most dangerous ALTER: evidence

The card: [The most dangerous ALTER](../cards/the-most-dangerous-alter.md)

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
