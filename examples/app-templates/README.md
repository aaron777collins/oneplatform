# App Templates: Build Apps Without Code

This directory contains ready-to-use app configurations for the OnePlatform no-code app builder. Each configuration file defines a complete application -- its pages, components, data bindings, forms, permissions, and theme -- using JSON alone. No TypeScript or React knowledge is required.

All examples manage **Customer** records and share a common entity schema and theme so you can see how the same data works across different app types.

## Directory Structure

```
app-templates/
  apps/
    crud-admin.json       CRUD admin panel for managing customers
    dashboard.json        Analytics dashboard with charts and KPIs
    form-builder.json     Multi-step onboarding form
    custom-app.json       Multi-page app combining all three templates
  shared/
    entity-schema.json    Customer entity definition used by all apps
    theme.json            Branding and visual theme configuration
  README.md               This guide
```

## Prerequisites

Before using these templates you need a running OnePlatform instance and the CLI installed:

```bash
npm install -g @oneplatform/cli
```

You also need the **Customer** entity registered in your tenant's ontology. The entity definition is in `shared/entity-schema.json`. Register it with:

```bash
op ontology create --file shared/entity-schema.json
```

## Quick Start

Every app can be created in two steps:

```bash
# 1. Create the app by name, using the desired template
op app create --name "Customer Admin" --template crud-admin --slug customer-admin

# 2. Get the app URL
op app get customer-admin
```

The platform creates the app using the specified template. Navigate to the URL shown in the output to access the app.

To customize the app beyond what the template provides, use the visual App Builder in the platform UI (navigate to **Apps > Builder**) or deploy a custom bundle with `op app deploy`.

---

## Available Templates

### 1. CRUD Admin Panel (`apps/crud-admin.json`)

A data-table-driven admin panel for managing Customer records. Use this template when your team needs to view, search, create, edit, and delete records through a table-based UI.

**What it includes:**

- **Page header** with breadcrumbs, "Add Customer" button, and "Export CSV" action
- **Filter bar** with text search, status dropdown, tier dropdown, and date range picker
- **Data table** with sortable columns (Name, Email, Company, Status, Tier, Revenue, Created), row selection checkboxes, and pagination (25 rows per page)
- **Detail panel** that slides in from the right when you click "View" on a row, showing contact info, account details, address, and metadata
- **Create form** with four sections: Contact Information, Account Settings, Address, and Notes
- **Edit form** that reuses the create form layout with pre-filled values
- **Row actions**: View, Edit (requires `entity:update`), Delete with confirmation (requires `entity:delete`)
- **Bulk actions**: Export Selected, Delete Selected with confirmation dialog
- **Real-time updates** via WebSocket subscription -- changes made by other users appear automatically

**Roles and permissions:**

| Role   | Can view | Can create | Can edit | Can delete |
|--------|----------|------------|----------|------------|
| viewer | Yes      | No         | No       | No         |
| editor | Yes      | Yes        | Yes      | No         |
| admin  | Yes      | Yes        | Yes      | Yes        |

---

### 2. Analytics Dashboard (`apps/dashboard.json`)

A read-only analytics view showing customer KPIs, charts, and trends. Use this template when stakeholders need a high-level overview without access to raw data editing.

**What it includes:**

- **Four KPI cards** at the top: Total Customers (+12.5%), Active Accounts (+8.3%), Total Revenue (+15.2%), Churned in last 30 days (-3.1%) -- each with percentage change indicators and color-coded variants
- **Line chart**: Revenue Trend over the last 12 months
- **Pie chart**: Customer Status breakdown (active, inactive, lead, churned) with a bottom legend
- **Bar chart**: Customers grouped by Subscription Tier (Free, Starter, Professional, Enterprise)
- **Bar chart**: New customer signups over the last 30 days
- **Data table**: 10 most recently added customers with name, email, company, tier, status, and join date
- **Date range filter** in the header to scope all metrics to a specific period
- **Auto-refresh** every 60 seconds so the dashboard stays current without manual reload

