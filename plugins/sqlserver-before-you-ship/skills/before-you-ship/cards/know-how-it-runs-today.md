# Know how it runs today

Where it sits in the chart: A query > No NOLOCK > It reads data > An existing query > "How does it run today?" (CPU, duration, timeouts, and errors)

The plan says how a query runs. Its runtime stats say how it's been running: how often, how long it takes on average, how long on its best and worst runs, and whether it ever times out or fails. Query Store keeps those next to the estimated plans, for each plan, hour by hour, and it's on by default for databases created on **SQL Server 2022** and later. The plan cache keeps some of them, with caveats.

A query that averages 300 ms and sometimes takes 30 seconds is a different problem from one that always takes 2 seconds. Know which one you have before you change it, so you can tell whether the change helped.

## What it costs

Query Store takes space in each database, up to [MAX_STORAGE_SIZE_MB](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-database-transact-sql-set-options), plus some overhead to collect. When it fills up, it switches to read-only and stops collecting, so check `actual_state_desc` in `sys.database_query_store_options` before you trust what isn't in it.

## What it risks

Reading the averages wrong. Query Store averages are per interval, an hour by default, so a query's average across hours has to be weighted by `count_executions`. Averaging the hourly averages lets one slow run in a quiet hour count as much as a thousand fast runs in a busy one. The plan cache has no history at all, because its numbers start when the plan was cached and disappear when it recompiles or gets evicted.

## How fast it works

Fast. One query against Query Store gives you the average, minimum, and maximum CPU and duration for every plan the query has had, split into runs that finished, runs the client aborted, and runs that failed with an error. Those are your before numbers, the ones the change has to beat.

## When it backfires

Comparing your own test runs to the app's numbers. SSMS (SQL Server Management Studio) turns [ARITHABORT](https://learn.microsoft.com/en-us/sql/t-sql/statements/set-arithabort-transact-sql) on by default and most client libraries leave it off, so in the test, the same procedure called both ways became two Query Store entries with separate `query_ids`, and two plans in the cache. Look up the app's entry, because yours can have a different plan.

## Deeper dive

A test procedure against the `Votes` table from [Local variables hide their values](local-variables-hide-their-values.md), slow on purpose, with a divide-by-zero waiting in it for `@minutes = 0`:

```sql
CREATE OR ALTER PROCEDURE
    dbo.VoteWindow
(
    @top_id integer,
    @minutes integer
)
AS
BEGIN
    SET NOCOUNT, XACT_ABORT ON;

    /*The hints keep it slow on purpose*/
    SELECT
        c = COUNT_BIG(*)
    FROM dbo.Votes AS v1
    JOIN dbo.Votes AS v2
      ON DATEDIFF(MINUTE, v1.created, v2.created)
         BETWEEN 0 AND 60 / @minutes
    WHERE v1.id <= @top_id
    OPTION (MAXDOP 1, LOOP JOIN);
END;
```

It ran 14 times normally, once with a 3-second command timeout (sqlcmd -t 3), and once with `@minutes = 0`. Query Store keeps runtime stats per plan, per interval (an hour by default), and per execution type. This rolls them up for the procedure, with the averages weighted by executions:

```sql
SELECT
    q.query_id,
    p.plan_id,
    rs.execution_type_desc,
    executions =
        SUM(rs.count_executions),
    avg_cpu_ms =
        SUM(rs.avg_cpu_time * rs.count_executions) /
        SUM(rs.count_executions) / 1000.,
    min_cpu_ms =
        MIN(rs.min_cpu_time) / 1000.,
    max_cpu_ms =
        MAX(rs.max_cpu_time) / 1000.,
    avg_duration_ms =
        SUM(rs.avg_duration * rs.count_executions) /
        SUM(rs.count_executions) / 1000.,
    min_duration_ms =
        MIN(rs.min_duration) / 1000.,
    max_duration_ms =
        MAX(rs.max_duration) / 1000.
FROM sys.query_store_runtime_stats AS rs
JOIN sys.query_store_plan AS p
  ON p.plan_id = rs.plan_id
JOIN sys.query_store_query AS q
  ON q.query_id = p.query_id
WHERE q.object_id = OBJECT_ID(N'dbo.VoteWindow')
GROUP BY
    q.query_id,
    p.plan_id,
    rs.execution_type_desc
ORDER BY
    q.query_id,
    p.plan_id,
    rs.execution_type_desc;
```

All three kinds of run came back separately: 14 Regular runs from 282 ms to 2.5 seconds, averaging 764 ms, one Aborted run at 3,002 ms, and one Exception at 0.25 ms. Aborted means the client gave up, by timeout or by cancel. An Aborted max duration that sits right at 30 seconds is usually a .NET app's default command timeout.

The plan cache saw the same 16 runs differently:

```sql
SELECT
    ps.cached_time,
    ps.execution_count,
    avg_cpu_ms =
        ps.total_worker_time /
        ps.execution_count / 1000.,
    min_cpu_ms =
        ps.min_worker_time / 1000.,
    max_cpu_ms =
        ps.max_worker_time / 1000.,
    avg_duration_ms =
        ps.total_elapsed_time /
        ps.execution_count / 1000.,
    min_duration_ms =
        ps.min_elapsed_time / 1000.,
    max_duration_ms =
        ps.max_elapsed_time / 1000.
FROM sys.dm_exec_procedure_stats AS ps
WHERE ps.database_id = DB_ID()
AND   ps.object_id = OBJECT_ID(N'dbo.VoteWindow');
```

[sys.dm_exec_procedure_stats](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-exec-procedure-stats-transact-sql) counted all 16, with a minimum of 0.3 ms and a maximum of 3,002 ms, but it can't say which runs those were. [sys.dm_exec_query_stats](https://learn.microsoft.com/en-us/sql/relational-databases/system-dynamic-management-objects/sys-dm-exec-query-stats-transact-sql), one level down at the statement, counted 14 and topped out at 2.5 seconds, with no sign of the timeout or the error.

Both only go back to when the plan was cached. After [sp_recompile](https://learn.microsoft.com/en-us/sql/relational-databases/system-stored-procedures/sp-recompile-transact-sql) on the procedure, neither had anything left for it, while Query Store still had every run. A statement with `OPTION` ([RECOMPILE](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-query)) was worse: after five runs, `sys.dm_exec_query_stats` showed one execution, the last one, and a 4.7-second run in the middle was gone, though `sys.dm_exec_procedure_stats` still counted all five.

`sp_QuickieStore` pulls the same columns and a lot more for one procedure with `@procedure_name`, and `@execution_type_desc = 'aborted'`, 'exception', or 'failed' narrows it to the runs that didn't finish.

## Reading

- [Filtering To Specific Queries Using sp_QuickieStore](https://erikdarling.com/filtering-to-specific-queries-using-sp_quickiestore/)
- [sp_QuickieStore source](https://github.com/erikdarlingdata/DarlingData/tree/main/sp_QuickieStore) (GitHub)
- [sys.query_store_runtime_stats](https://learn.microsoft.com/en-us/sql/relational-databases/system-catalog-views/sys-query-store-runtime-stats-transact-sql) (Microsoft Learn)
- [Slow in the Application, Fast in SSMS?](https://www.sommarskog.se/query-plan-mysteries.html) (Erland Sommarskog)
