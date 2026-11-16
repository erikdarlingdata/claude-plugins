# The write tax

Where it sits in the chart: An index > A new index > "What does this index cost to keep?" (The write tax nobody budgets for)

Every index is a separate copy of some of your data, on disk and in memory. SQL Server maintains it on every insert and delete, plus any update that touches its columns, whether anything reads from it or not. That's all true, and none of it is a reason to be scared of indexes. The goal is an index whose creation and maintenance cost gets amortized over the many queries it makes faster. Enjoy responsibly.

## What it costs

Storage, backup size, log volume, and maintenance time all grow a little with every index. So does memory: SQL Server has to read an index into the buffer pool to change it, whether any query ever reads from it or not.

## What it risks

The danger is cumulative: each index is cheap, the fifteenth is not, and the new index isn't yours alone. The optimizer (which picks the plan) can start using it for other queries too, and some of them can be worse off with it.

Locks add up too, though not across indexes. Lock escalation (SQL Server trading thousands of row and page locks for one table lock) needs at least 5,000 locks on a single index, and locks on different indexes don't combine to reach it. They do share the count that decides when SQL Server checks, which happens each time the locks the transaction holds reach another multiple of 1,250. An extra index can carry a modification to a check it never used to reach, and if any one index is past 5,000 at that point, the whole table gets locked.

## How fast it works

Immediate. The next query that can use it, uses it, and so does every query you didn't test.

## When it backfires

An `INCLUDE` on a column the workload updates. An index on `c1` alone sits out every update to `age`, and with `age` in its `INCLUDE` list, every one of those updates maintains it. In the evidence file, the locks that one index added pushed a 4,500-row update to an escalation check it never used to reach, and the whole table ended up under one `X` lock.

## Evidence

Demo code and measurements: [evidence/the-write-tax.md](../evidence/the-write-tax.md). Open it to quote a number or run the demo.

## Reading

- [A Little About How Overindexing Can Hurt SQL Server Performance](https://erikdarling.com/a-little-about-how-overindexing-can-hurt-sql-server-performance/)
- [How Unused Indexes Hurt: Lock Escalation](https://erikdarling.com/how-unused-indexes-hurt-lock-escalation/)
- [The Lock Escalation Threshold, Part 1](https://www.sql.kiwi/2022/09/lock-escalation-threshold-part-1/) (Paul White)
- [The Lock Escalation Threshold, Part 2](https://www.sql.kiwi/2022/10/lock-escalation-threshold-part-2/) (Paul White)
- [The Lock Escalation Threshold, Part 3](https://www.sql.kiwi/2022/10/lock-escalation-threshold-part-3/) (Paul White)
