# NOT EXISTS says what you mean

**Requires:** nothing. Below compatibility level 170, the `LEFT JOIN ... IS NULL` version does the extra work. At 170 (**SQL Server 2025**), both get the same plan.

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Looking for rows with no match?" (LEFT JOIN ... IS NULL, NOT IN, NOT EXISTS)

To find users with no posts, a lot of code `LEFT JOIN`s to posts and keeps the rows where the post came back `NULL`. Below compatibility level 170 (**SQL Server 2025**'s level, set per database), that joins every user to every one of their posts, then throws the matches away.

[NOT EXISTS](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/exists-transact-sql) asks the question directly. [NOT IN](https://learn.microsoft.com/en-us/sql/t-sql/language-elements/in-transact-sql) looks like the same question until the list it checks contains a `NULL`, and then it returns no rows at all.

The opposite question works the same way. `EXISTS` returns each user once, where a `JOIN` returns a row per matching post and needs a `DISTINCT` to undo it.

## What it costs

Nothing. `NOT EXISTS` is about as long as the `LEFT JOIN`, and it returns the same rows, as long as the column the `LEFT JOIN` tests with `IS NULL` can't be `NULL` on its own, the way `p.id` can't here.

## What it risks

A different answer, when the code being replaced is `NOT IN` on a column that allows `NULL`s. Asking which users never last-edited a post with `NOT IN` returned 0. That's because half the posts have no editor, and one `NULL` in the list makes `NOT IN` unknown for every row. `NOT EXISTS` returned the 310,000 users who never edited anything, and so did `NOT IN` once the subquery filtered out the `NULL`s.

## How fast it works

It depends on the version. Below compatibility level 170, **SQL Server 2022** included, the `LEFT JOIN` built 2.3 million joined rows and filtered them down to 300,000 afterward. It took longer than `NOT EXISTS` in every run: 140 to 400 ms against 75 to 260 ms. At compatibility level 170, **SQL Server 2025** rewrites that `LEFT JOIN` into the same anti semi join (a join that keeps only the rows with no match) that `NOT EXISTS` gets, and the two ran the same.

## When it backfires

A subquery that matches on a column with no index. `NOT EXISTS` only needs one matching row, so SQL Server can plan a Top over a scan of the inner table and bet that each scan finds a match early. When matches are missing, each scan reads the whole table.

In a test with 210 stores, 4 million sales, and no index on `store_id`, `NOT EXISTS` read 228,700 pages in 2 to 2.3 seconds. At compatibility level 160, the `LEFT JOIN` version hashed both tables once instead, 22,968 pages in 177 to 233 ms. At 170, **SQL Server 2025** rewrote the `LEFT JOIN` into the same plan as `NOT EXISTS`. [A Top above a scan means a missing index](a-top-above-a-scan-means-a-missing-index.md) has the fix.

## Evidence

Demo code and measurements: [evidence/not-exists-says-what-you-mean.md](../evidence/not-exists-says-what-you-mean.md). Open it to quote a number or run the demo.

## Reading

- [Why Not Exists Makes More Sense Than Left Joins For Performance](https://erikdarling.com/why-not-exists-makes-more-sense-than-left-joins/)
- [Software Vendor Mistakes With SQL Server: Using Left Joins To Find Rows That Don't Exist](https://erikdarling.com/software-vendor-mistakes-with-sql-server-using-left-joins-to-find-rows-that-dont-exist/)
- [How To Write SQL Server Queries Correctly: IN and NOT IN](https://erikdarling.com/how-to-write-sql-server-queries-correctly-in-and-not-in/)
