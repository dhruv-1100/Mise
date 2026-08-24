import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { auth, isAuthConfigured } from "@/auth";
import { NoteEditor } from "@/components/NoteEditor";
import { SaveButton } from "@/components/SaveButton";
import { ServingStepper } from "@/components/ServingStepper";
import { canEditChannel, countCooks, getNote, isSaved } from "@/lib/accounts";
import { loadRecipe, toJsonLd } from "@/lib/recipe";

const SITE = process.env.NEXT_PUBLIC_SITE_URL ?? "https://mise.example";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ videoId: string }>;
}): Promise<Metadata> {
  const { videoId } = await params;
  const recipe = await loadRecipe(videoId);
  if (recipe === null) return { title: "Recipe not found" };

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
 * Split out and wrapped in Suspense so the recipe itself — the part that
 * matters for SEO and for someone who is not signed in — renders without
 * waiting on a session lookup and three queries. The fallback reserves the
 * height so the method section does not jump when this resolves.
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

  const [saved, note, cooked, canEdit] = await Promise.all([
    isSaved(user.id, videoId),
    getNote(user.id, videoId),
    countCooks(user.id, videoId),
    canEditChannel(user.id, channelId),
  ]);

  return (
    <>
      <div className="mt-6 flex items-center gap-3">
        <SaveButton videoId={videoId} initialSaved={saved} signedIn />
        {cooked > 0 && (
          <span className="text-[13px] text-ink-faint">
            cooked {cooked} {cooked === 1 ? "time" : "times"}
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
  const recipe = await loadRecipe(videoId);
  if (recipe === null) notFound();

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

        <Suspense fallback={<div className="mt-6 h-11" />}>
          <PersonalActions videoId={videoId} channelId={recipe.creator.channelId} />
        </Suspense>

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
