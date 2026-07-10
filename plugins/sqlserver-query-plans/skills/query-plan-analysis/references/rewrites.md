# Fixes, and fixes that are not fixes

Reading a plan correctly and then recommending a bad rewrite wastes the analysis.

**Two rules.**

Never assert that two T-SQL constructs are equivalent. `#temp` tables, table
variables, CTEs, derived tables, views, and inline TVFs are six different things
with six different behaviors, and the differences are worth orders of magnitude.

When you propose a rewrite, name the mechanism: what changes in the plan, and why.
If you cannot say, you are guessing. Say that instead.

## You may not have the query

Do not build conclusions on the SQL text. Plans pulled from the plan cache or
Query Store often carry no statement text at all, and `StatementText` inside a
plan is frequently truncated. Reason from the plan; use the text only to confirm
what the plan already told you, and say so when it is missing.

## A CTE is not a temp table

The most common wrong thing said about SQL Server, and it is said confidently.

A non-recursive CTE is **not materialized**. It is expanded into the outer query
like a view, and re-run once per reference.

> Query results from common table expressions aren't materialized. Each outer
> reference to the named result set requires the defined query to be re-executed.
>
> — [WITH common_table_expression](https://learn.microsoft.com/en-us/sql/t-sql/queries/with-common-table-expression-transact-sql)

**Plan tell:** the same object accessed several times, once per reference. The
digest reports this under `SAME OBJECT ACCESSED MORE THAN ONCE`. A self-join looks
identical, so the count alone does not prove a CTE — but combined with a compounding
row estimate up a chain of joins, it usually is one.

Follows from that:

- A CTE gives the optimizer no statistics on an intermediate result. There is no
  intermediate result.
- It does not "run once and get reused."
- SQL Server has no hint to force materialization. Oracle's `MATERIALIZE` has no
  counterpart. Materialize by hand into a `#temp` table.
- A spool that happens to share a subexpression across references is an incidental,
  cost-based optimizer artifact. Not a feature, not guaranteed.
- A CTE is not slower than a derived table or a view. They are the same thing.

Referenced once, a CTE costs nothing. Leave it alone. Materialize when it is
referenced more than once, or when you want real statistics on the intermediate
result.

**Recursive CTEs are different.** They run iteratively, driven by an Index Spool
carrying a `WITH STACK` predicate. That spool is internal to the recursion — an
outer query referencing the recursive CTE five times still runs the recursion five
times.

## A table variable is not a lightweight temp table

**No column statistics. Ever. On any version. Even when indexed.** Predicate
selectivity against a table variable is always a guess. This part never changes.

**Cardinality** does change, and both directions get misreported:

- Without table variable deferred compilation (pre-2019, or compat level below
  150): a fixed **one-row** estimate, whatever it holds.
- With deferred compilation (2019+, compat 150): the optimizer uses the **real
  cardinality**. Repeating the one-row claim here is a version-blind answer.

The catch: inside a **stored procedure**, that real cardinality is sniffed at
compile and reused by every later execution of the cached plan. Same behavior as
parameter sniffing. Right for the call that compiled it, potentially very wrong
afterwards.

`OPTION (RECOMPILE)` gives accurate cardinality on any version. It still gives you
no column statistics.

**Modifying a table variable forces the whole statement serial** — including the
`SELECT` inside an `INSERT ... SELECT`. Reading one without modifying it can go
parallel. **Plan tell:** `NonParallelPlanReason` =
`TableVariableTransactionsDoNotSupportParallelNestedTransaction`.

**They do not live in memory.** A table variable is materialized in tempdb, on
pages, exactly like a `#temp` table. There is no `@` means RAM, `#` means disk
distinction. The exception is a table type declared `WITH (MEMORY_OPTIMIZED = ON)`,
and anyone using that knows it.

So "lighter weight" is backwards. Two real plans, same query, same data:

| | `#temp` | `@table variable` |
|---|---|---|
| Estimated rows | 10 | 1 |
| DOP | 8 | 1, serial |
| Elapsed | 465 ms | 15,887 ms |

Use `#temp`: materialized, real column statistics with a histogram, indexable,
parallel insert with `TABLOCK`. Table variables are fine for tiny fixed-size sets
where the estimate cannot matter, inside functions where `#temp` is unavailable,
and when you need the contents to survive a rollback.

## A parameter is not a local variable

They look the same in the query text. The optimizer treats them nothing alike.

**A parameter's value is sniffed at compile time.** The optimizer reads the
histogram for that specific value and builds the best plan for it. Correct for the
value that compiled the plan, potentially very wrong for every later execution
that reuses it. That is parameter sniffing.

**A local variable's value is unknown at compile time.** There is no histogram
lookup. For an equality predicate the optimizer falls back on the density vector
(average rows per distinct value). For a range predicate it uses a fixed
selectivity guess. Either way the estimate is stable and usually poor. This is
identical to `OPTIMIZE FOR UNKNOWN`.

**`SET @local = @param` deliberately disables sniffing.** It is the most common
"fix" for a sniffing problem, and it is a trade, not a cure: you swap a plan that
is excellent for one value and terrible for another for a plan that is mediocre
for all of them. Sometimes predictability is what you want. Say that you are
choosing it.

`OPTION (RECOMPILE)` lets the optimizer see the runtime value of either, and use
the histogram.

**Plan tells:**

- Parameters appear in `<ParameterList>` with `ParameterCompiledValue` and
  `ParameterRuntimeValue`. When those differ, the plan was compiled for one value
  and executed with another.
- Local variables **never appear in `ParameterList`**. If a predicate compares
  against a value you cannot find anywhere in the plan, it is a local variable.
- A parameter with a runtime value but no compiled value means the plan was not
  compiled for a sniffed value — `OPTION (RECOMPILE)` or `OPTIMIZE FOR UNKNOWN`.
- An estimate landing on a round fraction of `TableCardinality` beside a predicate
  whose value you cannot see is the fingerprint of a local variable in a range
  predicate.

## Fixes that are not fixes

**Casting the column to fix an implicit conversion.** `CAST(t.col AS nvarchar(40)) = @p`
converts the optimizer's implicit conversion into your explicit one. Still
non-SARGable, still no seek, and now the estimate is a guess too. Fix the types at
the source. See `warnings.md`.

**Hints.** `OPTION (RECOMPILE)`, `MAXDOP 1`, `OPTIMIZE FOR`, `FORCESEEK` all stop
the optimizer doing something without explaining why it did it. Legitimate once you
understand the cause. Say what the cause was.

**`NOLOCK`.** It is `READ UNCOMMITTED`. Dirty reads, missing rows, duplicated rows.
It reads no fewer pages. It fixes nothing in a plan.

**`SELECT DISTINCT` over a join.** Hides a fan-out instead of fixing it, and adds a
sort or hash aggregate over the inflated row set.

**Rewriting `IN` as `EXISTS` as a `JOIN`.** The optimizer normalizes them. Not why
the plan is bad.

**The missing-index request, pasted as DDL.** See `indexes.md`.

**Forcing a seek over a scan.** A scan of a small table is optimal. See `indexes.md`.