**Chart types available:**

| Type | Best for | Example in this config |
|------|----------|----------------------|
| `line` | Trends over time | Revenue trend |
| `bar` | Comparing categories | Customers by tier, daily signups |
| `pie` | Part-of-whole breakdowns | Status distribution |

**Aggregation types used:**

| Expression | Description |
|-----------|-------------|
| `count(*)` | Count all records |
| `count(field='value')` | Count records matching a condition |
| `sum(field)` | Sum a numeric field across all records |
| `groupBy` with `count` | Group records by a field and count per group |
| `groupBy` with `sum` | Group records by a field and sum a numeric field per group |

---

### 3. Form Builder (`apps/form-builder.json`)

A multi-step form for onboarding new customers. Use this template when you need a guided data entry experience with validation, conditional fields, file uploads, and a review step before submission.

**What it includes:**

- **Four steps** with a visual progress bar:
  1. **Contact Information** -- first name, last name, email (validated), phone, profile photo upload (PNG/JPEG/WebP, max 5 MB)
  2. **Company Details** -- company name plus address fields that only appear when a company name is entered (conditional visibility)
  3. **Account Setup** -- subscription tier as radio buttons with descriptions, status dropdown, tag input with suggestions. The "Initial Revenue" field only appears when status is set to "Active" (conditional visibility)
  4. **Notes & Review** -- free-text notes field plus a read-only summary of all values entered in previous steps
- **Field validation**: required fields, min/max length, email format, regex patterns with custom error messages, file size limits
- **File upload**: profile photo upload accepting PNG, JPEG, and WebP up to 5 MB
- **Conditional visibility**: fields appear or hide based on other field values
- **Success screen** with two actions: "Register Another Customer" (resets the form) and "View All Customers" (navigates to the admin panel)
- **Submission workflow** with five server-side steps: validate fields, check for duplicate email, upload avatar, create record, trigger welcome email pipeline
- **Sidebar tips panel** guiding users through the form

**Conditional visibility rules:**

| When this field... | Has this condition... | Then show... |
|---|---|---|
| `company` | is not empty | Address fields (street, city, state, postal code, country) |
| `status` | equals `active` | Initial Revenue input field |

**Field width options:**

| Value | Grid columns | Use for |
|-------|-------------|---------|
| `full` (default) | 12 | Single fields on their own line |
| `half` | 6 | Two fields side by side (e.g. first name + last name) |
| `quarter` | 3 | Compact fields (e.g. state + postal code) |

**Submission workflow steps:**

```
1. validate        Run server-side validation on all fields
2. check-duplicate Query for existing customer with same email
3. upload-avatar   Upload profile photo (if provided)
4. create-record   Create the Customer entity record
5. send-welcome    Trigger the welcome email pipeline
```

---

### 4. Custom Multi-Page App (`apps/custom-app.json`)

A complete customer management application that combines a dashboard, admin panel, and onboarding form into a single app with sidebar navigation and role-based page access.

**What it includes:**

- **Sidebar navigation** with three pages: Dashboard, Customers, New Customer, plus a Help link
- **Dashboard page**: four KPI cards, revenue trend line chart, status pie chart, recent customers table (5 rows), auto-refresh every 60 seconds
- **Customers page**: full CRUD admin with filter bar (search, status, tier, date range), sortable data table (25 rows), detail panel with three sections, edit form, row actions (View, Edit, Delete), CSV export
- **Onboarding page**: three-step form (Contact Info, Account Setup, Review) with a Markdown tips sidebar, success actions
- **Role-based page visibility**: viewers see only the Dashboard; editors see all three pages; admins have full access including delete

**Navigation structure:**

```
 +-------------------------------------------+
 |  [Logo]  Customer Hub                     |
 +----------+--------------------------------+
 |          |                                |
 | Dashboard|   [Page content changes       |
 | Customers|    based on selected nav item] |
 | New Cust.|                                |
 |          |                                |
 |----------|                                |
 | Help     |                                |
 +----------+--------------------------------+
```

