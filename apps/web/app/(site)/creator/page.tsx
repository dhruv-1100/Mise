import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { signInToClaimChannel } from "@/app/actions/auth";
import { auth } from "@/auth";
import { listClaims } from "@/lib/accounts";

export const metadata: Metadata = { title: "For creators" };
export const dynamic = "force-dynamic";

/**
 * Outcomes of a claim attempt, arriving as ?claim= from the OAuth callback.
 *
 * The claim is decided inside the `signIn` callback in auth.ts, which has no
 * way to render — it redirects here with the result instead. Every branch it
 * can produce is named here; an unrecognised value falls through to null rather
 * than rendering "undefined".
 */
const CLAIM_MESSAGES: Record<string, { tone: "good" | "bad"; text: string }> = {
  claimed: {
    tone: "good",
    text: "Channel verified. You can now correct extractions of your own videos.",
  },
  already_yours: { tone: "good", text: "You had already claimed that channel." },
  taken_by_another: {
    tone: "bad",
    text: "That channel is already claimed by another account. If that is wrong, get in touch.",
  },
  no_channel: {
    tone: "bad",
    text: "That Google account has no YouTube channel attached to it.",
  },
  forbidden: {
    tone: "bad",
    text: "We did not get permission to read your channel. The consent screen has a tickbox for it — it has to stay ticked.",
  },
  unavailable: {
    tone: "bad",
    text: "YouTube did not answer. Nothing was changed; try again in a moment.",
  },
};

export default async function CreatorPage({
  searchParams,
}: {
  searchParams: Promise<{ claim?: string }>;
}) {
  const user = (await auth())?.user;
  if (user === undefined) redirect("/signin?next=/creator");

  const claims = await listClaims(user.id);
  const outcome = CLAIM_MESSAGES[(await searchParams).claim ?? ""] ?? null;

  return (
    <main className="mx-auto w-full max-w-[560px] flex-1 px-5 py-10">
      <h1 className="font-display text-[32px] leading-tight tracking-[-0.02em]">
        For creators
      </h1>
      <p className="mt-3 text-base leading-relaxed text-ink-soft">
        Mise reads what you already wrote in your video description. If it got something
        wrong, you are the right person to fix it — and only you should be able to.
      </p>

      {outcome !== null && (
        <p
          role="status"
          className={`mt-6 rounded-md px-3.5 py-2.5 text-[13px] leading-relaxed ${
            outcome.tone === "good" ? "bg-herb-wash text-ink" : "bg-warn-wash text-ink"
          }`}
        >
          {outcome.text}
        </p>
      )}

      {claims.length > 0 && (
        <section className="mt-8">
          <h2 className="text-xs font-semibold uppercase tracking-[0.09em] text-ink-faint">
            Verified channels
          </h2>
          <ul className="mt-2">
            {claims.map((claim) => (
              <li key={claim.channelId} className="border-b border-line py-3">
                <span className="block text-base font-semibold">{claim.channelTitle}</span>
                <span className="mt-0.5 block text-[13px] text-ink-faint">
                  verified {new Date(claim.verifiedAt).toLocaleDateString()}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-4 text-[13px] leading-relaxed text-ink-soft">
            Open any recipe from a verified channel and you will find an edit link on it.
          </p>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-xs font-semibold uppercase tracking-[0.09em] text-ink-faint">
          {claims.length > 0 ? "Claim another channel" : "Claim your channel"}
        </h2>
        <p className="mt-2 text-[15px] leading-relaxed text-ink-soft">
          Signing in with the Google account that owns the channel is the proof. We ask
          YouTube which channel that account owns, record the answer, and discard the
          access token — we never store it and never post anything.
        </p>
        <form action={signInToClaimChannel} className="mt-4">
          <button
            type="submit"
            className="flex h-11 items-center justify-center rounded-md bg-accent px-[18px] text-[15px] font-semibold text-ground"
          >
            Verify with YouTube
          </button>
        </form>
      </section>
    </main>
  );
}
