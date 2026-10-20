// Provider configuration only. Resources live in one file per provider.

provider "neon" {
  api_key = var.neon_api_key
}

provider "upstash" {
  email   = var.upstash_email
  api_key = var.upstash_api_key
}

provider "vercel" {
  api_token = var.vercel_api_token
}

provider "google" {
  project = var.gcp_project_id
  region  = var.gcp_region
}

// Credentials come from the environment (AWS_PROFILE, AWS_ACCESS_KEY_ID, or an
// SSO session), never from this file. Nothing AWS-shaped is committed: the
// running service reaches AWS by federating its GCP identity, and the only
// place a human credential is used is `terraform apply`.
provider "aws" {
  region = var.aws_region
}

provider "grafana" {
  cloud_access_policy_token = var.grafana_cloud_access_policy_token
}

locals {
  // Every resource name derives from this, so a second environment is one
  // -var away rather than a find-and-replace.
  name = "${var.project_name}-${var.environment}"

  // Shared between the IAM trust policy that checks this audience and the
  // container that asks GCP to mint a token for it. One definition, because two
  // would silently stop matching and the failure is an opaque AccessDenied.
  aws_token_audience = "mise-extractor-aws"

  // Likewise: the IAM policy scopes PutMetricData to this namespace and the
  // publisher writes to it.
  cloudwatch_namespace = "Mise/Extractor"
}
