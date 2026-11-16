# Normalize until it hurts, then measure

Where it sits in the chart: A table > A new table > "One wide table or several narrow ones?" (When denormalizing is honest vs lazy)

Wide tables are convenient to write and expensive to read: rowstore pages hold whole rows, so every column stored in the row means fewer rows per page, and a scan of the table reads every one of those pages no matter which columns the query asked for.

And half the normalization picture is repeating groups: phone1, phone2, email1, email2 is a table wearing a column costume. EAV (entity, attribute, value: one row per attribute instead of one column per attribute) gets a deservedly bad rap as a general design. But for a small, closed set of attributes that all share one shape, like phone numbers and email addresses, it's exactly the right answer.

Denormalizing is fine when it's measured: you profiled the joins, they hurt, and you accepted the duplication. The lazy version is ninety columns because migrations are annoying.

## What it costs

More tables and more joins. Each join is cheap when the columns it joins on are indexed, but the bill comes from the ones that aren't.

## What it risks

Splitting tables without indexing the columns that join them back together. A normalized design with unindexed foreign key columns pays for every join with a scan.

## How fast it works

A contact table turns "who owns this phone number or email?" from an `OR` across every numbered column into one indexed seek. The fifth email address becomes an `INSERT` instead of a schema change.

## When it backfires

The split tables get pivoted back into the wide row on a hot path, once per customer, because the app still wants it that way. Or the value column turns heterogeneous, dates and numbers and text in one `nvarchar`, and every reader casts on the way out. The tell in a diff is a join back to the contact table on every read, with `CASE` or `TRY_CONVERT` wrapped around the value.

## Evidence

Demo code and measurements: [evidence/normalize-until-it-hurts-then-measure.md](../evidence/normalize-until-it-hurts-then-measure.md). Open it to quote a number or run the demo.

## Reading

- [Normalizing SQL Server Tables To Reduce Query Blocking](https://erikdarling.com/normalizing-to-reduce-blocking/)
- [How Avoiding Normalization Contributes To Skewed Data In SQL Server Tables](https://erikdarling.com/how-avoiding-normalization-contributes-to-skewed-data/)
