# Key order decides the seek

Where it sits in the chart: An index > A new index > "What order do the key columns go in?" (Why isn't SQL Server using my index?)

Missing index requests are SQL Server's own index suggestions. They order key columns (the columns the index sorts on) by predicate type (equality or inequality), then by the column's ordinal position in the table. Ordinal position has nothing to do with selectivity (how few rows a value matches).

Sometimes that works out in your favor. Other times the not-selective column leads. With two equality predicates, that rarely hurts the query that asked, because both columns land in the seek. With two inequality predicates, only the leading one gets the seek, and the index can read every row to find a handful.

Selectivity is a reasonable place to start, but it isn't a rule: equality predicates can be selective or not, and so can inequality predicates. What you're designing for is the query pattern: what it filters on, what it sorts by, and which values people search for.

## What it costs

Maintenance cost is identical regardless of column order. The benefit depends entirely on getting the order right, so a wrong order is full price for a fraction of the payoff.

## What it risks

With two inequality predicates, only the first one gets the seek. The second becomes a residual predicate: checked row by row against everything the seek returns. Which one goes first depends on which narrows more for the values people pass in.

## How fast it works

Immediate. A reversed key order on a range-heavy query can be the difference between reading a wide date range and seeking to the few qualifying rows.

## When it backfires

Treating "most selective column first" as the rule. It's a fine place to start, and it falls apart quickly. A selective range column can land ahead of an equality column, or ahead of the `ORDER BY` columns. That can cost you the seek or the Sort you were trying to avoid. Run [COUNT_BIG](https://learn.microsoft.com/en-us/sql/t-sql/functions/count-big-transact-sql) per predicate to see where you stand, then design for the whole query pattern, which [the keys-and-includes card](keys-sort-includes-ride-along.md) lays out.

## Evidence

Demo code and measurements: [evidence/key-order-decides-the-seek.md](../evidence/key-order-decides-the-seek.md). Open it to quote a number or run the demo.

## Reading

- [A Little About Choosing Index Key Column Order](https://erikdarling.com/a-little-about-choosing-index-key-column-order/)
- [Parameter Sniffing, Predicate Selectivity, And Index Key Column Order In SQL Server](https://erikdarling.com/parameter-sniffing-predicate-selectivity-and-index-key-column-order-in-sql-server/)
- [How does SQL Server determine key column order in missing index requests?](https://dba.stackexchange.com/questions/208947/how-does-sql-server-determine-key-column-order-in-missing-index-requests) (DBA Stack Exchange)
