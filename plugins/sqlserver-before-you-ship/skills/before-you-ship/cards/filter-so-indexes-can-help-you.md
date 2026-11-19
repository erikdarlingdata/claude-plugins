# Filter so indexes can help you

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "How are you filtering?" (Functions on columns, mismatched types, leading wildcards)

You'll hear that some queries "can't use indexes" because of how they're written, or more precisely, that they can't use them efficiently.

B-tree indexes put data in order, and wrapping a column in most functions or doing math on it prevents a seek into that order. The same goes for comparing it to [a type that forces the column to convert](types-are-a-performance-feature.md), and for a `LIKE` that leads with a wildcard. A few functions still seek, like converting a `datetime` column to `date`, but don't count on it.

The jargon for a predicate (a filter condition) that an index can seek with is SARGable. Hiding the expression inside a [CTE](https://learn.microsoft.com/en-us/sql/t-sql/queries/with-common-table-expression-transact-sql) (common table expression) or derived table doesn't help either. When you're stuck, [an indexed computed column](index-the-expression-with-a-computed-column.md) is the escape hatch.

## What it costs

Nothing to buy. Write the predicate against the bare column. Use `IS NULL` instead of [COALESCE](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/coalesce-transact-sql)`(col, sentinel)` = sentinel, a date range instead of `YEAR(col)`, and parameter types that match the column's type.

## What it risks

Rewrites can change results if you're careless. `COALESCE(col, 0) = 0` matches the `NULL`s and the real zeroes. So the SARGable equivalent is `col = 0 OR col IS NULL`, not `IS NULL` alone.

## How fast it works

Immediate, and biggest when the query only needs a small number of rows. If it has to read most of the table anyway, no seek will save it.

## When it backfires

A rewrite that changes the answer. `COALESCE(t.priority, 0) = 0` was matching the real zeroes as well as the `NULL`s, and a time-zone shift on the column has to move to the search value, not disappear, or the rows near midnight land in the wrong day. Compare row counts from the old predicate and the new one, with the same values, before it ships. Equal counts can still hide different rows, because a moved boundary can drop some rows and pick up as many others, so compare the keys too.

## Evidence

Demo code and measurements: [evidence/filter-so-indexes-can-help-you.md](../evidence/filter-so-indexes-can-help-you.md). Open it to quote a number or run the demo.

## Reading

- [SARGability Week: What Is It, Anyway?](https://erikdarling.com/sargability-week-what-is-it-anyway/)
