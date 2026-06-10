-- docker/postgres/init.sql
--
-- Executed by postgres:16-alpine on first container start via
-- /docker-entrypoint-initdb.d/. Idempotent: uses CREATE IF NOT EXISTS
-- patterns so re-running is safe.
--
-- Ref spec §3 "PostgreSQL: Per-Service Schemas".

-- ─── Extension ───────────────────────────────────────────────────────────────
-- uuid-ossp provides uuid_generate_v4() used across all services for primary keys.
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Service Roles ───────────────────────────────────────────────────────────
-- Each service connects with its own dedicated role. Roles have LOGIN so they
-- can authenticate via PgBouncer. Passwords are set via ALTER ROLE at deploy
-- time using per-service env vars; the placeholder here prevents null-password
-- login. No role is a superuser or can create other roles or databases.

DO $$
BEGIN
  -- Auth Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'auth_service_role') THEN
    CREATE ROLE auth_service_role WITH LOGIN PASSWORD 'CHANGE_ME_auth';
  END IF;

  -- Ingestion Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ingestion_service_role') THEN
    CREATE ROLE ingestion_service_role WITH LOGIN PASSWORD 'CHANGE_ME_ingestion';
  END IF;

  -- Ontology Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'ontology_service_role') THEN
    CREATE ROLE ontology_service_role WITH LOGIN PASSWORD 'CHANGE_ME_ontology';
  END IF;

  -- Pipeline Service role
  -- Needs session-mode PgBouncer for advisory locks (spec §3 "PgBouncer Configuration").
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'pipeline_service_role') THEN
    CREATE ROLE pipeline_service_role WITH LOGIN PASSWORD 'CHANGE_ME_pipeline';
  END IF;

  -- Execution Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'execution_service_role') THEN
    CREATE ROLE execution_service_role WITH LOGIN PASSWORD 'CHANGE_ME_execution';
  END IF;

  -- App Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_service_role') THEN
    CREATE ROLE app_service_role WITH LOGIN PASSWORD 'CHANGE_ME_app';
  END IF;

  -- Logging Service role (highest write volume — 30 server connections, spec §3)
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'logging_service_role') THEN
    CREATE ROLE logging_service_role WITH LOGIN PASSWORD 'CHANGE_ME_logging';
  END IF;

  -- Plugin Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'plugin_service_role') THEN
    CREATE ROLE plugin_service_role WITH LOGIN PASSWORD 'CHANGE_ME_plugin';
  END IF;

  -- Gateway Service role
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gateway_service_role') THEN
    CREATE ROLE gateway_service_role WITH LOGIN PASSWORD 'CHANGE_ME_gateway';
  END IF;
END
$$;

-- ─── Schemas ─────────────────────────────────────────────────────────────────
-- One schema per service. No cross-schema writes except the single documented
-- exception below. Ref spec §3 table of schemas and owners.

CREATE SCHEMA IF NOT EXISTS auth       AUTHORIZATION auth_service_role;
CREATE SCHEMA IF NOT EXISTS ingestion  AUTHORIZATION ingestion_service_role;
CREATE SCHEMA IF NOT EXISTS ontology   AUTHORIZATION ontology_service_role;
CREATE SCHEMA IF NOT EXISTS pipeline   AUTHORIZATION pipeline_service_role;
CREATE SCHEMA IF NOT EXISTS execution  AUTHORIZATION execution_service_role;
CREATE SCHEMA IF NOT EXISTS app        AUTHORIZATION app_service_role;
CREATE SCHEMA IF NOT EXISTS logging    AUTHORIZATION logging_service_role;
CREATE SCHEMA IF NOT EXISTS plugin     AUTHORIZATION plugin_service_role;
CREATE SCHEMA IF NOT EXISTS gateway    AUTHORIZATION gateway_service_role;

-- ─── Schema Usage Grants ──────────────────────────────────────────────────────
-- Each role can USAGE + CREATE on its own schema.
-- No role can access other schemas by default.

