# The app picks your parameter types: evidence

The card: [The app picks your parameter types](../cards/the-app-picks-your-parameter-types.md)

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