**Page visibility by role:**

| Role   | Dashboard | Customers | New Customer |
|--------|-----------|-----------|--------------|
| viewer | Yes       | No        | No           |
| editor | Yes       | Yes       | Yes          |
| admin  | Yes       | Yes       | Yes          |

---

## Shared Configuration

### Entity Schema (`shared/entity-schema.json`)

Defines the **Customer** entity used by all four apps. It contains 16 fields:

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string (UUID) | Yes | Auto-generated primary key |
| `firstName` | string | Yes | 1-100 characters |
| `lastName` | string | Yes | 1-100 characters |
| `email` | string (email) | Yes | Unique across tenant |
| `phone` | string (phone) | No | E.164 format (e.g. +14155551234) |
| `company` | string | No | Up to 200 characters |
| `status` | enum | Yes | `active`, `inactive`, `lead`, `churned` (default: `lead`) |
| `tier` | enum | Yes | `free`, `starter`, `professional`, `enterprise` (default: `free`) |
| `totalRevenue` | number (currency) | No | Lifetime revenue in USD cents (default: 0) |
| `lastContactedAt` | date-time | No | ISO 8601 timestamp |
| `tags` | array of strings | No | Free-form labels for segmentation |
| `address` | object | No | street, city, state, postalCode, country |
| `notes` | string | No | Up to 5,000 characters |
| `avatarUrl` | string (URI) | No | Profile image URL |
| `createdAt` | date-time | Yes | Read-only, set automatically by the platform |
| `updatedAt` | date-time | Yes | Read-only, set automatically by the platform |

The schema also defines database indexes for common query patterns: email uniqueness, status filtering, tier filtering, date sorting, and name search.

### Theme (`shared/theme.json`)

Controls the visual appearance of all apps. You can customize:

- **Branding**: app name ("Acme CRM"), logo URL, favicon URL, support email
- **Colors**: 16 named color tokens for primary, accent, background, foreground, border, success, warning, and danger states
- **Typography**: font family (Inter), monospace font (JetBrains Mono), base size (16px), heading sizes and weights for h1-h4
- **Spacing**: page padding (24px), section gaps (32px), card padding (20px), compact mode (12px)
- **Border radius**: small (4px), medium (6px), large (8px), pill (9999px)
- **Shadows**: card, dropdown, and modal shadow definitions
- **Dark mode**: a complete alternate color palette that activates automatically based on the user's system preference

To apply your own brand, edit the values in `shared/theme.json`. The `$ref` links in each app config pick up the changes automatically.

---

## How to Customize

### Changing the entity

All apps reference the entity via `"$ref": "../shared/entity-schema.json"`. To use a different entity:

1. Create a new schema file (e.g. `shared/order-schema.json`) following the same format
2. Update the `entity.$ref` and `entity.slug` in each app config
3. Update column definitions, form fields, filter keys, and data bindings to match your new fields
4. Register the entity: `op ontology create --file shared/order-schema.json`

### Adding a page to the custom app

Open `apps/custom-app.json` and add an entry to the `pages` array:

```json
{
  "id": "reports",
  "title": "Reports",
  "path": "/reports",
  "permission": "entity:read",
  "layout": {
    "rows": [
      {
        "id": "report-header",
        "columns": [
          {
            "id": "report-header-col",
            "width": 12,
            "component": {
              "type": "PageHeader",
              "props": {
                "title": "Reports",
                "description": "Generated reports and export history."
              }
            }
          }
        ]
      }
    ]
  }
}
```

Then add a navigation item in the `navigation.items` array:

```json
{
  "id": "nav-reports",
  "label": "Reports",
  "icon": "FileBarChart",
  "path": "/reports",
  "page": "reports",
  "permission": "entity:read"
}
```

### Changing the theme

Edit `shared/theme.json` and change the color values. For example, to switch the primary color from blue to teal:

```json
{
  "colors": {
    "primary": "#0d9488",
    "ring": "#0d9488"
  }
}
```

