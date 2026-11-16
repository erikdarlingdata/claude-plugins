# Unused since when?: evidence

The card: [Unused since when?](../cards/unused-since-when.md)

Before believing any zero in the usage stats, find out when they started counting:

```sql
SELECT
    osi.sqlserver_start_time,
    uptime_days =
        DATEDIFF
        (
            DAY,
            osi.sqlserver_start_time,
            SYSDATETIME()
        )
FROM sys.dm_os_sys_info AS osi;
```

That catches instance restarts only. A database restore, detach, or `AUTO_CLOSE` resets its counts too, so if any of those happened more recently, count from then. The 14- and 7-day thresholds are the guardrails `sp_IndexCleanup` enforces: it warns under 14 days and forces dedupe-only mode under 7.
