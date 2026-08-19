-- 0001 — enable pgvector
--
-- This cannot be done by Terraform. The Neon provider exposes no extension
-- resource (no neon_extension, no extensions attribute on neon_project), and
-- there is no checkbox in the console either. BUILD_PLAN.md §1.1 asks for "a
-- Neon Postgres project with pgvector enabled"; only the first half is
-- Terraform's job. See docs/adr/0001-content-sourcing.md and infra/README.md.
--
-- Phase 10's recommender is the first thing that needs it. Run it now anyway,
-- so the extension is long in place before anything depends on it.
--
--   psql "$DATABASE_URL" -f apps/extractor/migrations/0001_enable_pgvector.sql

CREATE EXTENSION IF NOT EXISTS vector;