GRANT USAGE, CREATE ON SCHEMA auth       TO auth_service_role;
GRANT USAGE, CREATE ON SCHEMA ingestion  TO ingestion_service_role;
GRANT USAGE, CREATE ON SCHEMA ontology   TO ontology_service_role;
GRANT USAGE, CREATE ON SCHEMA pipeline   TO pipeline_service_role;
GRANT USAGE, CREATE ON SCHEMA execution  TO execution_service_role;
GRANT USAGE, CREATE ON SCHEMA app        TO app_service_role;
GRANT USAGE, CREATE ON SCHEMA logging    TO logging_service_role;
GRANT USAGE, CREATE ON SCHEMA plugin     TO plugin_service_role;
GRANT USAGE, CREATE ON SCHEMA gateway    TO gateway_service_role;

-- Default privileges: tables created in each schema are automatically
-- granted to the owning role. Prevents accidental lockout after migrations.

ALTER DEFAULT PRIVILEGES FOR ROLE auth_service_role      IN SCHEMA auth
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO auth_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE ingestion_service_role IN SCHEMA ingestion
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ingestion_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE ontology_service_role  IN SCHEMA ontology
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ontology_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE pipeline_service_role  IN SCHEMA pipeline
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO pipeline_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE execution_service_role IN SCHEMA execution
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO execution_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE app_service_role       IN SCHEMA app
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE logging_service_role   IN SCHEMA logging
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO logging_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE plugin_service_role    IN SCHEMA plugin
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO plugin_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE gateway_service_role   IN SCHEMA gateway
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gateway_service_role;

-- Sequences: services need USAGE on sequences for INSERT with serial/identity columns.
ALTER DEFAULT PRIVILEGES FOR ROLE auth_service_role      IN SCHEMA auth
  GRANT USAGE, SELECT ON SEQUENCES TO auth_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE ingestion_service_role IN SCHEMA ingestion
  GRANT USAGE, SELECT ON SEQUENCES TO ingestion_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE ontology_service_role  IN SCHEMA ontology
  GRANT USAGE, SELECT ON SEQUENCES TO ontology_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE pipeline_service_role  IN SCHEMA pipeline
  GRANT USAGE, SELECT ON SEQUENCES TO pipeline_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE execution_service_role IN SCHEMA execution
  GRANT USAGE, SELECT ON SEQUENCES TO execution_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE app_service_role       IN SCHEMA app
  GRANT USAGE, SELECT ON SEQUENCES TO app_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE logging_service_role   IN SCHEMA logging
  GRANT USAGE, SELECT ON SEQUENCES TO logging_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE plugin_service_role    IN SCHEMA plugin
  GRANT USAGE, SELECT ON SEQUENCES TO plugin_service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE gateway_service_role   IN SCHEMA gateway
  GRANT USAGE, SELECT ON SEQUENCES TO gateway_service_role;

-- ─── Cross-Schema Exception ───────────────────────────────────────────────────
-- THE ONLY cross-schema access allowed in the system.
-- Ontology Service needs SELECT on ingestion schema tables for mapping jobs.
-- Ref spec §3: "GRANT SELECT ON ALL TABLES IN SCHEMA ingestion TO ontology_service_role"
-- Also grants USAGE on schema so the role can resolve table names.

GRANT USAGE ON SCHEMA ingestion TO ontology_service_role;
GRANT SELECT ON ALL TABLES IN SCHEMA ingestion TO ontology_service_role;

-- Ensure future ingestion tables are also readable by ontology (for dynamic raw_ tables).
ALTER DEFAULT PRIVILEGES FOR ROLE ingestion_service_role IN SCHEMA ingestion
  GRANT SELECT ON TABLES TO ontology_service_role;

-- ─── Search Path Defaults ────────────────────────────────────────────────────
-- Set each role's default search_path so queries don't need schema prefixes.
-- Services should still qualify table names explicitly in queries for clarity.

ALTER ROLE auth_service_role      SET search_path TO auth, public;
ALTER ROLE ingestion_service_role SET search_path TO ingestion, public;
ALTER ROLE ontology_service_role  SET search_path TO ontology, ingestion, public;
ALTER ROLE pipeline_service_role  SET search_path TO pipeline, public;
ALTER ROLE execution_service_role SET search_path TO execution, public;
ALTER ROLE app_service_role       SET search_path TO app, public;
ALTER ROLE logging_service_role   SET search_path TO logging, public;
ALTER ROLE plugin_service_role    SET search_path TO plugin, public;
ALTER ROLE gateway_service_role   SET search_path TO gateway, public;
