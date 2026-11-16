# Mind your query consumers: evidence

The card: [Mind your query consumers](../cards/mind-your-query-consumers.md)

Two demos elsewhere in the chart show the added-column problem in action. In [Widen before you add](../cards/widen-before-you-add.md), a query asks for one column its index doesn't have. The plan picks up 2,000 key lookups: about 6,100 reads, where the widened index needs 12. Whether SQL Server keeps doing lookups or gives up and scans the table depends on how many rows the parameter brings back.

[Dev lied to you](../cards/dev-lied-to-you.md) shows what happens when a plan like that gets cached and reused for values it wasn't built for.
