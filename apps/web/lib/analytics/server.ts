import "server-only";

import type { AnalyticsEvent } from "./events";

/**
 * The server-side sink.
 *
 * Exactly one event uses it: `signup`. Everything else people do happens in a
 * browser that already has a distinct id and a session, and firing it from
 * there keeps it attached to the right person for free.
 *
 * `signup` cannot work that way. The browser cannot tell a new account from a
 * returning sign-in — both look identical after the OAuth round trip — and
 * Auth.js can, because it knows whether it just inserted a row. So this fires
 * from `events.createUser`, once per person, ever.
 */

type PostHogClient = {
  capture(args: {
    distinctId: string;
    event: string;
    properties?: Record<string, unknown>;
  }): void;
  shutdown(): Promise<void>;
};

let client: PostHogClient | null = null;

async function getClient(): Promise<PostHogClient | null> {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (key === undefined || key.length === 0) return null;
  if (client !== null) return client;

  const { PostHog } = await import("posthog-node");
  client = new PostHog(key, {
    host: process.env.NEXT_PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
    // Serverless functions are frozen the moment the response is sent, so a
    // batching client that flushes "soon" never flushes at all. Send on every
    // call and await the shutdown below.
    flushAt: 1,
    flushInterval: 0,
  }) as unknown as PostHogClient;

  return client;
}

/**
 * Send one event as a known user, and wait for it to leave.
 *
 * Awaited rather than fire-and-forget: on Vercel the process stops executing as
 * soon as the handler returns, and an un-awaited capture is simply lost. Never
 * throws — a telemetry failure must not fail a sign-in.
 */
export async function captureServerSide(userId: string, event: AnalyticsEvent): Promise<void> {
  try {
    const posthog = await getClient();
    if (posthog === null) return;
    posthog.capture({ distinctId: userId, event: event.name, properties: event.properties });
    await posthog.shutdown();
    client = null;
  } catch {
    // Deliberately swallowed.
  }
}
