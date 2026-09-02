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
        {/* Any signed-in reader can keep their own version. Distinct from the
            creator link below, which corrects the recipe for everybody. */}
        <Link
          href={`/r/${videoId}/mine`}
          className="flex h-11 items-center text-[15px] font-semibold text-accent-deep"
        >
          Make it mine
        </Link>

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
  // Read the session here as well as in PersonalActions: the recipe itself now
  // depends on who is asking, because a reader's own edited version shadows the
  // extractor's. The page is already dynamic — SiteHeader reads cookies — so
  // this costs a session decode, not a render mode.
  const viewer = isAuthConfigured ? (await auth())?.user : undefined;
  const extraction = await loadExtraction(videoId, viewer?.id);

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
    <main className="mx-auto w-full max-w-[1080px] flex-1 pb-16 lg:px-6">
      {/* Emitted from the same object the page renders, so the two cannot
          disagree. Structured data that contradicts the page is worse than
          none — it is what gets penalised. */}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
      />

      <TrackRecipeView
        videoId={recipe.videoId}
        ingredientCount={recipe.ingredients.length}
        stepCount={recipe.steps.length}
      />

      {/*
        Three grid children, not two, and the order is doing real work.

        At >=1024px the columns are minmax(0,1fr) and 380px, so the children
        flow: header into column one, rail into column two, method back into
        column one on the next row. The rail therefore sits beside the header
        and the method runs underneath it — the 1b layout, with no `order`
        rules and no extra nesting.

        Below 1024 the grid is one column and the same three children stack as
        header, rail, method. That is exactly the mobile order the spec asks
        for: video, title, creator, stepper, advisories, ingredients, method.
      */}
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_380px] lg:gap-14 lg:pt-9">
        <div>
          {/* Attribution is non-negotiable: creator name, channel link, and an
              embedded player on every recipe page (CLAUDE.md). */}
          <div className="aspect-video w-full bg-sunk lg:overflow-hidden lg:rounded-lg">
            <iframe
              className="size-full"
              src={`https://www.youtube-nocookie.com/embed/${recipe.videoId}`}
              title={`${recipe.title} — ${recipe.creator.name}`}
              allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"
              allowFullScreen
            />
          </div>

          <div className="px-5 lg:px-0">
            <h1 className="mb-2.5 mt-5 font-display text-[34px] leading-[1.08] tracking-[-0.02em] lg:mt-6 lg:text-[46px] lg:leading-[1.05]">
              {recipe.title}
            </h1>
            <p className="mb-5 text-sm">
              <a
                href={recipe.creator.channelUrl}
                target="_blank"
                rel="noopener noreferrer"
                /* Italic display serif, the one place it is used. A creator's
                   name is a byline, not a label, and this is what distinguishes
                   it from every other piece of chrome on the page. */
                className="font-display text-[20px] italic leading-none text-accent-deep underline-offset-2 hover:underline"
              >
                {recipe.creator.name}
              </a>
              <span className="text-ink-faint"> · on YouTube</span>
            </p>

            <PersonalActions videoId={videoId} channelId={recipe.creator.channelId} />

            {extraction.personal === true && (
              /* Without this the page silently lies: it shows numbers the
                 creator never wrote, with their name at the top, and nothing
                 says why. */
              <p className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-accent-wash px-3.5 py-2.5 text-[13px] text-accent-deep">
                <span className="font-semibold">You have edited this recipe.</span>
                <Link
                  href={`/r/${videoId}/mine`}
                  className="font-semibold underline underline-offset-2"
                >
                  Edit again
                </Link>
              </p>
            )}
          </div>
        </div>

        <div className="px-5 lg:sticky lg:top-6 lg:rounded-lg lg:border lg:border-line lg:bg-surface lg:px-6 lg:py-5 lg:shadow-sm">
          <ServingStepper recipe={recipe} />
        </div>

        <div className="px-5 lg:px-0">
          {recipe.steps.length > 0 ? (
            <>
              <h2 className="mb-1 mt-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.09em] text-herb-text">
                {/* --herb becomes the section-heading colour in 2a, which is
                    why its lightness moved: 4.01:1 was a fill, 4.63:1 is a
                    heading. */}
                <span className="size-2 flex-none rounded-full bg-herb" aria-hidden="true" />
                Method
              </h2>
              <ol className="mt-2">
                {recipe.steps.map((step) => (
                  <li key={step.index} className="flex gap-4 border-b border-line py-3.5">
                    <span className="flex size-8 flex-none items-center justify-center rounded-full bg-accent-wash text-sm font-bold tabular-nums text-accent-deep">
                      {step.index}
                    </span>
                    <span className="pt-1 text-base leading-relaxed lg:text-[17px]">
                      {step.text}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            /* The CookingShooking shape: ingredients in the description, method
               only in the video. Saying so beats an empty heading. */
            <p className="mt-2 rounded-lg bg-surface p-4 text-sm leading-relaxed text-ink-soft">
              This creator lists ingredients but not steps. Watch the video above for the method.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
