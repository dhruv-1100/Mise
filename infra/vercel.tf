// Web app (Next.js BFF).

resource "vercel_project" "web" {
  name      = local.name
  framework = "nextjs"

  // The Next.js app is not at the repo root.
  root_directory = "apps/web"

  git_repository = {
    type = "github"
    repo = var.github_repo
  }

  // pnpm workspaces: install from the repo root so workspace packages resolve,
  // then let Vercel build only the web app.
  install_command = "pnpm install --frozen-lockfile"
}

// Runtime configuration for the deployed web app.
//
// Vercel builds on git push through the integration above, so nothing in CI
// deploys the frontend — but a build with no environment reaches production as
// a site where sign-in 500s and every recipe page reports the extractor down.
//
// Values Terraform already knows (the database, the extractor's address) are
// wired from the resources themselves rather than copied into tfvars, so they
// cannot go stale when an endpoint changes.
locals {
  web_env = {
    DATABASE_URL = format(
      "postgres://%s:%s@%s/%s?sslmode=require",
      neon_role.app.name,
      neon_role.app.password,
      neon_project.main.database_host_pooler,
      neon_database.app.name,
    )
    EXTRACTOR_GRPC_ADDRESS = "${replace(google_cloud_run_v2_service.extractor.uri, "https://", "")}:443"
    AUTH_TRUST_HOST        = "true"

    AUTH_SECRET             = var.auth_secret
    AUTH_GOOGLE_ID          = var.google_oauth_client_id
    AUTH_GOOGLE_SECRET      = var.google_oauth_client_secret
    NEXT_PUBLIC_SITE_URL    = var.site_url
    NEXT_PUBLIC_POSTHOG_KEY = var.posthog_key
  }

  // for_each keys may not derive from sensitive values — Terraform refuses,
  // because a resource instance key ends up in plan output and state paths.
  // So presence is computed per key and unmarked deliberately: WHETHER a
  // variable is set is not a secret, only its value is. The values themselves
  // stay marked and are read from web_env below.
  //
  // Empty is skipped rather than written blank. A blank AUTH_SECRET is worse
  // than an absent one: Auth.js would start and sign tokens with it, where
  // absent makes it refuse to start.
  web_env_keys = toset(compact([
    "DATABASE_URL",
    "EXTRACTOR_GRPC_ADDRESS",
    "AUTH_TRUST_HOST",
    nonsensitive(var.auth_secret != "") ? "AUTH_SECRET" : "",
    var.google_oauth_client_id != "" ? "AUTH_GOOGLE_ID" : "",
    nonsensitive(var.google_oauth_client_secret != "") ? "AUTH_GOOGLE_SECRET" : "",
    var.site_url != "" ? "NEXT_PUBLIC_SITE_URL" : "",
    var.posthog_key != "" ? "NEXT_PUBLIC_POSTHOG_KEY" : "",
  ]))
}

resource "vercel_project_environment_variable" "web" {
  for_each = local.web_env_keys

  project_id = vercel_project.web.id
  key        = each.key
  value      = local.web_env[each.key]
  target     = ["production", "preview", "development"]
  sensitive  = true
}
