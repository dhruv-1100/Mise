import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { auth, isAuthConfigured } from "@/auth";
import { NoRecipe } from "@/components/NoRecipe";
import { NoteEditor } from "@/components/NoteEditor";
import { SaveButton } from "@/components/SaveButton";
import { ServingStepper } from "@/components/ServingStepper";
import { TrackRecipeView } from "@/components/TrackRecipeView";
import { canEditChannel, cookHistory, getNote, isSaved } from "@/lib/accounts";
import { relativeTime } from "@/lib/relative-time";
import { loadExtraction, toJsonLd } from "@/lib/recipe";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://mise.example";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ videoId: string }>;
}): Promise<Metadata> {
  const { videoId } = await params;
  const extraction = await loadExtraction(videoId);

  // noindex on a page with no recipe. It is a real page with a real
  // explanation, but §6.1 makes recipe rich results the acquisition channel,
  // and letting Google index pages that say "there is no recipe here" trains it
  // that this site's /r/ URLs are thin. Indexed emptiness costs more than the
  // traffic it brings.
  if (extraction.status === "insufficient") {
    return { title: "No recipe in this video", robots: { index: false, follow: true } };
  }
  if (extraction.status === "missing") return { title: "Recipe not found" };

  const recipe = extraction.recipe;

  return {
    title: recipe.title,
    description: `${recipe.ingredients.length} ingredients · ${recipe.steps.length} steps · from ${recipe.creator.name}`,
    openGraph: {
      title: recipe.title,
      description: `A scalable recipe from ${recipe.creator.name}.`,
      url: `${SITE}/r/${videoId}`,
      type: "article",
    },
    alternates: { canonical: `${SITE}/r/${videoId}` },
  };
}

/**
 * Everything on this page that depends on who is looking.
 *
 * NOT wrapped in <Suspense>, and that is deliberate. It was, for the obvious
 * reason: let the recipe paint without waiting on a session lookup and four
 * queries. But a client component inside that boundary never hydrated — the
 * Save button and the notes field rendered correctly, looked right, and did
 * nothing at all, because React attached no handlers to them.
 *
 * Reproduced in both `next dev` and a production build on Next 15.5.23 /
 * React 19, and it is not the sibling JSON-LD <script>, which was the first
 * suspect and was ruled out by removing it. The trigger is the boundary itself
 * wrapping an async server component on this version.
 *
 * The cost of dropping it is small: this page already awaits loadRecipe() over
 * gRPC before rendering anything, so the shell was never streaming early, and
 * the four queries below run in parallel on one connection. Worth revisiting
 * with partial prerendering, which is the arrangement that actually wants a
 * boundary here — but not before checking, in a real browser, that what is
 * inside it responds to a click.
 */
async function PersonalActions({ videoId, channelId }: { videoId: string; channelId: string }) {
  const user = isAuthConfigured ? (await auth())?.user : undefined;

  if (user === undefined) {
    return (
      <div className="mt-6">
        <SaveButton videoId={videoId} initialSaved={false} signedIn={false} />
      </div>
    );
  }

  const [saved, note, cooks, canEdit] = await Promise.all([
    isSaved(user.id, videoId),
    getNote(user.id, videoId),
    cookHistory(user.id, videoId),
    canEditChannel(user.id, channelId),
  ]);

  return (
    <>
      <div className="mt-6 flex items-center gap-3">
        <SaveButton videoId={videoId} initialSaved={saved} signedIn />
        {cooks.count > 0 && (
          /* `cook_logs` is append-only so this question can be asked at all; a
             counter column would give the number and lose the date. "Cooked
             twice, last 3 weeks ago" is the line that makes a saved recipe feel
             like yours rather than a bookmark. */
          <span className="text-[13px] text-ink-faint">
            cooked {cooks.count} {cooks.count === 1 ? "time" : "times"}
            {cooks.lastCookedAt !== null && ` · last ${relativeTime(cooks.lastCookedAt)}`}
          </span>
        )}
        {canEdit && (
          <Link
            href={`/r/${videoId}/edit`}
            className="ml-auto flex h-11 items-center text-[15px] font-semibold text-accent-deep"
          >
            Edit extraction
          </Link>
        )}
      </div>
      <NoteEditor videoId={videoId} initialNote={note} />
    </>
  );
}

export default async function RecipePage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}) {
  const { videoId } = await params;
  const extraction = await loadExtraction(videoId);

  // Three outcomes, not two. A video whose description carries no recipe is a
  // normal result that the extractor explains, and turning that explanation
  // into the same 404 as a video nobody has ever submitted is what made a
  // successful-looking extraction end in a blank error page.
  if (extraction.status === "insufficient") {
    return <NoRecipe videoId={extraction.videoId} reason={extraction.reason} />;
  }
  if (extraction.status === "missing") notFound();

  const recipe = extraction.recipe;

  const jsonLd = toJsonLd(recipe, `${SITE}/r/${videoId}`);

  return (
    <main className="mx-auto w-full max-w-[560px] flex-1 pb-16">
      {/* Emitted from the same object the page renders, so the two cannot
          disagree. Structured data that contradicts the page is worse than
          none — it is what gets penalised. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      {/* Attribution is non-negotiable: creator name, channel link, and an
          embedded player on every recipe page (CLAUDE.md). */}
      <div className="aspect-video w-full bg-sunk">
        <iframe
          className="size-full"
          src={`https://www.youtube-nocookie.com/embed/${recipe.videoId}`}
          title={`${recipe.title} — ${recipe.creator.name}`}
          allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      </div>

      <TrackRecipeView
        videoId={recipe.videoId}
        ingredientCount={recipe.ingredients.length}
        stepCount={recipe.steps.length}
      />

      <div className="px-5">
        <h1 className="mb-2.5 mt-5 font-display text-[34px] leading-[1.08] tracking-[-0.02em]">
          {recipe.title}
        </h1>
        <p className="mb-5 text-sm">
          <a
            href={recipe.creator.channelUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-semibold text-accent-deep underline-offset-2 hover:underline"
          >
            {recipe.creator.name}
          </a>
          <span className="text-ink-faint"> · on YouTube</span>
        </p>

        <PersonalActions videoId={videoId} channelId={recipe.creator.channelId} />

        <ServingStepper recipe={recipe} />

        {recipe.steps.length > 0 ? (
          <>
            <h2 className="mb-1 mt-8 text-xs font-semibold uppercase tracking-[0.09em] text-ink-faint">
              Method
            </h2>
            <ol className="mt-2">
              {recipe.steps.map((step) => (
                <li key={step.index} className="flex gap-4 border-b border-line py-3.5">
                  <span className="flex size-8 flex-none items-center justify-center rounded-full bg-accent-wash text-sm font-bold tabular-nums text-accent-deep">
                    {step.index}
                  </span>
                  <span className="pt-1 text-base leading-relaxed">{step.text}</span>
                </li>
              ))}
            </ol>
          </>
        ) : (
          /* The CookingShooking shape: ingredients in the description, method
             only in the video. Saying so beats an empty heading. */
          <p className="mt-8 rounded-lg bg-surface p-4 text-sm leading-relaxed text-ink-soft">
            This creator lists ingredients but not steps. Watch the video above for the method.
          </p>
        )}

        {recipe.steps.length > 0 && (
          <Link
            href={`/r/${videoId}/cook`}
            className="mt-7 flex min-h-11 items-center justify-center gap-2.5 rounded-md bg-accent px-4 py-3.5 text-base font-semibold text-ground"
          >
            Start cooking
          </Link>
        )}
      </div>
    </main>
  );
}
