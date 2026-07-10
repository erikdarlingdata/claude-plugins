# Darling Data — Claude Code plugins

A [Claude Code plugin marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
from [Darling Data](https://erikdarling.com).

```
/plugin marketplace add erikdarlingdata/claude-plugins
```

## Plugins

### `sqlserver-query-plans`

Teaches Claude to read a SQL Server execution plan and say what is actually slow,
and why.

```
/plugin install sqlserver-query-plans@erikdarling
```

Point Claude at a `.sqlplan` file and ask. The skill is model-invoked — you do not
need to call it explicitly.

The hard part of plan analysis is not spotting operators. It is knowing which
numbers mean what they appear to mean. This plugin is built mostly out of the
conclusions that sound authoritative and are wrong:

- **Cost percentages are estimates in every plan**, including actual plans.
  Nothing recomputes them after execution. The 97%-cost operator is routinely not
  the slow one, and an operator shown at 0% can consume the entire runtime.
- **Row-mode operator times are cumulative.** Ranking operators by raw
  `ActualElapsedms` ranks them by depth and always crowns the root node. Batch
  mode reports standalone times. Exchange operators report times that are close
  to meaningless.
- **`EstimateRows` is per-execution; `ActualRows` is a total.** Without dividing
  by `ActualExecutions`, the inner side of every nested loop looks
  catastrophically underestimated when it may have estimated perfectly.
- **Missing-index requests are hints, not DDL.** Equality columns come out in
  arbitrary order, existing indexes are ignored, and the `Impact` figure is a
  percentage of an estimated cost.
- **A scan is not a defect and a seek is not a virtue.** Judge by rows touched
  and time spent.

It also ships `scripts/extract.py`, which flattens a `.sqlplan` into a compact
digest. This is not a convenience:

- `.sqlplan` files are **UTF-16**, so `grep` silently matches nothing and reports
  no error. A negative result from `grep` on a plan file is worthless.
- Some plans are UTF-8 bytes that still declare `encoding="utf-16"`, because they
  were opened and re-saved. Strict XML parsers reject them.
- A trivial two-table join is 120 KB. Real plans run to megabytes. Reading one
  into context wastes the context and still misses things.

The extractor handles the encoding, computes correct self-time attribution
(subtracting children in row mode, within a thread rather than across threads in
parallel plans, and not at all in batch mode), normalizes cardinality per
execution, and recognizes the optimizer's default-guess selectivity fingerprints.
`--node N` drills into a single operator; `--sql` recovers full statement text.

Requires Python 3 (standard library only). Without it, the skill degrades to a
documented `grep`-based fallback and says plainly what it cannot determine.

## About

Built by [Erik Darling](https://erikdarling.com) at Darling Data. SQL Server
consulting, training, and free tools: **https://erikdarling.com**

## License

MIT
