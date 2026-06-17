---
title: "op mapping"
description: "Mapping rule management — configure how connector data maps to ontology entities (scope: ontology:read | ontology:write)"
sidebar:
  order: 8
---

# `op mapping`

Mapping rule management — configure how connector data maps to ontology entities (scope: ontology:read | ontology:write)

### `list`

List mapping rules for an entity type

**Usage:** `list [options] <entity-type>`

**Arguments:**

- `<entity-type>` — Ontology entity type slug (e.g. customer)

**Options:**

- `--connector <connector-id>` — Filter by connector ID


---

### `create`

Create a new mapping rule

**Usage:** `create [options] <entity-type>`

**Arguments:**

- `<entity-type>` — Ontology entity type slug

**Options:**

- `--connector <connector-id>` — Connector ID whose data this rule applies to
- `--source-field <path>` — Dot-path into the connector record, e.g. contact.email
- `--target-field <field-id>` — UUID or slug of the target ontology entity field (slug is resolved to UUID automatically)
- `--transform-type <type>` — How to map the value: direct|expression|constant|template (default: direct)
- `--transform <value>` — Expression/constant/template value. Required when --transform-type is not 'direct'.
- `--priority <n>` — Execution priority (0 = lowest, default: 0)


---

### `update`

Update a mapping rule by ID

**Usage:** `update [options] <entity-type> <rule-id>`

**Arguments:**

- `<entity-type>` — Ontology entity type slug
- `<rule-id>` — Mapping rule UUID

**Options:**

- `--source-field <path>` — New source field dot-path
- `--transform-type <type>` — New transform type: direct|expression|constant|template
- `--transform <value>` — New transform expression/constant/template (pass empty string to clear)
- `--active` — Enable the rule
- `--no-active` — Disable the rule
- `--priority <n>` — New priority value


---

### `delete`

Delete a mapping rule by ID

**Usage:** `delete [options] <entity-type> <rule-id>`

**Arguments:**

- `<entity-type>` — Ontology entity type slug
- `<rule-id>` — Mapping rule UUID


---

### `preview`

Preview how active mapping rules would transform sample connector data

**Usage:** `preview [options] <entity-type>`

**Arguments:**

- `<entity-type>` — Ontology entity type slug

**Options:**

- `--connector <connector-id>` — Connector ID to resolve mapping rules for
- `--sample <records.json>` — Path to JSON file containing an array of sample records

