// Python extraction service.
//
// The Railway provider is community-maintained and pre-1.0. Treat breaking
// changes between minor versions as likely, and pin tightly.

resource "railway_project" "main" {
  name        = local.name
  description = "Mise extraction service — owns all LLM calls and recipe parsing."
  private     = true

  // No preview deploys per PR: the extractor is the expensive service and a
  // deploy per PR burns free-tier hours for no benefit while it is pre-launch.
  has_pr_deploys = false
}

resource "railway_service" "extractor" {
  name       = "extractor"
  project_id = railway_project.main.id

  source_repo        = var.github_repo
  source_repo_branch = "main"
  root_directory     = "apps/extractor"
}
