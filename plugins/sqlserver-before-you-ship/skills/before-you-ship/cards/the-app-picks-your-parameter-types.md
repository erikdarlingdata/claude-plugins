# The app picks your parameter types

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "Is application code sending it?" (ORMs, AddWithValue, parameter types)

Most data access code picks parameter types for you, and it picks badly. ADO.NET's `AddWithValue` is the classic: every string becomes `nvarchar`, sized to whatever value happens to be in it. Against a `varchar` column, that's the implicit conversion from [the types card](types-are-a-performance-feature.md), and it can turn a seek into a scan. And because the length changes with the value, the same query gets compiled and cached again for every string length it sees.

## What it costs

Declaring parameters properly: type, length, precision, and scale that match the column. In ADO.NET that's `Parameters.Add` with an explicit `SqlDbType` and size instead of `AddWithValue`. Most ORMs (object-relational mappers) have a way to map column types, and it's usually a one-time configuration job.

## What it risks

Fixing the type and not the length. A `varchar` parameter sized to each value still fills the plan cache with one entry per length. Size it to the column's declared length, and use -1 for `MAX` columns.

## How fast it works

The scans go away as soon as the corrected code deploys. The duplicate plans already in the cache age out on their own.

## When it backfires

Fixing strings and stopping there. Dates and decimals get inferred too: `AddWithValue` sends a `DateTime` as `datetime`, which rounds to 1/300 of a second. That quietly loses precision going into a `datetime2` column. Decimals arrive with whatever precision and scale the value had. Set Scale for `datetime2`, and Precision and Scale for `decimal`.

## Deeper dive

What `AddWithValue` does, and the fix, adapted from Dan Guzman's post:

```csharp
// Infers nvarchar(5) for "Smith", nvarchar(6) for "Jones2", and so on
command.Parameters.AddWithValue("@LastName", lastName);

// Matches a varchar(30) column, one plan for every value
command.Parameters.Add("@LastName", SqlDbType.VarChar, 30).Value = lastName;
```

To find the damage that's already in the plan cache, look for one query shape with several cached plans:

```sql
SELECT
    qs.query_hash,
    cached_plans = COUNT_BIG(DISTINCT qs.plan_handle),
    total_executions = SUM(qs.execution_count)
FROM sys.dm_exec_query_stats AS qs
GROUP BY
    qs.query_hash
HAVING
    COUNT_BIG(*) > 1
ORDER BY
    cached_plans DESC;
```

The top of that list will often be unparameterized queries with literal values, which is a different problem. The `AddWithValue` duplicates are the ones whose statement text starts with a parameter list like (`@LastName nvarchar(5)`).

In a test on **SQL Server 2025**, three different lengths of the same `nvarchar` parameter left three plans in the cache, and only a repeated length got reused. The same query with a `varchar(20)` parameter used one plan for every value.

Look at the statement text of the duplicates: parameter declarations that differ only by length are this problem.

Source: Dan Guzman, [AddWithValue is Evil](https://www.dbdelta.com/addwithvalue-is-evil/).

## Reading

- [Software Vendor Mistakes With SQL Server: Not Strongly Typing Parameters](https://erikdarling.com/software-vendor-mistakes-with-sql-server-not-strongly-typing-parameters/)
