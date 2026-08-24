import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { auth, isAuthConfigured } from "@/auth";
import { RecipeEditor } from "@/components/RecipeEditor";
import { canEditChannel } from "@/lib/accounts";
import { loadRecipe } from "@/lib/recipe";

export const metadata: Metadata = { title: "Edit extraction" };
export const dynamic = "force-dynamic";

/**
 * The creator's correction surface.
 *
 * Authorisation happens twice on purpose. Here, so someone without a claim
 * never sees a form they cannot submit; and again in PUT /api/recipes/[videoId],
 * because a page that hides a button has not prevented anything. The route
 * handler is the one that actually enforces it.
 */
export default async function EditPage({
  params,
}: {
  params: Promise<{ videoId: string }>;
}) {
  const { videoId } = await params;
  if (!isAuthConfigured) notFound();

  const user = (await auth())?.user;
  if (user === undefined) redirect(`/signin?next=/r/${videoId}/edit`);

  const recipe = await loadRecipe(videoId);
  if (recipe === null) notFound();

  if (!(await canEditChannel(user.id, recipe.creator.channelId))) {
    // Not a 403 page: to someone who does not own this channel, the edit
    // surface simply does not exist.
    notFound();
  }

  return (
    <main className="mx-auto w-full max-w-[720px] flex-1 px-5 py-10">
      <h1 className="font-display text-[32px] leading-tight tracking-[-0.02em]">
        Edit extraction
      </h1>
      <p className="mt-3 text-base leading-relaxed text-ink-soft">
        Your version replaces what Mise read from the description, on the public recipe page
        and in its structured data. Attribution stays as it is — this is still your video.
      </p>
      <RecipeEditor recipe={recipe} />
    </main>
  );
}
