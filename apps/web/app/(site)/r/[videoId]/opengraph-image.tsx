import { ImageResponse } from "next/og";

import { loadExtraction } from "@/lib/recipe";

/**
 * The link preview for a recipe page.
 *
 * BUILD_PLAN §6.1 asks for Open Graph images per recipe. They matter more here
 * than for most products: the same section makes SEO and sharing the entire
 * acquisition strategy, and a recipe link pasted into a group chat with no card
 * is a link nobody clicks.
 *
 * Rendered from the recipe itself rather than a template with the title dropped
 * in, so the card carries the two things a person decides on — how many
 * ingredients and whose recipe it is.
 *
 * `next/og` ships with Next; no dependency is added. It is Satori underneath,
 * which supports a deliberate subset of CSS: flex only (no grid, no float), no
 * external stylesheets, and every colour written literally because the design
 * tokens in globals.css are not in scope here.
 */

export const alt = "A scalable recipe on Mise";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// Matched by hand from app/globals.css. Satori cannot see CSS custom
// properties, so these are the one place in the app where hardcoding a token
// value is correct rather than a violation — noted so it is not "fixed" later.
const GROUND = "#faf7f2";
const INK = "#1c1917";
const INK_SOFT = "#57534e";
const ACCENT = "#c2410c";

export default async function Image({ params }: { params: Promise<{ videoId: string }> }) {
  const { videoId } = await params;
  const extraction = await loadExtraction(videoId);

  // A card still has to render for a video with no recipe — those pages are
  // noindex but they are shareable, and a broken image is worse than a plain
  // one.
  const title =
    extraction.status === "ok" ? extraction.recipe.title : "No recipe in this video";
  const creator = extraction.status === "ok" ? extraction.recipe.creator.name : null;
  const counts =
    extraction.status === "ok"
      ? `${extraction.recipe.ingredients.length} ingredients · ${extraction.recipe.steps.length} steps`
      : null;

  return new ImageResponse(
    (
      <div
        style={{
          height: "100%",
          width: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: GROUND,
          padding: "72px 80px",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div
            style={{
              display: "flex",
              fontSize: 28,
              letterSpacing: "0.14em",
              textTransform: "uppercase",
              color: ACCENT,
              fontWeight: 700,
            }}
          >
            Mise
          </div>
          <div
            style={{
              display: "flex",
              marginTop: 34,
              fontSize: title.length > 70 ? 58 : 72,
              lineHeight: 1.1,
              color: INK,
              fontWeight: 700,
              // Satori has no line-clamp. A very long title is cut here rather
              // than allowed to overflow the card.
              maxHeight: 300,
              overflow: "hidden",
            }}
          >
            {title.length > 120 ? `${title.slice(0, 117)}…` : title}
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {counts !== null && (
            <div style={{ display: "flex", fontSize: 30, color: INK_SOFT }}>{counts}</div>
          )}
          {creator !== null && (
            /* Attribution is non-negotiable (CLAUDE.md), and a share card is
               exactly where it would be tempting to drop it for space. */
            <div style={{ display: "flex", fontSize: 34, color: INK, fontWeight: 600 }}>
              {creator}
            </div>
          )}
          <div style={{ display: "flex", fontSize: 26, color: INK_SOFT, marginTop: 6 }}>
            Scale it to any number of servings
          </div>
        </div>
      </div>
    ),
    size,
  );
}
