# Types are a performance feature

Where it sits in the chart: A table > A new table > "What types are these columns, really?" (nvarchar(MAX) everywhere, mismatched types, dates as strings)

Every mismatched or oversized type is a promise you'll pay for later. When a query compares a column to a value of a different type, SQL Server converts one side. It hurts when the column is the side SQL Server converts. The common case is a `varchar` column compared to an `nvarchar` parameter, which is what most drivers and ORMs (object-relational mappers) send by default. Depending on the column's collation (its rules for sorting and comparing text), the seek you assumed becomes a scan or a slower range seek.

`MAX` types are worse: their predicates (filter conditions) evaluate late, they bloat memory grants, and they can't be index keys. And dates stored as strings sort correctly only in a year-first format like `YYYYMMDD`, and only while every row uses it, which nothing enforces.

## What it costs

Some thought at `CREATE TABLE`, and a conversation with whoever owns the data access code about which parameter types it sends.

## What it risks

Types are the hardest thing to change on a live table, so the wrong choice compounds. [The most dangerous ALTER](the-most-dangerous-alter.md) shows how bad that change gets.

## How fast it works

From the first query that touches the column. Getting it wrong is immediate too: grants sized for `nvarchar(MAX)`, filters SQL Server can't push into the seek or scan, and conversions on every comparison.

## When it backfires

Going too narrow. A type that fits today's data but not next year's turns into [the most dangerous ALTER](the-most-dangerous-alter.md) on your busiest table. A `smallint` ID is one, and so is a `varchar` key that foreign keys point at.

## Evidence

Demo code and measurements: [evidence/types-are-a-performance-feature.md](../evidence/types-are-a-performance-feature.md). Open it to quote a number or run the demo.

## Reading

- [SARGability Week: Why Implicit Conversions Aren't SARGable](https://erikdarling.com/sargability-week-why-implicit-conversions-arent-sargable/)
- [Why MAX Data Types Are Usually A Bad Choice For SQL Server Columns](https://erikdarling.com/why-max-data-types-are-usually-a-bad-choice-for-sql-server-columns/)
