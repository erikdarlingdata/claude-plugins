# UNION ALL isn't always faster

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Combining results with UNION?" (UNION, UNION ALL, and the duplicates in between)

[UNION](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/set-operators-union-transact-sql) removes duplicate rows and `UNION ALL` doesn't, and removing them costs a sort, a hash, or a merge over everything both halves return. When the halves can't overlap and neither repeats a row on its own (like the ids of posts of two different types), that work buys nothing. `UNION ALL` returns the same rows for less.

When the halves overlap a lot and the result feeds a join, the duplicates can cost more than removing them, because every copy gets joined again. Decide by what the results need to mean first, then test both with the rest of the query attached.

## What it costs

Knowing whether the halves can overlap. When a column like a type splits them and each half returns a key, `UNION ALL` is free. When they can overlap and you need each row once, `UNION` is the price of a correct answer.

## What it risks

`UNION ALL` where duplicates change the answer. Anything that counts or sums the combined rows counts every copy. That's how [Don't join on OR](don-t-join-on-or.md) counted 13,200 posts where there were 11,200. Picking `UNION ALL` for speed is only safe when rows can't repeat, or when nothing after it cares.

## How fast it works

Immediate, in either direction. Counting 1.9 million posts from two halves that couldn't overlap took 120 to 190 ms with `UNION ALL` and 380 to 490 ms with `UNION`. Feeding three million user ids into a join with two million votes took 350 to 680 ms with `UNION`, which joined 290,000 distinct users. With `UNION ALL`, it took 710 to 880 ms and sent 15.6 million rows out of the join.

## When it backfires

Testing the halves on their own. Counted by themselves, the second test's halves came back in 30 to 80 ms with `UNION ALL` and 160 to 400 ms with `UNION`, and that's the opposite of the full query. The cost of the duplicates showed up in the join after them. So test with the whole query, and compare row counts in the actual plans.

## Evidence

Demo code and measurements: [evidence/union-all-isn-t-always-faster.md](../evidence/union-all-isn-t-always-faster.md). Open it to quote a number or run the demo.

## Reading

- [SQL Server Query Performance Using Union vs Union All (Sometimes)](https://erikdarling.com/union-vs-union-all-sometimes/)
- [How To Write SQL Server Queries Correctly: UNION and UNION ALL](https://erikdarling.com/how-to-write-sql-server-queries-correctly-union-and-union-all/)
