# OnePlatform Quick Start Guide

## What is OnePlatform?

OnePlatform is a unified data integration and application platform that lets you connect to any data source, model your business entities, build transformation pipelines, and deploy fully functional web applications -- all from configuration files and simple CLI commands. It eliminates the need to write boilerplate CRUD code by generating applications directly from your data models. Whether you are importing data from REST APIs, CSV files, or databases, OnePlatform handles ingestion, transformation, storage, and presentation in one cohesive workflow.

## Prerequisites

Before you begin, make sure you have the following installed:

- **Docker Desktop** (v4.0 or later) -- [download here](https://www.docker.com/products/docker-desktop/)
- **A terminal** -- Terminal.app (macOS), Windows Terminal, or any Linux terminal
- **OnePlatform CLI** (`op`) -- installed automatically when you start the platform

## Step 1: Start the Platform

From the OnePlatform project root, start all services with Docker Compose:

```bash
docker compose up -d
```

Wait for all services to be healthy (this takes about 30 seconds on first run):

```bash
docker compose ps
```

You should see all services in the `healthy` state before proceeding.

## Step 2: Create a Data Source

Create a REST API connector that pulls user data from the JSONPlaceholder test API:

```bash
op connector create \
  --plugin com.oneplatform.connector-rest-api \
  --name "jsonplaceholder-api" \
  --config configs/connector-rest-api.json
```

This registers a connector named `jsonplaceholder-api` that knows how to fetch user records from `https://jsonplaceholder.typicode.com/users`.

You can also create a CSV connector for file-based imports:

```bash
op connector create \
  --plugin com.oneplatform.connector-csv \
  --name "customer-csv-import" \
  --config configs/connector-csv.json
```

## Step 3: Define Your Data Model

Create a `Customer` entity that describes the shape of your data:

```bash
op ontology create --file configs/entity-customer.json
```

This creates a `Customer` entity with fields for `id`, `name`, `email`, `company`, `phone`, and `created_at`. OnePlatform automatically provisions the underlying database table and generates the necessary APIs.

## Step 4: Create a Pipeline

Set up a pipeline that fetches data from the REST API, transforms it, and stores it in your Customer entity:

```bash
op pipeline create --file configs/pipeline-import.json
```

The pipeline has three steps:

1. **fetch** -- Reads data from the `jsonplaceholder-api` connector
2. **transform** -- Maps API response fields to your entity fields
3. **store** -- Writes the transformed records into the `customer` entity using upsert logic

To run the pipeline immediately, first get the pipeline ID and then trigger it:

```bash
# List pipelines to find the ID
op pipeline list

# Trigger the pipeline (replace <pipeline-id> with the ID from above)
op pipeline trigger <pipeline-id> --wait
```

## Step 5: Deploy an App

Create a fully functional CRUD dashboard for managing customer data:

```bash
op app create --name "Customer Dashboard" --template crud-admin --slug customer-dashboard
```

This creates a web application with search, pagination, export, and full create/edit/delete capabilities.

## Step 6: Open the App

List your apps to find the URL for the Customer Dashboard:

```bash
op app list
op app get customer-dashboard
```

Navigate to the platform URL shown in the output. You should see a table of customer records with search, sorting, and pagination controls.

## Automated Setup

If you prefer to run all the steps at once, use the included setup script:

```bash
chmod +x setup.sh
./setup.sh
```

Once complete, list your apps to find the URL:

```bash
op app list
op app get customer-dashboard
```

## What's Next?

Now that you have a working application, explore these other examples to go further:

- **[Multi-Source ETL](../multi-source-etl/)** -- Combine data from multiple databases with field mapping rules
- **[Visual Pipeline Builder](../visual-pipeline/)** -- Import ready-made pipeline definitions into the UI
- **[App Templates](../app-templates/)** -- Deploy dashboards and CRUD admin panels from JSON configs
- **[Enterprise Auth](../enterprise-auth/)** -- Set up OIDC and LDAP authentication providers
- **[Custom Connector](../custom-connector/)** -- Build a plugin that connects to any data source

For full documentation, visit the [OnePlatform Docs](../../packages/docs/).
