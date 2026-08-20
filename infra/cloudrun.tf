// Python extraction service, on Cloud Run.
//
// Replaces Railway, which removed its free tier: the token was valid but
// projectCreate returned "Your trial has expired". BUILD_PLAN.md §1.1 named
// Fly.io as the alternative; Cloud Run was chosen instead because it scales to
// zero and has a genuinely free tier, and extraction is bursty rather than
// steady — an always-on machine would be paying to idle.

resource "google_project_service" "run" {
  project            = var.gcp_project_id
  service            = "run.googleapis.com"
  disable_on_destroy = false
}

resource "google_project_service" "artifactregistry" {
  project            = var.gcp_project_id
  service            = "artifactregistry.googleapis.com"
  disable_on_destroy = false
}

resource "google_artifact_registry_repository" "extractor" {
  project       = var.gcp_project_id
  location      = var.gcp_region
  repository_id = local.name
  format        = "DOCKER"
  description   = "Container images for the Mise extraction service."

  depends_on = [google_project_service.artifactregistry]
}

// The service account the container runs as. Distinct from the default compute
// account, which is over-privileged by default.
resource "google_service_account" "extractor" {
  project      = var.gcp_project_id
  account_id   = "${local.name}-extractor"
  display_name = "Mise extraction service"
}

resource "google_cloud_run_v2_service" "extractor" {
  project  = var.gcp_project_id
  name     = "${local.name}-extractor"
  location = var.gcp_region

  // Cloud Run only accepts traffic from the internet through its own frontend,
  // so this stays public until Phase 6 puts auth in front of it.
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.extractor.email

    scaling {
      // Scale to zero. Extraction is bursty and nothing should be paid for
      // while nobody is extracting.
      min_instance_count = 0
      max_instance_count = 4
    }

    containers {
      // Placeholder. The real image is built and pushed by CI, and the
      // lifecycle block below stops Terraform reverting it on the next apply —
      // without that, every terraform apply would roll production back to this
      // hello-world.
      image = "gcr.io/cloudrun/hello"

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      env {
        name  = "YOUTUBE_API_KEY"
        value = var.youtube_api_key
      }

      env {
        name  = "GEMINI_API_KEY"
        value = var.gemini_api_key
      }

      startup_probe {
        http_get {
          path = "/healthz"
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 6
      }
    }

    // Extraction takes 10-40 seconds against the LLM. The default 5 minutes is
    // enough, but say so explicitly rather than inheriting it.
    timeout = "300s"
  }

  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.run]
}

// Public invocation. The BFF calls this from Vercel, and locking it to a
// caller identity is a Phase 6 job alongside auth.
resource "google_cloud_run_v2_service_iam_member" "public" {
  project  = var.gcp_project_id
  location = google_cloud_run_v2_service.extractor.location
  name     = google_cloud_run_v2_service.extractor.name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
