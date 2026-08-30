import Link from "next/link";

import type { InsufficientReason } from "@mise/schema";

/**
 * What a recipe page shows when the extraction found no recipe.
 *
 * ADR 0001 measured roughly one description in five carrying nothing usable —
 * creators who deliberately withhold the recipe to drive traffic to their own
 * site. That is a normal outcome, not an error, and the extractor already
 * records *which* kind it was. Until this component existed the page threw that
 * away and rendered a bare 404, immediately after the progress screen had told
 * the person their extraction succeeded.
 *
 * The video is still embedded. Attribution is non-negotiable (CLAUDE.md), and
 * it is the honest answer here anyway: the recipe exists, it is just in the
 * video rather than in anything we are allowed to read.
 */

const EXPLANATIONS: Record<InsufficientReason, { headline: string; detail: string }> = {
  description_is_link_only: {
    headline: "This creator keeps the recipe on their own site",
    detail:
      "The video's description is links rather than an ingredient list, so there was nothing to extract. Watch it above, or follow the creator's own link for the full write-up.",
  },
  no_ingredients_found: {
    headline: "No ingredient list in this video's description",
    detail:
      "The description does not list quantities, and inventing them would be worse than saying so. The method is in the video itself.",
  },
  captions_unavailable: {
    headline: "The recipe is only spoken, not written",
    detail:
      "Nothing usable in the description, and YouTube does not let us read this video's captions without the creator's permission. If it is your video, you can claim your channel and add the recipe yourself.",
  },
  not_a_recipe_video: {
    headline: "This does not look like a recipe video",
    detail:
      "We could not find ingredients or steps in it. If that is wrong, it is worth telling us — it usually means the description is formatted in a way we have not seen.",
  },
};

export function NoRecipe({ videoId, reason }: { videoId: string; reason: InsufficientReason }) {
  const { headline, detail } = EXPLANATIONS[reason];

  return (
    <main className="mx-auto w-full max-w-[560px] flex-1 pb-16">
      <div className="aspect-video w-full bg-sunk">
        <iframe
          className="size-full"
          src={`https://www.youtube-nocookie.com/embed/${videoId}`}
          title="The original video"
          allow="accelerometer; clipboard-write; encrypted-media; picture-in-picture"
          allowFullScreen
        />
      </div>

      <div className="px-5">
        <h1 className="mb-3 mt-6 font-display text-[28px] leading-[1.12] tracking-[-0.02em]">
          {headline}
        </h1>
        <p className="text-base leading-relaxed text-ink-soft">{detail}</p>

        <a
          href={`https://www.youtube.com/watch?v=${videoId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-7 flex min-h-11 items-center justify-center rounded-md bg-accent px-4 py-3.5 text-base font-semibold text-ground"
        >
          Watch on YouTube
        </a>

        <Link
          href="/"
          className="mt-3 flex min-h-11 items-center justify-center rounded-md border border-line px-4 py-3.5 text-base font-semibold"
        >
          Try another video
        </Link>
      </div>
    </main>
  );
}
