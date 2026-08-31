import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { auth, isAuthConfigured } from "@/auth";
import { RecipeEditor } from "@/components/RecipeEditor";
import { loadExtraction } from "@/lib/recipe";

export const metadata: Metadata = { title: "Your version" };
export const dynamic = "force-dynamic";

/**
 * Edit a recipe for yourself.
 *
 * No claim, no role, no ownership check — anyone signed in may keep their own
 * version of any recipe. That is the whole difference from ../edit, which is
 * the creator's correction and is authoritative for every reader.
 *
 * The recipe loaded here is the reader's own version if they already have one,
 * so editing twice edits your edit rather than starting again from the
 * extraction.
 */
export default async function EditMinePage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}) {
  const { videoId } = await params;
  if (!isAuthConfigured) notFound();

  const user = (await auth())?.user;
  if (user === undefined) redirect(`/signin?next=/r/${videoId}/mine`);

  const extraction = await loadExtraction(videoId, user.id);
  if (extraction.status !== "ok") notFound();

  return (
    <main className="mx-auto w-full max-w-[720px] flex-1 px-5 py-10">
      <h1 className="font-display text-[32px] leading-tight tracking-[-0.02em]">Your version</h1>
      <p className="mt-3 text-base leading-relaxed text-ink-soft">
        Change anything you like — quantities, steps, how many it serves. Only you see this
        version, and it is what you get every time you open this recipe from now on.
      </p>
      <p className="mt-3 rounded-md bg-surface p-3.5 text-[13px] leading-relaxed text-ink-soft">
        {/* The one thing that would otherwise be surprising. The stepper scales
            from the yield, so an edit made "at 8 servings" would be doubled
            again the next time somebody scaled it. */}
        Quantities here are for <strong>{extraction.recipe.yield?.qty ?? "the stated"} servings</strong>
        , the amount this recipe is written for. Scaling still works on top of your changes.
      </p>

      <RecipeEditor
        recipe={extraction.recipe}
        endpoint={`/api/recipes/${videoId}/mine`}
        saveLabel="Save my version"
        revertLabel="Discard my changes"
      />
    </main>
  );
}
