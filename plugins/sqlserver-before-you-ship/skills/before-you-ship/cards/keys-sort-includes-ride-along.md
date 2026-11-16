# Keys sort. Includes ride along.

Where it sits in the chart: An index > A new index > "Key columns or included columns?" (What each one costs)

Key columns are ordered. Included columns are along for the ride. If your query has an `ORDER BY`, those columns belong in the keys, where equality predicates ahead of them preserve the ordering.

Missing index requests (SQL Server's own index suggestions) shove `ORDER BY` columns into the includes. That buys you a covered query (one the index answers on its own) that still sorts every execution.

A Sort needs a memory grant sized from estimates. Parameter-sensitive queries reusing a grant sized for the small case can spill to tempdb (write to disk when the grant runs short).

## What it costs

Key columns are carried up the B-tree (the index's tree of pages) and cost more than includes. Includes live only at the leaf level (the bottom of the tree). If nothing needs a column's order or needs to seek on it, don't promote it to the keys.

## What it risks

An index removes the Sort only for the order it's built in. A query sorting by score `DESC`, `creation_date` needs those columns in that order and direction. SQL Server can also read an index backward, so the fully reversed order works too, but any other order still sorts.

## How fast it works

Immediate. An index that satisfies the `ORDER BY` removes the Sort, and with it that Sort's memory grant and spill risk. Hashes (hash joins and aggregates) still take grants. The plan can still flip between a seek with lookups and a scan depending on the parameter.

## When it backfires

Putting the `ORDER BY` columns ahead of an equality predicate. The order that works is equality, then ordering, then range. Get it backwards and you trade the Sort for a scan.

## Evidence

Demo code and measurements: [evidence/keys-sort-includes-ride-along.md](../evidence/keys-sort-includes-ride-along.md). Open it to quote a number or run the demo.

## Reading

- [A Little About How Indexes Store Data In SQL Server](https://erikdarling.com/a-little-about-how-indexes-store-data-in-sql-server/)
