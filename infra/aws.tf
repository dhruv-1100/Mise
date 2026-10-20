// AWS: the durable tier under the Redis cache, and the dead-letter alarm.
//
// WHY THERE IS AWS HERE AT ALL. The Redis cache expires a recipe after seven
// days (CACHE_TTL_SECONDS in app/queue.py). On 2026-09-08 the live recipe page
// returned 404 twice because the entry had aged out, and each recovery cost a
// 90-295 second re-extraction and a Gemini call for a recipe that had already
// been extracted correctly. Redis is a cache and was never meant to be the only
// copy; S3 is the copy that does not expire.
//
// Nothing here stores a credential. The service reaches S3 by exchanging its
// own GCP identity token for AWS credentials — see the trust policy below.

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

resource "aws_s3_bucket" "recipes" {
  // Bucket names are globally unique across every AWS account, so the project
  // id is folded in. The GCP project id is already unique and already a
  // variable, which beats inventing a second random suffix to manage.
  bucket = "${local.name}-recipes-${var.gcp_project_id}"
}

// Recipes hold no secrets, but they are extracted content with an attribution
// obligation (CLAUDE.md), and a public bucket is how that stops being true.
resource "aws_s3_bucket_public_access_block" "recipes" {
  bucket                  = aws_s3_bucket.recipes.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "recipes" {
  bucket = aws_s3_bucket.recipes.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

// Versioning ON, deliberately. A creator correction or a reader's own edit
// overwrites the object, and the extractor can also re-extract the same video
// to a worse result when a model is having a bad day. Versions make that
// recoverable; the lifecycle rule below stops them accumulating forever.
resource "aws_s3_bucket_versioning" "recipes" {
  bucket = aws_s3_bucket.recipes.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "recipes" {
  bucket     = aws_s3_bucket.recipes.id
  depends_on = [aws_s3_bucket_versioning.recipes]

  rule {
    id     = "expire-old-versions"
    status = "Enabled"
    filter {}

    // Current versions are kept indefinitely — that is the entire point of the
    // bucket. Only superseded ones expire.
    noncurrent_version_expiration {
      noncurrent_days = 30
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

// ---------------------------------------------------------------------------
// Keyless access from Cloud Run
// ---------------------------------------------------------------------------

// No aws_iam_openid_connect_provider resource: accounts.google.com is one of
// the three identity providers AWS has built in for web identity federation,
// so registering it would fail as a duplicate. The condition keys below
// (accounts.google.com:oaud / :sub) are the ones AWS exposes for it — note
// `oaud` rather than the `aud` you would expect; see the comment on that
// condition, which cost an afternoon.
//
// `sub` is the Cloud Run service account's numeric unique id, not its email.
// Pinning the email instead would be a trust policy that silently widens if the
// account is ever recreated with the same name.
data "aws_iam_policy_document" "extractor_trust" {
  statement {
    effect  = "Allow"
    actions = ["sts:AssumeRoleWithWebIdentity"]

    principals {
      type        = "Federated"
      identifiers = ["accounts.google.com"]
    }

    condition {
      test     = "StringEquals"
      variable = "accounts.google.com:sub"
      values   = [google_service_account.extractor.unique_id]
    }

    // The audience the container asks the GCP metadata server to mint the token
    // for. A token minted for anything else will not satisfy this, which is
    // what stops a token issued for some other purpose being replayed here.
    //
    // `oaud`, NOT `aud`. This was `aud` until 2026-10-20 and every federation
    // attempt failed with a bare "Not authorized to perform
    // sts:AssumeRoleWithWebIdentity" — an error that names no claim and no
    // condition, so it reads like a missing permission rather than a mismatched
    // string. For the built-in accounts.google.com provider AWS maps:
    //
    //   accounts.google.com:oaud  -> the token's `aud`  claim, always
    //   accounts.google.com:aud   -> the token's `azp`  claim when present,
    //                                falling back to `aud`
    //
    // Google service account identity tokens do carry `azp`, set to the
    // account's unique id. So `:aud` here was being compared against
    // 116924920265042331650 rather than against the audience string, and could
    // never match. `:oaud` has no such fallback, so it is correct whether or
    // not `azp` is present.
    condition {
      test     = "StringEquals"
      variable = "accounts.google.com:oaud"
      values   = [local.aws_token_audience]
    }
  }
}

data "aws_iam_policy_document" "recipes_access" {
  // Read and write recipe objects, and nothing else. No ListBucket, no
  // DeleteObject: the service has no reason to enumerate the archive or remove
  // anything from it, and versioning already covers overwrite mistakes.
  statement {
    effect    = "Allow"
    actions   = ["s3:GetObject", "s3:PutObject"]
    resources = ["${aws_s3_bucket.recipes.arn}/recipes/*"]
  }

  // One metric, one namespace. PutMetricData cannot be scoped to a metric name,
  // so the namespace condition is the only narrowing AWS offers.
  statement {
    effect    = "Allow"
    actions   = ["cloudwatch:PutMetricData"]
    resources = ["*"]
    condition {
      test     = "StringEquals"
      variable = "cloudwatch:namespace"
      values   = [local.cloudwatch_namespace]
    }
  }
}

resource "aws_iam_role" "extractor" {
  name               = "${local.name}-extractor"
  description        = "Assumed by the Cloud Run extractor via its GCP identity token. No keys exist for this role."
  assume_role_policy = data.aws_iam_policy_document.extractor_trust.json

  // The default is one hour. The service assumes the role on demand and caches
  // the credentials until they near expiry, so a short lifetime costs nothing
  // and bounds the damage from a leaked token.
  max_session_duration = 3600
}

resource "aws_iam_role_policy" "extractor" {
  name   = "recipes-and-metrics"
  role   = aws_iam_role.extractor.id
  policy = data.aws_iam_policy_document.recipes_access.json
}

// ---------------------------------------------------------------------------
// The dead-letter alarm
// ---------------------------------------------------------------------------

// A non-empty DLQ means work was accepted and never done — the one queue state
// that is silent and wrong. queue.py has exposed dead_letter_depth() since
// Phase 4 and nothing has ever watched it.
resource "aws_sns_topic" "alerts" {
  name = "${local.name}-alerts"
}

resource "aws_sns_topic_subscription" "alerts_email" {
  count     = var.alert_email == "" ? 0 : 1
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "dead_letters" {
  alarm_name        = "${local.name}-dead-letter-queue-not-empty"
  alarm_description = "A job was accepted and never completed. See docs/INCIDENTS.md before clearing the queue — the DLQ is the only record of what failed."

  namespace           = local.cloudwatch_namespace
  metric_name         = "DeadLetterDepth"
  statistic           = "Maximum"
  period              = 300
  evaluation_periods  = 1
  threshold           = 0
  comparison_operator = "GreaterThanThreshold"

  // The extractor scales to zero (ADR 0005), so most periods have no datapoint
  // at all. Treating missing data as a breach would page on an idle service;
  // notBreaching is the only correct setting for a metric that legitimately
  // stops being reported.
  treat_missing_data = "notBreaching"

  alarm_actions = [aws_sns_topic.alerts.arn]
  ok_actions    = [aws_sns_topic.alerts.arn]
}
