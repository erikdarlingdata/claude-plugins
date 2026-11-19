# Local variables hide their values

Where it sits in the chart: A query > No NOLOCK > It reads data > A new query > "Filtering on a local variable?" (DECLARE @x = ...; then WHERE column = @x)

SQL Server compiles a batch before it runs any of it. So when a query filters on a local variable, SQL Server builds the plan before the variable has a value. With nothing to look up in the statistics (SQL Server's summary of a column's values), it guesses.

For an equality, the guess is the average number of rows per value in the column. For a range like `>=`, it's 30% of the table. Every value gets that same guess, whether it matches 10 rows or 1.4 million.

Parameters don't have the problem, because SQL Server sees their values when it compiles. If the variable is only a copy of a parameter, use the parameter.

More often it holds something computed: the result of another query, or an expression like [DATEADD](https://learn.microsoft.com/en-us/sql/t-sql/functions/dateadd-transact-sql)(DAY, 1, [GETDATE](https://learn.microsoft.com/en-us/sql/t-sql/functions/getdate-transact-sql)()) that you don't want to repeat. An expression can go straight into the query, where SQL Server can estimate it. For a query result, pass the value to dynamic SQL as a parameter, or add `OPTION` ([RECOMPILE](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query)) to the statement.

## What it costs

Nothing, if the variable is only a copy of a parameter, or an expression you can write into the query instead. When it holds a query result, `OPTION (RECOMPILE)` costs a compile on every execution. Passing it to dynamic SQL or to a second procedure doesn't.

## What it risks

Parameter sniffing, when the variable was there to hide it. SQL Server builds a parameter's plan for the first value and reuses it for the next. Here, Parameter Sensitive Plan Optimization (**SQL Server 2022** and later, at compatibility level 160 or higher) kept separate plans for vote types 11 and 2. With it turned off, type 2 reused type 11's seek-and-lookup plan for 1.4 million rows and read 4.2 million pages. [Dev lied to you](dev-lied-to-you.md) covers testing for it.

## How fast it works

The next compile. With the value visible, through a parameter or `OPTION (RECOMPILE)`, the rare type got a 10-row estimate and an index seek. It got 33 page reads instead of 7,229. The common type got a 1.4 million row estimate and a 127 MB grant, against the 19 MB the local variable got it.

## When it backfires

`WITH RECOMPILE` on the procedure instead of `OPTION (RECOMPILE)` on the statement. A procedure created `WITH RECOMPILE` compiles fresh every time, but it still compiles before the variable gets its value. In a test, the estimate stayed at 200,000 for both types. Only the statement-level hint lets SQL Server use the parameter embedding optimization. [Only search what was asked for](only-search-what-was-asked-for.md) has the same trap with parameters, for a different reason.

## Evidence

Demo code and measurements: [evidence/local-variables-hide-their-values.md](../evidence/local-variables-hide-their-values.md). Open it to quote a number or run the demo.

## Reading

- [SQL Server IF Branches And Query Performance Part 3: Local Variables Still Suck](https://erikdarling.com/sql-server-if-branches-and-query-performance-part-2-local-variables-still-suck/)
- [Table Variable vs Local Variable Cardinality Estimates in SQL Server](https://erikdarling.com/table-variable-vs-local-variable-cardinality-estimates-in-sql-server/)
- [Why Expressions Are Better Than Local Variables For Performance In SQL Server](https://erikdarling.com/why-expressions-are-better-than-local-variables-for-performance-in-sql-server/)
- [Parameter Sniffing, Embedding, and the RECOMPILE Options](https://www.sql.kiwi/2013/08/parameter-sniffing-embedding-and/) (Paul White)
