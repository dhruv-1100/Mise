// Everything here that carries a credential is marked sensitive, so it stays
// out of CI logs. Read one with:
//
//   terraform output -raw database_url

output "database_url" {
  description = "Postgres connection string. Set as DATABASE_URL."
  value       = neon_project.main.connection_uri
  sensitive   = true
}

output "database_url_pooled" {
  description = "Pooled connection string. Use this from serverless functions, which open far more connections than a long-lived process."
  value       = neon_project.main.connection_uri_pooler
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

output "railway_project_id" {
  description = "Railway project id, for the deploy workflow."
  value       = railway_project.main.id
}

output "railway_service_id" {
  description = "Railway extractor service id."
  value       = railway_service.extractor.id
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