All apps that reference the shared theme will pick up the change on the next deploy.

### Adding a filter

Find the `FilterBar` component in the page layout and add a new entry to the `filters` array:

```json
{
  "key": "company",
  "label": "Company",
  "type": "text",
  "placeholder": "Filter by company name..."
}
```

Then add the corresponding data binding:

```json
"dataBinding": {
  "entityType": "customer",
  "fieldMap": {
    "company": "company"
  }
}
```

### Adding a chart

Add a new column within a row in the dashboard layout:

```json
{
  "id": "my-chart-col",
  "width": 6,
  "component": {
    "type": "Chart",
    "props": {
      "chartType": "bar",
      "title": "Revenue by Tier",
      "height": 280,
      "series": [
        {
          "name": "Revenue",
          "field": "totalRevenue",
          "aggregation": "sum",
          "groupBy": "tier",
          "color": "#7c3aed"
        }
      ]
    },
    "dataBinding": {
      "entityType": "customer",
      "fieldMap": { "data": "records" }
    }
  }
}
```

Column widths in a row must sum to 12 or less. Adjust existing columns if needed.

### Adding a form field

To add a new field to any form, add an entry to the appropriate step's `fields` array:

```json
{
  "key": "referralSource",
  "label": "How did you hear about us?",
  "type": "select",
  "required": false,
  "options": [
    { "label": "Search engine", "value": "search" },
    { "label": "Social media", "value": "social" },
    { "label": "Friend or colleague", "value": "referral" },
    { "label": "Other", "value": "other" }
  ]
}
```

Make sure the field's `key` matches a field name in the entity schema, or add the field to the entity schema first.

---

## Available Components

These are the UI components you can place in any page layout. Each component is configured through its `props` object.

| Component | Category | Description |
|-----------|----------|-------------|
| `PageHeader` | Layout | Page title with description, breadcrumbs, and action buttons |
| `DataTable` | Data Display | Sortable, searchable, paginated table with row selection and actions |
| `StatCard` | Data Display | KPI card with title, value, percentage trend indicator, and color variant (`default`, `success`, `warning`, `danger`) |
| `StatusBadge` | Data Display | Color-coded status label (active, inactive, pending, error, warning) |
| `DetailPanel` | Data Display | Slide-out side panel for viewing a single record's details |
| `FilterBar` | Input | Row of composable filter controls (text search, select dropdown, date range picker, boolean toggle) |
| `EmptyState` | Layout | Placeholder shown when a list has no data |
| `Chart` | Charts | Line, bar, or pie chart with configurable data aggregation and color schemes |
| `MultiStepForm` | Input | Multi-step wizard form with validation, conditional fields, file upload, and review step |
| `HtmlBlock` | Custom | Raw HTML content block for custom markup |
| `MarkdownBlock` | Custom | Rendered Markdown content block supporting headings, lists, links, and formatting |

### Component layout model

Components are placed inside a 12-column grid system:

```
Row
  Column (width: 1-12)
    Component
  Column (width: 1-12)
    Component
```

Each row contains one or more columns. Each column has a `width` (1 through 12) that determines how much horizontal space it occupies. Column widths in a single row should sum to 12 for a full-width layout, or less if you want empty space on the right.

Common width patterns:

| Pattern | Widths | Use case |
|---------|--------|----------|
| Full width | 12 | Tables, headers, filter bars |
| Two equal columns | 6 + 6 | Side-by-side charts |
| Main + sidebar | 8 + 4 | Form with tips panel |
| Four equal cards | 3 + 3 + 3 + 3 | KPI stat cards |
| Wide + narrow | 9 + 3 | Large chart with small summary |

### Data bindings

Components that display entity data use a `dataBinding` object:

```json
"dataBinding": {
  "entityType": "customer",
  "fieldMap": {
    "data": "records",
    "value": "count(*)"
  }
}
```

- `entityType` names the entity slug from your ontology
- `fieldMap` maps component props to entity fields or aggregation expressions

---

## Deploying

### Create an app from a template

