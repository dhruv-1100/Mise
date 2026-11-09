"use client";

import Link from "next/link";

/**
 * What a page shows when something it depends on is down.
 *
 * At the root rather than in (site) so cook mode, which sits outside that group,
 * is covered too. Reloads rather than calling `reset()`: these failures come from
 * server components, and `reset()` only re-renders what the client already has.
 */
export default function ErrorPage() {
  return (
    <main className="mx-auto flex w-full max-w-[560px] flex-1 flex-col justify-center px-5 py-16">
      <h1 className="mb-3 font-display text-[28px] leading-[1.12] tracking-[-0.02em]">
        We could not load this page
      </h1>
      <p className="text-base leading-relaxed text-ink-soft">
        The problem is on our side, and nothing you saved has been lost. It is worth
        trying again in a minute.
      </p>

      <button
        type="button"
        onClick={() => window.location.reload()}
        className="mt-7 flex min-h-11 items-center justify-center rounded-md bg-accent px-4 py-3.5 text-base font-semibold text-ground"
      >
        Try again
      </button>

      <Link
        href="/"
        className="mt-3 flex min-h-11 items-center justify-center rounded-md border border-line px-4 py-3.5 text-base font-semibold"
      >
        Back to Mise
      </Link>
    </main>
  );
}
