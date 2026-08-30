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

      // h2c is what makes this a gRPC service.
      //
      // Cloud Run terminates TLS at its frontend and forwards to the container
      // over cleartext HTTP/2 when the port is named "h2c". Without this name
      // the frontend downgrades to HTTP/1.1, which cannot carry gRPC at all —
      // and the failure is a channel that connects and then fails every call,
      // not a startup error.
      ports {
        name           = "h2c"
        container_port = 8080
      }

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

      // The worker pool has no queue without this, and app/server.py refuses to
      // boot rather than coming up healthy and failing every extraction.
      env {
        name  = "REDIS_URL"
        value = "rediss://default:${upstash_redis_database.main.password}@${upstash_redis_database.main.endpoint}:${upstash_redis_database.main.port}"
      }

      // A TCP probe, not an HTTP one.
      //
      // The container now serves gRPC on this port, so GET /healthz would be
      // answered by a gRPC server as a protocol error and the revision would
      // never go healthy. Probing gRPC properly means the grpc.health.v1
      // service and the grpcio-health-checking dependency; a TCP connect proves
      // the same thing this needs — the process is up and bound — without it.
      startup_probe {
        tcp_socket {
          port = 8080
        }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 6
      }
    }

    // Long enough for the slowest path there is.
    //
    // The original 300s was written when extraction was "10-40 seconds against
    // the LLM". Measured in production since: a description-only extraction
    // runs 12-90s, and one that falls back to watching the video (ADR 0006)
    // adds the whole video call on top — a real job spent 149.8s on the
    // description alone before watching began, and the 300s cut the stream
    // while the worker was still going.
    //
    // This is the ceiling the gRPC stream timeout sits under; the two move
    // together. See STREAM_TIMEOUT_SECONDS in app/grpc_server.py.
    timeout = "900s"
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
