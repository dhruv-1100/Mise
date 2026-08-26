// Everything here that carries a credential is marked sensitive, so it stays
// out of CI logs. Read one with:
//
//   terraform output -raw database_url

// neon_project.connection_uri points at the project's DEFAULT database and
// owner role (neondb / neondb_owner), not the ones declared in neon.tf. Handing
// that to the app would mean connecting to the wrong database as a superuser-ish
// role, which defeats the point of creating a least-privilege app role at all.
// These build the real thing.

output "database_url" {
  description = "Postgres connection string for the app role and database. Set as DATABASE_URL."
  value = format(
    "postgres://%s:%s@%s/%s?sslmode=require",
    neon_role.app.name,
    neon_role.app.password,
    neon_project.main.database_host,
    neon_database.app.name,
  )
  sensitive = true
}

output "database_url_pooled" {
  description = "Pooled connection string for the app role. Use this from serverless functions, which open far more connections than a long-lived process."
  value = format(
    "postgres://%s:%s@%s/%s?sslmode=require",
    neon_role.app.name,
    neon_role.app.password,
    neon_project.main.database_host_pooler,
    neon_database.app.name,
  )
  sensitive = true
}

output "owner_database_url" {
  description = "Project owner connection string, for migrations and admin only. Never give this to the application."
  value       = neon_project.main.connection_uri
  sensitive   = true
}

output "neon_project_id" {
  description = "Neon project id."
  value       = neon_project.main.id
}

output "redis_url" {
  description = "Upstash Redis TLS endpoint. Set as REDIS_URL."
  value       = "rediss://default:${upstash_redis_database.main.password}@${upstash_redis_database.main.endpoint}:${upstash_redis_database.main.port}"
  sensitive   = true
}

output "redis_rest_url" {
  description = "Upstash REST endpoint, for edge runtimes that cannot open a TCP socket."
  value       = "https://${upstash_redis_database.main.endpoint}"
}

output "redis_rest_token" {
  description = "Upstash REST token."
  value       = upstash_redis_database.main.rest_token
  sensitive   = true
}

output "vercel_project_id" {
  description = "Vercel project id, for the deploy workflow."
  value       = vercel_project.web.id
}

output "extractor_url" {
  description = "Public URL of the Cloud Run extraction service."
  value       = google_cloud_run_v2_service.extractor.uri
}

output "extractor_image_repo" {
  description = "Artifact Registry path CI pushes the extractor image to."
  value = format(
    "%s-docker.pkg.dev/%s/%s",
    var.gcp_region,
    var.gcp_project_id,
    google_artifact_registry_repository.extractor.repository_id,
  )
}

output "grafana_stack_url" {
  description = "Grafana Cloud stack URL."
  value       = grafana_cloud_stack.main.url
}

output "grafana_prometheus_url" {
  description = "Prometheus remote-write endpoint for both services."
  value       = grafana_cloud_stack.main.prometheus_remote_write_endpoint
}

output "grafana_metrics_token" {
  description = "Write-only token for pushing metrics."
  value       = grafana_cloud_access_policy_token.metrics_write.token
  sensitive   = true
}

// ---------------------------------------------------------------------------
// CI deployment. These three are what .github/workflows/deploy.yml needs, and
// none of them is a secret — the whole point of Workload Identity Federation is
// that there is no credential to keep. Set them as repository variables (not
// secrets) with:
//
//   terraform -chdir=infra output -raw github_wif_provider
//   terraform -chdir=infra output -raw github_deployer_service_account
//   terraform -chdir=infra output -raw extractor_service_name
// ---------------------------------------------------------------------------

output "github_wif_provider" {
  description = "Workload Identity provider resource name, for google-github-actions/auth."
  value       = google_iam_workload_identity_pool_provider.github.name
}

output "github_deployer_service_account" {
  description = "Service account CI impersonates to build and deploy."
  value       = google_service_account.deployer.email
}

output "extractor_service_name" {
  description = "Cloud Run service name the deploy workflow updates."
  value       = google_cloud_run_v2_service.extractor.name
}

output "extractor_grpc_address" {
  description = "host:443 for the BFF's EXTRACTOR_GRPC_ADDRESS. Cloud Run terminates TLS, so this is not the :50051 of local dev."
  value       = "${replace(google_cloud_run_v2_service.extractor.uri, "https://", "")}:443"
}
