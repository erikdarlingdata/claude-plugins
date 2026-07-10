# Fixes, and fixes that are not fixes

Reading a plan correctly and then recommending a bad rewrite wastes the whole
analysis. This file covers the remedies that get suggested reflexively and do not
do what the person suggesting them thinks.

**The rule that governs all of it:** when you propose a rewrite, name the
mechanism. Say what changes in the plan and why. If you cannot say what changes,
you are guessing, and you should say that instead.

Never assert that two T-SQL constructs are equivalent. `#temp` tables, table
variables, CTEs, derived tables, views, and inline table-valued functions are six
different things with six different behaviors. Their surface syntax hides
differences of several orders of magnitude in runtime.

## A CTE is not a temp table

This is the single most common wrong thing said about SQL Server, and it is said
confidently.

A non-recursive common table expression is **not materialized**. It is expanded
into the outer query like a view or a derived table. Microsoft's documentation is
unambiguous:

> Query results from common table expressions aren't materialized. Each outer
> reference to the named result set requires the defined query to be re-executed.
> For queries that require multiple references to the named result set, consider
> using a temporary object instead.
>
> — [WITH common_table_expression](https://learn.microsoft.com/en-us/sql/t-sql/queries/with-common-table-expression-transact-sql)

So a CTE referenced five times is its defining query, executed five times. You can
see this directly in the plan: count the accesses to the CTE's base table. A CTE
over `dbo.Posts` referenced by five `LEFT JOIN`s produces **five separate scans of
`dbo.Posts`**, not one scan feeding five consumers.

Worse than the repeated work is what it does to estimates. Each self-join against
the re-expanded CTE multiplies the row estimate, and the error compounds:

```
[0] Nested Loops (Left Outer Join)  est 10,000,000,000 rows   <- five references
   [1] Nested Loops (Left Outer Join)  est 100,000,000 rows
      [2] Nested Loops (Left Outer Join)  est 1,000,000 rows
         [3] Nested Loops (Left Outer Join)  est 10,000 rows
            [4] Nested Loops (Inner Join)  est 100 rows        <- one reference
```

Actual rows returned: 1. A ten-billion-row estimate drives an enormous memory
grant and a plan shape built for a workload that does not exist.

Things that follow, and that people get wrong:

- A CTE does **not** give the optimizer statistics on an intermediate result.
  There is no intermediate result.
- A CTE does **not** "run once and get reused."
- SQL Server has **no hint to force materialization**. Oracle's
  `/*+ MATERIALIZE */` has no counterpart here. The documented remedy is to
  materialize by hand into a `#temp` table.
- The optimizer sometimes introduces a spool that happens to share a common
  subexpression across references. That is an incidental, cost-based, undocumented
  artifact. It is not a feature, it is not guaranteed, and you must not describe
  it as one.
- A CTE is not slower than a derived table or a view. They are the same thing.
  Rewriting a CTE as a subquery changes nothing.

**Recursive CTEs are different.** They execute iteratively: the anchor member runs
once, then the recursive member repeats, each iteration consuming the previous
one's output. The engine drives this with an Index Spool carrying a `WITH STACK`
predicate, which is how you confirm real recursion in a plan. But that spool is
internal to the recursion. An outer query referencing the recursive CTE five times
still runs the entire recursion five times.

**When a CTE is fine:** referenced once, for readability. That is most of them.
Do not tell someone to rip out a single-reference CTE. It costs nothing.

**When to materialize:** referenced more than once, or when the optimizer's
estimate of the CTE's output is badly wrong and you want real statistics on the
intermediate result. Then use a `#temp` table.

## A table variable is not a lightweight temp table

The second most common wrong thing. `@t` and `#t` are not interchangeable.

**Table variables do not live in memory.** This myth is nearly universal and it is
simply false. A table variable is materialized in **tempdb**, on pages, exactly
like a `#temp` table. Neither is memory-resident as a property of its type; both
sit in the buffer pool while hot and both go to disk under pressure. There is no
`@` means RAM and `#` means disk distinction.

The one exception is a genuinely memory-optimized table variable, declared from a
table type created `WITH (MEMORY_OPTIMIZED = ON)`. That is a separate In-Memory
OLTP feature, and if someone were using it they would know.

So "table variables are lighter weight" is not merely unproven, it is backwards.
They give you no statistics and a forced-serial modification. The `#temp` table is
the lighter-weight choice for everything except the narrow cases at the end of
this section.

**Table variables carry no column statistics.** Not before 2019, not after, not
ever, and **not even when you give them an index**. There is no histogram, so the
selectivity of any predicate against a table variable is a guess, always, on every
version. This is the part that does not change.

The **cardinality** estimate does change, and this is where people get it wrong in
both directions:

- Without table variable deferred compilation — before SQL Server 2019, or below
  compatibility level 150 — the estimate is a fixed **one row**, regardless of how
  many rows the variable actually holds.
- With deferred compilation (SQL Server 2019+, Azure SQL DB, compat 150), the
  optimizer uses the table variable's **real cardinality**. The flat one-row
  estimate is simply not what happens any more, and repeating it is a
  version-blind answer.

There is a catch, and it is the interesting part. Inside a **stored procedure**,
that real cardinality is sniffed when the plan compiles and then **reused by every
later execution of the cached plan**. It behaves exactly like parameter sniffing:
correct for the call that compiled the plan, potentially very wrong for the calls
that follow, if the row count swings.

So on a modern instance, a table variable in a procedure can produce a plan built
for 10 rows and executed against 10 million, and the estimate will look correct in
the cached plan you are staring at.

`OPTION (RECOMPILE)` on the referencing statement gives an accurate cardinality on
any version, and sidesteps the sniffing. It still gives you no column statistics.

Deferred compilation can also be turned off (`DEFERRED_COMPILATION_TV = OFF`, or
`USE HINT('DISABLE_DEFERRED_COMPILATION_TV')`), so its presence at compat 150 is
not guaranteed. Read the estimate in the plan rather than assuming from the
version.

**Statements that modify a table variable are compiled fully serial.** Not just
the write operator — the whole statement, including the `SELECT` inside an
`INSERT ... SELECT`. Statements that only *read* a table variable can still go
parallel.

Table variables can have indexes, via `PRIMARY KEY` / `UNIQUE` constraints or the
inline `INDEX` syntax added in SQL Server 2014. Statistics are still not created or
maintained on them. An index without a histogram does not fix the estimate.

The cost is not academic. Two real plans of the same query, against the same data,
differing only in `#temp` versus `@table variable`:

| | `#temp` table | `@table` variable |
|---|---|---|
| Estimated rows | 10 | 1 |
| Degree of parallelism | 8 | 1, serial |
| Elapsed | 465 ms | 15,887 ms |

Thirty-four times slower, from one keyword. The table variable's 1-row estimate
sized a memory grant for a few hundred rows, then six million arrived, three sorts
spilled to tempdb, and an eager spool absorbed the difference. Every one of those
is downstream of the missing statistics.

When a plan forces a serial statement because of a table variable, SQL Server says
so: `NonParallelPlanReason` reads
`TableVariableTransactionsDoNotSupportParallelNestedTransaction`.

**When a table variable is fine:** tiny, fixed-size row sets where the estimate
does not matter; inside a function where `#temp` is not allowed; when you need it
to survive a rollback (table variables are not transactional).

**Otherwise, prefer `#temp`.** It is materialized in tempdb, it gets real column
statistics with a histogram, statistics on it update synchronously, it can be
indexed, and it can be inserted into in parallel with `TABLOCK`.

## Do not "fix" an implicit conversion by casting the column

Seeing `CONVERT_IMPLICIT(nvarchar(40), [t].[col])` in a `Seek Plan` warning, the
reflex is to write `WHERE CAST(t.col AS nvarchar(40)) = @p`.

That makes it worse. It converts an implicit conversion the optimizer performed
into an explicit one you performed, the predicate is still non-SARGable, the index
is still unusable for seeking, and now the estimate is a guess too.

The fix is to make the types match at the source. Change the parameter's type, or
change the column's. See `warnings.md` for which side loses.

## Hints suppress symptoms

`OPTION (RECOMPILE)`, `MAXDOP 1`, `OPTIMIZE FOR`, `FORCESEEK`, `LOOP JOIN` — every
one of these is a way to stop the optimizer doing something, and none of them
explains why it was doing it.

They are legitimate tools. Reach for them once you understand the cause, and when
you do, say what the cause was. "Add `OPTION (RECOMPILE)`" is not an analysis.
"The plan was compiled for a parameter value that returns 3 rows and executed with
one that returns 4 million, so it is reusing a nested-loop plan;
`OPTION (RECOMPILE)` trades compile time for a correct plan per execution" is.

`OPTION (RECOMPILE)` is the one worth knowing has a second use: it gives table
variables an accurate cardinality estimate on any version.

## Other reflexes worth resisting

**`NOLOCK` is not a performance fix.** It is `READ UNCOMMITTED`. It permits dirty
reads, missing rows, and duplicated rows during page splits. It does not make a
scan read fewer pages. It never appears as a solution to anything in a plan.

**`SELECT DISTINCT` to remove duplicates from a join** hides a fan-out rather than
fixing it. The duplicates mean the join is wrong, or a one-to-many relationship
was not accounted for. `DISTINCT` adds a sort or a hash aggregate over an inflated
row set and buries the cause.

**Rewriting `IN` as `EXISTS` as a `JOIN`** rarely changes the plan. The optimizer
normalizes them. If someone's plan is bad, this is not why.

**Adding the missing-index request verbatim.** See `indexes.md`. The equality
columns are in arbitrary order and existing indexes were ignored.

**Removing a scan by forcing a seek.** A scan of a small table is optimal. See
`indexes.md`. `FORCESEEK` on a query that genuinely needs most of the table makes
it slower.

## What a good recommendation looks like

State the mechanism, the evidence, and the expected change in the plan. Cite the
node ids **from the plan in front of you**, never from this document:

> Materialize the CTE into a `#temp` table. It is referenced five times, so its
> defining query runs five times — the digest's SAME OBJECT ACCESSED MORE THAN
> ONCE section shows five separate scans of `dbo.Posts`, each reading all 17.1
> million rows to emit 29, and together they account for 19,691 ms of the query's
> 19,694 ms. A `#temp` table runs the query once and gives the optimizer real
> statistics on the 29-row result, which should also collapse the ten-billion-row
> estimate at the root that is driving the memory grant.

Every clause there is checkable against the plan. That is the standard.
