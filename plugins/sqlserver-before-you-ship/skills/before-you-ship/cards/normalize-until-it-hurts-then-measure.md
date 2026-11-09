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

We looked. There isn't one.

## Deeper dive

Here's the table everyone has somewhere:

```sql
CREATE TABLE
    dbo.Customers
(
    CustomerId integer NOT NULL,
    CustomerName nvarchar(100) NOT NULL,
    Phone1 nvarchar(20) NULL,
    Phone2 nvarchar(20) NULL,
    Email1 nvarchar(254) NULL,
    Email2 nvarchar(254) NULL,
    CONSTRAINT PK_Customers
        PRIMARY KEY (CustomerId)
);
```

And here's the query it forces you to write when someone gets in touch and you need to know who they are:

```sql
SELECT
    c.CustomerId,
    c.CustomerName
FROM dbo.Customers AS c
WHERE c.Phone1 = @Contact
OR    c.Phone2 = @Contact
OR    c.Email1 = @Contact
OR    c.Email2 = @Contact;
```

To make that fast you need an index on every one of those columns, and the plan glues the seeks together; skip the indexes and it's a scan. Either way, when Phone3 or Email3 shows up, and they always do, you get a schema change. You also get a tour of every query that touches contact details.

The EAV version keeps one row per contact, with the attribute (what kind of contact it is) in its own column:

```sql
CREATE TABLE
    dbo.CustomerContacts
(
    CustomerId integer NOT NULL,
    ContactType tinyint NOT NULL
        CONSTRAINT CK_CustomerContacts_ContactType
            CHECK (ContactType IN (1, 2)), /*1 = phone, 2 = email*/
    ContactValue nvarchar(254) NOT NULL,
    CONSTRAINT PK_CustomerContacts
        PRIMARY KEY (CustomerId, ContactType, ContactValue)
);

CREATE INDEX
    ContactValue_ContactType
ON dbo.CustomerContacts
    (ContactValue, ContactType);
```

```sql
SELECT
    cc.CustomerId,
    cc.ContactType
FROM dbo.CustomerContacts AS cc
WHERE cc.ContactValue = @Contact;
```

One index, one seek, whether the caller gave you a phone number or an email, and the fifth email address is an `INSERT`. The primary key stops the same contact from being attached to the same customer twice, and the [CHECK constraint](https://learn.microsoft.com/en-us/sql/relational-databases/tables/create-check-constraints) keeps the list of attributes closed.

That closed list is what makes this the good kind of EAV: a small set of attributes that all share one shape, which street addresses don't. They have parts (street, city, postal code), and each part wants its own type and its own rules, so addresses get their own table with real columns.

The bad kind of EAV is the one with an open-ended attribute list. Its value column has to hold dates, numbers, and text all at once.

## Reading

- [Normalizing SQL Server Tables To Reduce Query Blocking](https://erikdarling.com/normalizing-to-reduce-blocking/)
- [How Avoiding Normalization Contributes To Skewed Data In SQL Server Tables](https://erikdarling.com/how-avoiding-normalization-contributes-to-skewed-data/)
