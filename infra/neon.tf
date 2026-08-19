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

  // 6 hours, which is the free tier's hard maximum — the API rejects anything
  // above 21600 with a 400. It was set to 86400 here on the assumption that the
  // free tier allowed 24h; neither terraform validate nor plan catches that,
  // because it is a server-side quota rather than a schema constraint. Raise
  // this only alongside a paid plan, and only once point-in-time recovery is
  // worth paying storage for.
  history_retention_seconds = 21600
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
