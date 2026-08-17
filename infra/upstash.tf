// Redis — extraction cache and job queue (BullMQ / Celery, Phase 4).
//
// A video extracted once is never extracted again, so this instance carries
// both the cache and the queue. Cache hit rate is a Phase 7 metric.

resource "upstash_redis_database" "main" {
  database_name = local.name
  region        = var.upstash_region

  // TLS on. The extractor and the BFF reach this over the public internet.
  tls = true

  // No autoscaling: this is the free tier and the point is a ~$0/month bill.
  // Revisit when the Phase 7 queue-depth gauge says to, not before.
  // (multizone is deliberately unset — the provider deprecated it, and it is
  // on by default for paid databases anyway.)
  auto_scale = false

  // Queue entries must never be evicted under memory pressure — a silently
  // dropped job is far worse than a rejected enqueue. Backpressure is handled
  // explicitly in Phase 4 by capping queue depth and returning 429.
  eviction = false
}
