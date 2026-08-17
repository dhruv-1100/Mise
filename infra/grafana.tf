// Grafana Cloud — metrics, dashboards, alerts (Phase 7).
//
// Provisioned in Phase 1 rather than Phase 7 on purpose: the free tier costs
// nothing to hold, and having the stack already exist removes the excuse to
// skip observability when Phase 7 arrives.

resource "grafana_cloud_stack" "main" {
  name        = local.name
  slug        = replace(local.name, "-", "")
  region_slug = var.grafana_region
  description = "Mise — system health, extraction pipeline, and product metrics."
}

// Token the services use to push metrics. Scoped to writing metrics only, so
// leaking it cannot read dashboards or alter alert rules.
resource "grafana_cloud_access_policy" "metrics_write" {
  region       = var.grafana_region
  name         = "${local.name}-metrics-write"
  display_name = "Mise metrics write"

  scopes = ["metrics:write", "logs:write", "traces:write"]

  realm {
    type       = "stack"
    identifier = grafana_cloud_stack.main.id
  }
}

resource "grafana_cloud_access_policy_token" "metrics_write" {
  region           = var.grafana_region
  access_policy_id = grafana_cloud_access_policy.metrics_write.policy_id
  name             = "${local.name}-metrics-write"
  display_name     = "Mise metrics write"
}