```bash
# Create by template name (the platform generates the app from built-in templates)
op app create --name "Analytics Dashboard" --template dashboard --slug customer-dashboard
op app create --name "Customer Onboarding" --template form-builder --slug customer-onboarding
op app create --name "Customer Hub" --template crud-admin --slug customer-hub
```

Available built-in templates: `crud-admin`, `dashboard`, `form-builder`. Template names map to the JSON files in the `apps/` directory.

### Create all example apps at once

```bash
op app create --name "Customer Admin" --template crud-admin --slug customer-admin
op app create --name "Customer Dashboard" --template dashboard --slug customer-dashboard
op app create --name "Customer Onboarding" --template form-builder --slug customer-onboarding
op app create --name "Customer Hub" --template crud-admin --slug customer-hub
```

### Update an existing app

To update an app's metadata (name, slug):

```bash
# There is no direct "update from config" command.
# Use the platform UI (Apps > Builder) to edit the app's layout and components,
# or redeploy a new bundle:
op app deploy customer-admin --file dist/bundle.tar.gz --wait
```

### Preview changes with the dev server

```bash
# Start a local dev server that proxies to the live platform
op app dev customer-admin --port 3100
```

Open `http://localhost:3100` to see the app against live data.

### Using the platform UI

1. Navigate to **Apps > Templates** in OnePlatform.
2. Click **Import Template**.
3. Select a JSON file from this directory.
4. The app will be live immediately at its configured `slug` path.

---

## Frequently Asked Questions

**Can I mix templates?**
Yes. The custom app example (`apps/custom-app.json`) shows how to combine dashboard, admin, and form pages in a single app. Each page is independent and can use any arrangement of components.

**Do I need to write code?**
No. All configuration is done through JSON. The platform's app builder reads the config and generates the React components automatically. If you need more control, you can also build apps with code using the `@oneplatform/app-sdk` package -- see the [dashboard-app example](../dashboard-app/) for a code-based approach.

**Can I use a different entity?**
Yes. Replace the `entity.$ref` in any app config to point to a different schema file, then update the field references in columns, forms, filters, and data bindings to match.

**How do permissions work?**
Each app config defines `roles` with associated `permissions`. The platform checks these against the current user's roles when rendering pages and actions. Buttons, pages, and navigation items that require permissions the user does not have are hidden automatically.

**Can I customize the theme per app?**
Yes. Instead of referencing the shared theme with `$ref`, you can inline the theme object directly in any app config to override specific values for that app only.

**What happens when the entity schema changes?**
Update `shared/entity-schema.json`, re-register it with `op ontology update customer --file shared/entity-schema.json` (replace `customer` with the entity type slug), and then update any app configs that reference the changed fields. The platform validates field references at deploy time and reports errors for any missing fields.

**How does real-time sync work?**
Apps with `"subscription": { "enabled": true }` open a WebSocket connection to the platform. When any user creates, updates, or deletes a record, all connected apps receive the event and refresh their data automatically. The `autoInvalidate` flag controls whether query caches are refreshed on each event.

---

## Further Reading

- [App Builder Design](../../docs/designs/) -- Architecture and design specs for the app builder system
- [App SDK Reference](../../packages/app-sdk/) -- React hooks (`useQuery`, `useMutation`, `useSubscription`, `useUser`, `usePermission`, `useAppStorage`), UI components (`DataTable`, `StatCard`, `FilterBar`, `DetailPanel`, `StatusBadge`, `PageHeader`, `EmptyState`), and TypeScript types
- [Frontend Components](../../packages/frontend/src/components/app-builder/) -- Visual builder palette, layout model, and code generator
- [Template Source Code](../../services/app/src/templates/) -- Server-side template definitions for `crud-admin`, `dashboard`, and `form-builder`
- [Dashboard App Example](../dashboard-app/) -- A code-based dashboard example using the app SDK directly with React
- [Branding Provider](../../packages/app-sdk/src/providers/BrandingProvider.tsx) -- How tenant branding is loaded and applied at runtime
