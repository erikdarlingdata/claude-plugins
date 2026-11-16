# Choose your clustering on purpose

Where it sits in the chart: A table > A new table > "What's the key, and what's clustered?" (Identity, and int or bigint)

A clustered index isn't a separate thing pointing at your table. It IS the table, ordered by the key you pick. The rules: narrow, unique, static, and ever-increasing. An identity column, or a column whose default comes from a sequence, checks every box, which is why it's the default answer.

It's the wrong answer when the table already has a natural key that checks the same boxes, like an order number another system hands out in order, so cluster on that instead. An identity next to it is one more column in every row, and the natural key still needs a unique nonclustered index of its own. Queries that search by the natural key, which is most of them, seek that index and then look up the rest of the row in the clustered index.

If an identity does fit, the decision left to sweat is whether it's `int` or `bigint`.

## What it costs

`bigint` is 8 bytes to `int`'s 4, and the clustering key rides along in every nonclustered index on the table, but it's a cheap premium.

## What it risks

`int` tops out around 2.1 billion. If this table can plausibly see billions of rows, or a chatty insert pattern that burns identity values on rollbacks, start with `bigint`. Hitting the ceiling later means changing the clustering key's type, [the most dangerous ALTER](the-most-dangerous-alter.md) there is, on the busiest table you own.

## How fast it works

This choice is free at `CREATE TABLE`. That's the last time it's free.

## When it backfires

`bigint` on every key of every table, including small lookup tables that will never see a million rows. The extra 4 bytes ride along in every nonclustered index on the table and in every foreign key column that points at it. Or a natural key that turns out not to be static, like an account number that gets renumbered when the upstream system is replaced. Changing a clustering key value moves the row, and every nonclustered index on the table carries that value and has to change with it.

## Evidence

Demo code and measurements: [evidence/choose-your-clustering-on-purpose.md](../evidence/choose-your-clustering-on-purpose.md). Open it to quote a number or run the demo.

## Reading

- [Starting SQL: Picking Clustered Indexes For Tables](https://erikdarling.com/starting-sql-picking-clustered-indexes/)
- [Software Vendor Mistakes With SQL Server: Using Integers Instead Of Big Integers For Identity Columns](https://erikdarling.com/software-vendor-mistakes-with-sql-server-using-integers-instead-of-big-integers-for-identity-columns/)
