# Normalize until it hurts, then measure: evidence

The card: [Normalize until it hurts, then measure](../cards/normalize-until-it-hurts-then-measure.md)

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
