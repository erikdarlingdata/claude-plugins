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

## Evidence

Demo code and measurements: [evidence/the-app-picks-your-parameter-types.md](../evidence/the-app-picks-your-parameter-types.md). Open it to quote a number or run the demo.

## Reading

- [Software Vendor Mistakes With SQL Server: Not Strongly Typing Parameters](https://erikdarling.com/software-vendor-mistakes-with-sql-server-not-strongly-typing-parameters/)
