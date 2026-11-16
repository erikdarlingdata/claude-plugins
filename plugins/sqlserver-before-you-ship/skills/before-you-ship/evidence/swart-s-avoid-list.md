# Swart's avoid list: evidence

The card: [Swart's avoid list](../cards/swart-s-avoid-list.md)

Plans are the other reason Swart gives. He found `MERGE` more prone to bad plans than other DML (`INSERT`, `UPDATE`, and `DELETE` statements). A `WHEN NOT MATCHED BY SOURCE` clause processed the whole target table, and a growing target eventually lost its index seek to a scan. His trade: if separate statements take two seconds where `MERGE` takes one, but they're predictable and easy to test, the extra second is worth paying.

The list is current as of Swart's 2021 post, for **SQL Server 2019** and later. Check it against your version before relying on any single item being fixed or not.

Sources by Michael J. Swart: [What To Avoid If You Want To Use MERGE](https://michaeljswart.com/2021/08/what-to-avoid-if-you-want-to-use-merge/) (2021), [Be Careful with the Merge Statement](https://michaeljswart.com/2012/08/be-careful-with-the-merge-statement/) (2012). The list he started from, by Aaron Bertrand: [Use Caution with SQL Server's MERGE Statement](https://www.mssqltips.com/sqlservertip/3074/use-caution-with-sql-servers-merge-statement/), with Aaron's roundup at [sqlblog.org/merge](https://sqlblog.org/merge).
