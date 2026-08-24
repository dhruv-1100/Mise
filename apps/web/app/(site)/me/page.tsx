import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { auth } from "@/auth";
import { listSaves } from "@/lib/accounts";
import { loadRecipe } from "@/lib/recipe";

export const metadata: Metadata = { title: "Saved" };

/** Saves and notes are per-person; nothing here may ever be cached publicly. */
export const dynamic = "force-dynamic";

export default async function SavedPage() {
  const user = (await auth())?.user;
  if (user === undefined) redirect("/signin?next=/me");

  const saves = await listSaves(user.id);

  // One lookup per saved recipe, in parallel. These are cache reads in the
  // extractor rather than extractions, and a save whose recipe has since gone
  // resolves to null and is rendered as a dead entry rather than dropped — a
  // save silently disappearing is worse than one that says it is unavailable.
  const recipes = await Promise.all(saves.map((s) => loadRecipe(s.videoId).catch(() => null)));

  return (
    <main className="mx-auto w-full max-w-[560px] flex-1 px-5 py-10">
      <h1 className="font-display text-[32px] leading-tight tracking-[-0.02em]">Saved</h1>

      {saves.length === 0 ? (
        <p className="mt-4 text-base leading-relaxed text-ink-soft">
          Nothing saved yet. Paste a video on the{" "}
          <Link href="/" className="font-semibold text-accent-deep underline underline-offset-2">
            home page
          </Link>{" "}
          and hit save on the recipe.
        </p>
      ) : (
        <ul className="mt-6">
          {saves.map((save, i) => {
            const recipe = recipes[i] ?? null;
            return (
              <li key={save.videoId} className="border-b border-line py-3.5">
                <Link href={`/r/${save.videoId}`} className="block">
                  <span className="block text-base font-semibold leading-snug">
                    {recipe?.title ?? "Recipe unavailable"}
                  </span>
                  <span className="mt-0.5 block text-[13px] text-ink-faint">
                    {recipe?.creator.name ?? save.videoId}
                    {save.cookedCount > 0 &&
                      ` · cooked ${save.cookedCount} ${save.cookedCount === 1 ? "time" : "times"}`}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </main>
  );
}
