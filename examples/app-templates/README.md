# App Templates

## What are App Templates?

App Templates are pre-built, no-code application blueprints for OnePlatform. Each
template is a self-contained JSON configuration that the App Service renders into a
fully functional web application. You do not need to write any frontend code --
templates declaratively describe pages, components, data bindings, and user
interactions.

Templates are designed to be composed. You can start from a single template such as
`crud-admin` and later combine it with `dashboard` and `form-builder` in a
`custom-app` that ties everything together with shared navigation and a unified theme.

### Key concepts

| Concept | Description |
|---------|-------------|
| **Template** | A JSON file that declares the layout, components, and data bindings for a complete application or page. |
| **Entity schema** | A shared definition of a data model (e.g. `Customer`) that templates bind to. |
| **Theme** | A JSON file describing colors, typography, spacing, and dark-mode overrides. |
| **Data binding** | Each component declares which entity type and fields it reads or writes. |
| **Permissions** | Role-based access control applied at the template level and per-action. |

### Directory structure

```
app-templates/
  README.md                         # This file
  apps/
    crud-admin.json                 # Template 1 — CRUD Admin panel
    dashboard.json                  # Template 2 — Dashboard with KPIs
    form-builder.json               # Template 3 — Multi-step forms
    custom-app.json                 # Custom App — combined navigation
  shared/
    entity-schema.json              # Customer entity definition
    theme.json                      # Custom branding and colors
```

---

## Template 1: CRUD Admin

A data-table-driven admin panel for managing records. Includes search and filters,
sortable columns, row-level and bulk actions, a detail side panel, and create/edit
forms.

### Features

- **Data table** with pagination (25 rows/page), column sorting, and full-text search.
- **Filter bar** for status, tier, and date range.
- **Create form** with field validation (required, format, min/max length).
- **Edit form** inherits the create form layout and pre-fills values.
- **Detail panel** slides in from the right with sectioned field groups.
- **Bulk actions** -- export selected rows or delete in batch.
- **Role-based permissions** -- viewers can read, editors can create/update, admins
  can delete.

### Data binding

The template binds to the `Customer` entity defined in `shared/entity-schema.json`.
Columns map to entity fields, filters map to indexed fields, and forms map to
writable fields.

**File:** `apps/crud-admin.json`

---

## Template 2: Dashboard

An analytics dashboard with KPI cards, charts, and date-range filters. Useful for
monitoring business metrics at a glance.

### Features

- **4 KPI cards** showing total customers, monthly recurring revenue, active
  subscriptions, and churn rate.
- **Line chart** of revenue over time (last 12 months).
- **Bar chart** of customers by subscription tier.
- **Pie chart** of customer status distribution.
- **Recent activity table** showing the last 10 events.
- **Date range filter** that updates all widgets simultaneously.
- **Auto-refresh** every 60 seconds to keep metrics current.

### Data binding

Each widget declares its own data query. KPI cards use aggregate queries against the
`Customer` entity. Charts use time-series and group-by queries.

**File:** `apps/dashboard.json`

---

## Template 3: Form Builder

A multi-step form with conditional logic, field validation, and a review step before
submission. Ideal for onboarding flows, intake forms, or survey collection.

### Features

- **4-step wizard**: Contact Info, Company Details, Preferences, Review & Submit.
- **Progress indicator** showing current step and completion percentage.
- **Field-level validation** with inline error messages.
- **Conditional fields** -- e.g. the "Other" text field appears only when
  "Other" is selected in a dropdown.
- **Review step** that summarizes all entered data before submission.
- **Auto-save** to local storage so users can resume incomplete forms.
- **Success page** with a confirmation message and a link to view the
  submitted record.

### Data binding

On submission the form creates a new `Customer` entity. Each field maps directly to
the entity schema.

**File:** `apps/form-builder.json`

---

## Custom App: Combined Navigation

A complete application that combines all three templates under a single shell with
shared navigation, a sidebar menu, and a unified theme.

### Features

- **Sidebar navigation** with links to Dashboard, Customers (CRUD), and
  New Customer (Form Builder).
- **Top bar** with the company logo, breadcrumbs, user avatar, and a
  theme-mode toggle (light/dark).
- **Tab-based sub-navigation** within the Customers section (All, Active,
  Leads, Churned).
- **Shared theme** loaded from `shared/theme.json`.
- **Permission-aware** -- menu items are hidden if the user lacks the
  required role.

### Structure

```
 ┌──────────────────────────────────────────────────┐
 │  Top Bar  [Logo]  [Breadcrumbs]   [User] [Mode] │
 ├────────┬─────────────────────────────────────────┤
 │        │                                         │
 │  Side  │        Page Content                     │
 │  bar   │   (Dashboard / CRUD / Form)             │
 │        │                                         │
 │  Menu  │                                         │
 │        │                                         │
 └────────┴─────────────────────────────────────────┘
```

**File:** `apps/custom-app.json`

---

## How to Customize Themes and Branding

### Using the shared theme

Every template references `shared/theme.json` via a `$ref`. Editing that file
changes all templates at once. The theme file controls:

| Property | Purpose |
|----------|---------|
| `primaryColor` | Buttons, links, active states |
| `secondaryColor` | Accents, secondary buttons, badges |
| `fontFamily` | Body text and headings |
| `logo` | Top-bar logo image path |
| `darkMode` | Whether the app starts in dark mode |

### Overriding per template

Add a `theme` block directly inside any template JSON to override specific values:

```json
{
  "theme": {
    "$ref": "../shared/theme.json",
    "overrides": {
      "primaryColor": "#059669",
      "darkMode": false
    }
  }
}
```

### Dark-mode palette

The theme file includes a full `darkMode.colors` section. When `darkMode` is `true`,
these colors replace the light-mode defaults automatically. To customize:

1. Open `shared/theme.json`.
2. Edit the values under `darkMode.colors`.
3. Reload the app -- no rebuild needed.

### Typography

The default font stack is `Inter, system-ui, -apple-system, 'Segoe UI', Roboto,
sans-serif`. To change it, update `typography.fontFamily` and ensure the font is
loaded via a `<link>` tag or an `@font-face` declaration in your deployment.

### Importing in the UI

1. Navigate to **Apps > Templates** in OnePlatform.
2. Click **Import Template**.
3. Select a JSON file from this directory.
4. The app will be live immediately at its configured `slug` path.

### Importing from the CLI

```bash
# Import a single template
npx @oneplatform/cli app import apps/crud-admin.json

# Import all templates plus the shared theme
npx @oneplatform/cli app import apps/*.json --theme shared/theme.json --entity shared/entity-schema.json
```

### Importing from the SDK

```typescript
import { OnePlatform } from '@oneplatform/sdk';

const client = new OnePlatform({ apiKey: process.env.OP_API_KEY });

// Import a template
const app = await client.apps.import('./apps/dashboard.json');
console.log(`App "${app.name}" is live at /${app.slug}`);
```
