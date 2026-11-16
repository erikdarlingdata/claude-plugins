# The most dangerous ALTER

Where it sits in the chart: A table > An existing table > "Changing a data type" (The one that locks the table)

Changing a column's data type usually rewrites every row under a schema modification lock (a lock that blocks every other query on the table). If the column is part of an index, key, or constraint, most type changes don't rebuild them for you. The `ALTER` fails, and you have to drop them, alter the column, and put them back.

Widening a string column is the common exception. It works even on a clustering key (the table's sort key), as long as no foreign key points at the column or from it. On a big, busy table this is an outage with a change inside it.

## What it costs

Log proportional to table size, blocking for the duration, and dropping and recreating every index, constraint, and foreign key that touches the column. `ONLINE = ON` doesn't get you out of that. Drop the nonclustered indexes before the clustered one, or each gets rebuilt twice.

With Accelerated Database Recovery on, it logs more and rolls back instantly. Changing `int` to `bigint` on 200,000 uncompressed rows logged 41 to 52 MB instead of 36.5 MB. Budget a maintenance window, not a deploy slot.

## What it risks

Some conversions also silently change semantics: precision, collation, truncation behavior. The performance pain at least announces itself. The semantic drift doesn't.

## How fast it works

The safe pattern is slower on purpose: add the new column, backfill in batches, keep both in sync briefly, swap names, drop the old one. Days of calm instead of hours of hostage negotiation. For a clustering key that doesn't work, because every index depends on it: build a new table, copy in batches, sync, and swap names.

## When it backfires

Assuming every type change is a rewrite, or that none are. On a `ROW`- or `PAGE`-compressed table, `int` to `bigint` on a column with no index is metadata-only. On an uncompressed one it rewrites every row. Guessing which one you've got is how `int` to `bigint` on a billion-row table happens on a Tuesday. Test the exact change on a production-sized copy first.

## Evidence

Demo code and measurements: [evidence/the-most-dangerous-alter.md](../evidence/the-most-dangerous-alter.md). Open it to quote a number or run the demo.

## Reading

- [Changing a column from int to bigint, without downtime](https://am2.co/2019/12/changing-a-column-from-int-to-bigint-without-downtime/) (Andy Mallon)
- [Changing From Int to Bigint In SQL Server: Annoyances With Backfilling Tables](https://erikdarling.com/changing-from-int-to-bigint-in-sql-server-annoyances-with-backfilling-tables/)
- [The Great Integer To Bigint Compression Swindle](https://erikdarling.com/the-great-integer-to-bigint-compression-swindle/)
- [Things SQL Server vNext Should Address: Going From INT To BIGINT](https://erikdarling.com/things-sql-server-vnext-should-address-going-from-int-to-bigint/)
