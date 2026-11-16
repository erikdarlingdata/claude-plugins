# Start with page compression

Where it sits in the chart: An index > A new index > "Should it be compressed?" (ROW, PAGE, and what they cost)

Row compression stores each value in only the bytes it needs. Page compression does that too, then shares common prefixes and repeated values across each page. In the test in the evidence file, page compression shrank a covering index from 138 MB to 42 MB. Compressed pages stay compressed in memory, so the same buffer pool (the memory SQL Server keeps data pages in) holds about three times as much of that index. That matters most where there's more data than memory, like the buffer pool cap on **Standard Edition**: 256 GB on **SQL Server 2025**, and 128 GB before it.

The price is CPU: reading a compressed page means unpacking it, and changing a row means packing it again. Unless the server is already short on CPU, that's usually a good trade, which is why page compression is a sensible default for new indexes.

## What it costs

CPU. Reading a compressed page means unpacking it, and changing a row means packing it again. In a test, a warm scan with nothing else to do used a half to two-thirds more CPU with page compression, and updating an included column used 10 to 33% more.

Applying it to an existing index takes a rebuild. `DATA_COMPRESSION` is stored with the index, so later rebuilds keep it without being told again.

## What it risks

Only data stored in the row gets compressed. Off-row LOB data (long values like big `nvarchar(max)` strings, kept on pages of their own) doesn't: in a test, page compression left 48,002 LOB pages exactly as they were.

A page-compressed heap only page compresses rows put there by a bulk load, a rebuild, or an insert with `TABLOCK` into a heap with no nonclustered indexes. A plain insert of 500,000 rows got row compression and nothing more, 2,318 pages against 982 (see [Heaps are for staging](heaps-are-for-staging.md)).

Page-compressed pages start out full, so updates that make compressed values longer split them. In a test, updating 10% of the rows split nearly every page of a page-compressed index, doubling it from 42 MB to 86 MB, and logged 113 MB against 78 MB uncompressed. `FILLFACTOR = 80` prevented the splits, but fill factor is only applied at create and rebuild, so once writes use up that space, pages split again.

## How fast it works

In a test, a covering index on two million orders took 138 MB uncompressed, 98 MB with row compression, and 42 MB with page compression, on disk and in the buffer pool. A scan from disk read 5,415 pages instead of 17,645, so the same memory holds about three times as much of the index. Inserting 200,000 rows wrote 56 MB of log instead of 127 MB, with a little less CPU. Only the index was compressed in each copy, not the table under it.

## When it backfires

Turning it on for a table that's mostly `nvarchar(max)` stored off-row, rebuilding it over a weekend, and saving 10 pages.

## Evidence

Demo code and measurements: [evidence/start-with-page-compression.md](../evidence/start-with-page-compression.md). Open it to quote a number or run the demo.

## Reading

- [Compressed Indexes And The Buffer Pool In SQL Server](https://erikdarling.com/compressed-indexes-and-the-buffer-pool/)
- [Software Vendor Mistakes With SQL Server: Not Taking Advantage Of Index Compression](https://erikdarling.com/software-vendor-mistakes-with-sql-server-not-taking-advantage-of-index-compression/)
- [Creating SQL Server Indexes: Stored Options vs. Creation Options](https://erikdarling.com/creating-sql-server-indexes-stored-options-vs-creation-options/)
- [Can Rowstore Compression Beat Columnstore Compression In SQL Server?](https://erikdarling.com/can-rowstore-compression-beat-columnstore-compression/) (Joe Obbish)
- [Data compression](https://learn.microsoft.com/en-us/sql/relational-databases/data-compression/data-compression) (Microsoft)
