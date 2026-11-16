# Reporting tables want columnstore

**Requires:** a nonclustered rowstore index on a clustered columnstore table needs **SQL Server 2016** or later. Batch mode on rowstore tables needs **SQL Server 2019** or later on **Enterprise** or its Developer edition.

Where it sits in the chart: A table > A new table > "Will it mostly be summed and counted?" (Reporting, history, and fact tables (one row per recorded event), read a few columns at a time)

Rowstore tables keep each row's data together, which suits finding one order and changing it. Reporting reads the other way: a few columns from millions of rows, summed or counted.

A clustered columnstore index stores each column separately, compressed, in groups of about a million rows. Queries read only the columns they use, in batch mode, many rows at a time. In a test, four million sales took 178 MB as rows and 42 MB as columns, and a revenue-by-month query read 914 pages instead of 22,968.

It's a poor fit for tables that get read and changed one row at a time.

## What it costs

Loading in big batches. An insert of 102,400 rows or more gets compressed straight into columnstore. Smaller ones land in an uncompressed delta rowgroup (a holding area for new rows). The tuple mover (a background task) compresses it once it closes at about a million rows. In a test, a 1,000-row insert sat in an `OPEN` delta rowgroup, stored as rows.

## What it risks

Single-row work. Finding one sale by id read 3 pages from the rowstore table and 1,449 from the columnstore copy, because there's no B-tree to seek into. Since **SQL Server 2016**, a nonclustered rowstore index on a clustered columnstore table covers single-row lookups, at the write cost on [the write tax card](the-write-tax.md). Updates are a delete plus an insert, and deleted rows stay in their compressed segments, marked in a bitmap, until index maintenance clears them.

## How fast it works

Immediate for the reports. The revenue query took under 40 ms on the columnstore copy, on one thread, and 230 to 280 ms on the rowstore table in row mode. **SQL Server 2019** and later can also use batch mode on rowstore tables, on **Enterprise edition** and its **Developer edition** (**Enterprise Developer**, from **SQL Server 2025**). That brought the rowstore table to 130 to 155 ms, still about four times as long as the columnstore copy, reading 25 times the pages.

## When it backfires

Trickle loads and steady deletes. A table fed a few rows at a time keeps its newest rows in uncompressed delta rowgroups. Deleted rows still get read and filtered out on every scan.

`ALTER INDEX` ... [REORGANIZE](https://learn.microsoft.com/en-us/sql/t-sql/statements/alter-index-transact-sql) compresses closed delta rowgroups and cleans up some deleted rows, and `WITH (COMPRESS_ALL_ROW_GROUPS = ON)` compresses the open one too. `REBUILD` clears them all. Schedule one or the other, or the table slides back toward rowstore speed.

## Evidence

Demo code and measurements: [evidence/reporting-tables-want-columnstore.md](../evidence/reporting-tables-want-columnstore.md). Open it to quote a number or run the demo.

## Reading

- [Learn T-SQL With Erik: Columnstore Modifications](https://erikdarling.com/learn-t-sql-with-erik-columnstore-modifications/)
- [Column Store, Delta Store, and More](https://erikdarling.com/column-store-delta-store-and-more/)
