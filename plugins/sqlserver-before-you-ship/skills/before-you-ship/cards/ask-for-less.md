# Ask for less

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "How much data are you asking for?" (SELECT *, wide rows)

`SELECT *` is a bad habit, and I say that as someone who types it in demos and apologizes for it.

Every column you drag along makes the query harder to cover with an index (an index that holds every column the query needs). It also makes a narrow nonclustered index less of a guarantee. Every row the index finds needs a key lookup, a trip back to the table for the columns the index doesn't have, and the optimizer weighs all those lookups against scanning the table instead. Which one wins changes with the parameter values, and that's how `SELECT *` contributes to [parameter sensitivity](dev-lied-to-you.md).

And it inflates the memory grant: memory a query reserves up front to sort or hash rows. SQL Server sizes the grant from estimates of how many rows there are and how wide they are. Row width is a tax on everything downstream of the read.

## What it costs

On a new query, typing out the columns you need, and nothing at runtime.

## What it risks

On a query that already runs, removing columns is a contract change: something downstream might read them. Check [Who else depends on this?](mind-your-query-consumers.md) before you trim.

## How fast it works

The next execution. A narrower select gets a smaller memory grant. SQL Server estimates variable-length columns at half their declared size, and each `MAX` column at about 4,000 bytes. So a few `MAX` columns you never needed can turn a small query into a grant hog that makes other queries wait.

## When it backfires

When your queries don't use indexes they could, and use way more memory than they should.

## Evidence

Demo code and measurements: [evidence/ask-for-less.md](../evidence/ask-for-less.md). Open it to quote a number or run the demo.

## Reading

- [All The Performance Problems With Select * Queries In SQL Server](https://erikdarling.com/all-the-problems-with-select/)
- [Learn T-SQL With Erik: TOP and OFFSET/FETCH](https://erikdarling.com/learn-t-sql-with-erik-top-and-offset-fetch/)
