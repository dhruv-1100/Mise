// Keyless CI authentication: GitHub Actions -> Google Cloud.
//
// The alternative is a service account JSON key in a GitHub secret. That key is
// a long-lived credential with no expiry, it is copied wherever the secret is
// read, and rotating it is a manual job nobody remembers to do. Workload
// Identity Federation replaces it with GitHub's own OIDC token, exchanged for a
// short-lived access token at the start of each run. Nothing durable is stored
// on either side.
//
// See docs/adr/0005-cloud-run-topology.md.

resource "google_project_service" "iamcredentials" {
  project            = var.gcp_project_id
  service            = "iamcredentials.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "sts" {
  project            = var.gcp_project_id
  service            = "sts.googleapis.com"
  disable_on_destroy = false
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.gcp_project_id
  workload_identity_pool_id = "${local.name}-github"
  display_name              = "GitHub Actions"
  description               = "Federated identity for CI in ${var.github_repo}."

  depends_on = [google_project_service.sts]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.gcp_project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github-oidc"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  // THIS LINE IS THE SECURITY BOUNDARY. Without an attribute_condition, the
  // provider trusts every token GitHub issues — meaning any workflow in any
  // public repository on GitHub can exchange one for credentials to this
  // project. Google now refuses to create a GitHub provider without a condition
  // for exactly this reason. Pin it to the one repository.
  attribute_condition = "assertion.repository == '${var.github_repo}'"

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

// The identity CI acts as. Deliberately separate from the runtime service
// account in cloudrun.tf: one deploys, the other runs, and neither needs the
// other's permissions.
resource "google_service_account" "deployer" {
  project      = var.gcp_project_id
  account_id   = "${local.name}-deployer"
  display_name = "Mise CI deployer"
}

// Only this repository's workflows may impersonate the deployer. The
// attribute.repository value comes from the mapping above, which comes from
// GitHub's signed token — it is not something a workflow can set.
resource "google_service_account_iam_member" "github_impersonates_deployer" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

// Push images. `writer` and not `admin`: CI never needs to delete a repository.
resource "google_artifact_registry_repository_iam_member" "deployer_writer" {
  project    = var.gcp_project_id
  location   = google_artifact_registry_repository.extractor.location
  repository = google_artifact_registry_repository.extractor.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.deployer.email}"
}

// Deploy revisions of this one service. Scoped to the service rather than
// granted project-wide, so a compromised CI run cannot create new services or
// touch anything else in the project.
resource "google_cloud_run_v2_service_iam_member" "deployer_developer" {
  project  = var.gcp_project_id
  location = google_cloud_run_v2_service.extractor.location
  name     = google_cloud_run_v2_service.extractor.name
  role     = "roles/run.developer"
  member   = "serviceAccount:${google_service_account.deployer.email}"
}

// Deploying a revision that runs AS the extractor service account requires
// permission to act as it. This is the binding whose absence produces the
// deploy error everyone hits once: "caller does not have permission to act as
// service account".
resource "google_service_account_iam_member" "deployer_acts_as_extractor" {
  service_account_id = google_service_account.extractor.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.deployer.email}"
}
