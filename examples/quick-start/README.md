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
op connector create --from-file configs/connector-rest-api.json
```

This registers a connector named `jsonplaceholder-api` that knows how to fetch user records from `https://jsonplaceholder.typicode.com/users`.

You can also create a CSV connector for file-based imports:

```bash
op connector create --from-file configs/connector-csv.json
```

## Step 3: Define Your Data Model

Create a `Customer` entity that describes the shape of your data:

```bash
op entity create --from-file configs/entity-customer.json
```

This creates a `Customer` entity with fields for `id`, `name`, `email`, `company`, `phone`, and `created_at`. OnePlatform automatically provisions the underlying database table and generates the necessary APIs.

## Step 4: Create a Pipeline

Set up a pipeline that fetches data from the REST API, transforms it, and stores it in your Customer entity:

```bash
op pipeline create --from-file configs/pipeline-import.json
```

The pipeline has three steps:

1. **fetch** -- Reads data from the `jsonplaceholder-api` connector
2. **transform** -- Maps API response fields to your entity fields
3. **store** -- Writes the transformed records into the `customer` entity using upsert logic

To run the pipeline immediately:

```bash
op pipeline run "Import Customers from API"
```

## Step 5: Deploy an App

Create a fully functional CRUD dashboard for managing customer data:

```bash
op app create --from-file configs/app-dashboard.json
```

This generates a web application with search, pagination, export, and full create/edit/delete capabilities -- all configured declaratively in JSON.

## Step 6: Open the App

Launch the Customer Dashboard in your default browser:

```bash
op app open customer-dashboard
```

You should see a table of customer records with search, sorting, and pagination controls. Try creating a new customer, editing an existing one, or exporting the data to CSV.

## Automated Setup

If you prefer to run all the steps at once, use the included setup script:

```bash
chmod +x setup.sh
./setup.sh
```

Then open the dashboard:

```bash
op app open customer-dashboard
```

## What's Next?

Now that you have a working application, explore these other examples to go further:

- **[Data Pipeline Example](../data-pipeline/)** -- Build multi-step ETL pipelines with branching and error handling
- **[Plugin Development Example](../plugin-development/)** -- Create custom plugins to extend OnePlatform
- **[Custom App Example](../custom-app/)** -- Build a fully custom React frontend with the OnePlatform SDK
- **[Multi-Source Integration](../multi-source/)** -- Combine data from REST APIs, CSV files, and databases
- **[Real-Time Dashboard](../real-time-dashboard/)** -- Build dashboards with live-updating data via WebSockets

For full documentation, visit the [OnePlatform Docs](../../packages/docs/).
