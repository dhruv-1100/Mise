// Postgres.
//
// IMPORTANT — pgvector is NOT provisioned here, and cannot be. The Neon
// Terraform provider exposes no extension resource (verified against the
// v0.15.0 schema: no neon_extension, no extensions attribute on neon_project).
// pgvector is enabled with SQL:
//
//     CREATE EXTENSION IF NOT EXISTS vector;
//
// That belongs in the first database migration, not in Terraform. Phase 10's
// recommender is the first thing that needs it; Phase 6 should run it anyway so
// the extension exists long before anything depends on it.
//
// Note also that kislerdm/neon is community-maintained — Neon publishes no
// official provider. See infra/README.md.

resource "neon_project" "main" {
  name       = local.name
  org_id     = var.neon_org_id
  region_id  = var.neon_region
  pg_version = var.neon_pg_version

  // Neon's free tier keeps history for 24h. Longer retention costs storage and
  // buys point-in-time recovery we do not need before there are real users.
  history_retention_seconds = 86400
}

resource "neon_database" "app" {
  project_id = neon_project.main.id
  branch_id  = neon_project.main.default_branch_id
  name       = replace(var.project_name, "-", "_")
  owner_name = neon_role.app.name
}

resource "neon_role" "app" {
  project_id = neon_project.main.id
  branch_id  = neon_project.main.default_branch_id
  name       = "${replace(var.project_name, "-", "_")}_app"
}
