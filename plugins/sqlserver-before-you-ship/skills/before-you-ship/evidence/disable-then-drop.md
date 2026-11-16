# Disable, then drop: evidence

The card: [Disable, then drop](../cards/disable-then-drop.md)

Disabling keeps the definition and throws away the data, so the index stops costing you on writes:

```sql
ALTER INDEX
    IndexName
ON dbo.TableName
DISABLE;
```

Changed your mind? A rebuild puts it back exactly as it was:

```sql
ALTER INDEX
    IndexName
ON dbo.TableName
REBUILD;
```

If foreign keys came down with it, the rebuild leaves them disabled and untrusted. Turn each one back on, with a check of existing rows, so the optimizer trusts it again:

```sql
ALTER TABLE
    dbo.ChildTable
WITH CHECK
CHECK CONSTRAINT
    FK_ChildTable_TableName;
```

The `REBUILD` is also the maintenance trap. Anything that rebuilds a disabled index, including `ALTER INDEX ALL ... REBUILD`, turns it back on. Before an unattended job gets there, look at what's sitting disabled:

```sql
SELECT
    schema_name = s.name,
    table_name = t.name,
    index_name = i.name,
    i.type_desc
FROM sys.indexes AS i
JOIN sys.tables AS t
  ON t.object_id = i.object_id
JOIN sys.schemas AS s
  ON s.schema_id = t.schema_id
WHERE i.is_disabled = 1
ORDER BY
    s.name,
    t.name,
    i.name;
```
