# Find the page, then fetch the rows

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Showing results a page at a time?" (OFFSET/FETCH, ROW_NUMBER, page 1 of 10,000)

A paging query returns one page of results at a time: rows 1 to 100, then 101 to 200, and so on. Write it in two steps:

- Find the keys for one page, using only the narrow columns you sort and filter on.
- Join back to the table for the wide columns, for just those rows.

The first step is only cheap when an index already holds the rows in that order, so every sort order you offer needs one. Deep pages still read every key before them, and a total count reads every key there is.

## What it costs

An index in the order of each sort you offer, keyed for the filters that go with it, and a query written in two steps instead of one.

When users can sort by any column and filter on any combination, no set of rowstore indexes covers it. That's when to look at a nonclustered columnstore index, a denormalized reporting table, or a search engine like Elasticsearch.

## What it risks

Sort by something that isn't unique, and rows can show up on two pages, or on none, because ties can come back in a different order each time, so end every sort with the primary key. That's one of [Microsoft's two conditions](https://learn.microsoft.com/en-us/sql/t-sql/queries/select-order-by-clause-transact-sql) for stable paging, along with data that doesn't change between requests.

A total count with `COUNT_BIG(*) OVER ()` reads every matching row to return 100 of them, and a sort on an unindexed column reads and sorts the whole table for every page.

## How fast it works

In a test on a million rows, page 5,000 took 1.4 million reads and 1 to 2 seconds selecting every column straight from `OFFSET/FETCH`, because every row up to the end of the page got a key lookup. Finding the keys first took about 1,400 reads and 50 to 70 ms. Seeking from the last row of the previous page read 276 pages in about a millisecond at the same depth.

## When it backfires

Someone exports the whole table through the paging screen, 100 rows at a time. Every page reads all the keys before it, so each one is slower than the last.

## Evidence

Demo code and measurements: [evidence/find-the-page-then-fetch-the-rows.md](../evidence/find-the-page-then-fetch-the-rows.md). Open it to quote a number or run the demo.

## Reading

- [Considerations For Paging Queries In SQL Server With Batch Mode (Don't Use OFFSET/FETCH)](https://erikdarling.com/considerations-for-paging-queries-in-sql-server-with-batch-mode-dont-use-offset-fetch/)
- [Learn T-SQL With Erik: TOP and OFFSET/FETCH](https://erikdarling.com/learn-t-sql-with-erik-top-and-offset-fetch/)
- [A Little About Paging Queries And Batch Mode In SQL Server](https://erikdarling.com/a-little-about-paging-queries-and-batch-mode-in-sql-server/)
- [Optimising Server-Side Paging - Part I](https://www.sqlservercentral.com/articles/optimising-server-side-paging-part-i) (Paul White)
- [Optimising Server-Side Paging - Part II](https://www.sqlservercentral.com/articles/optimising-server-side-paging-part-ii) (Paul White)
