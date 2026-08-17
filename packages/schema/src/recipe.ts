/**
 * The recipe contract.
 *
 * This is the single shape that crosses every boundary in the system: the
 * extractor produces it, the BFF serves it, the scaling engine transforms it,
 * and the Phase 2.2 eval set is hand-labelled against it. Changing it is
 * expensive, so the invariants are enforced here rather than assumed.
 *
 * Mirrored in `apps/extractor/app/schema.py`. The two definitions are checked
 * against the same JSON fixtures in `packages/schema/fixtures/` so they cannot
 * drift silently. Phase 4 replaces this arrangement with generated protobuf
 * stubs, at which point the mirror goes away.
 */

import { z } from "zod";

/** YouTube video IDs are exactly 11 characters of URL-safe base64. */
export const VideoId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{11}$/, "must be an 11-character YouTube video ID");

/**
 * Where a piece of extracted data came from.
 *
 * ADR 0001 made this load-bearing rather than decorative. Descriptions are the
 * primary source; captions are reachable only with creator OAuth and arrive
 * later, for a minority of videos. When both exist they will disagree, and the
 * resolution rule (description wins for quantities, caption wins for technique)
 * is impossible to apply without knowing which is which.
 */
export const SourceKind = z.enum(["description", "caption", "title", "manual"]);
export type SourceKind = z.infer<typeof SourceKind>;

/** 0 = pure guess, 1 = stated unambiguously in the source. */
export const Confidence = z.number().min(0).max(1);

export const Ingredient = z
  .object({
    name: z.string().trim().min(1),

    /**
     * The numeric quantity, or null when the source did not give one.
     *
     * Non-negotiable: never invent precision that was not in the source. "a
     * glug", "a good handful", "season to taste" produce `qty: null` with the
     * original wording preserved in `qtyText`. A plausible-looking number here
     * that nobody wrote down is the single worst failure this schema can
     * permit, because it is indistinguishable downstream from a real one.
     */
    qty: z.number().positive().nullable(),

    /** The source's own words when the quantity was vague. */
    qtyText: z.string().trim().min(1).nullable(),

    /** Raw unit as written. Canonicalisation happens in the pipeline. */
    unit: z.string().trim().min(1).nullable(),

    /** "minced", "boiled and grated", "at room temperature". */
    prep: z.string().trim().min(1).nullable(),

    optional: z.boolean(),
    source: SourceKind,
    confidence: Confidence,
  })
  .strict()
  .refine((i) => !(i.qty === null && i.unit !== null), {
    message: "unit without a quantity is meaningless — set qty or clear unit",
    path: ["unit"],
  });
export type Ingredient = z.infer<typeof Ingredient>;

export const Step = z
  .object({
    /** 1-based. Contiguity across the list is enforced on Recipe. */
    index: z.number().int().positive(),
    text: z.string().trim().min(1),
    /** Seconds. Null when the source gave no timing. */
    durationS: z.number().int().positive().nullable(),
    /** Celsius. Fahrenheit is converted at extraction, never stored. */
    tempC: z.number().nullable(),
    source: SourceKind,
  })
  .strict();
export type Step = z.infer<typeof Step>;

export const Yield = z
  .object({
    qty: z.number().positive().nullable(),
    qtyText: z.string().trim().min(1).nullable(),
    /** "serving", "loaf", "cookie". */
    unit: z.string().trim().min(1),
  })
  .strict();
export type Yield = z.infer<typeof Yield>;

/**
 * Attribution is not optional (CLAUDE.md). Encoding it as required fields
 * rather than a convention means a recipe that cannot be attributed cannot be
 * represented at all, which is the correct outcome.
 */
export const Creator = z
  .object({
    name: z.string().trim().min(1),
    channelId: z.string().trim().min(1),
    channelUrl: z.url(),
  })
  .strict();
export type Creator = z.infer<typeof Creator>;

/**
 * A disagreement between two sources about the same field.
 *
 * Recorded rather than silently resolved. The plan's rule is to prefer the
 * description for quantities and the transcript for technique, but a rule
 * applied invisibly is a rule you cannot evaluate — these surface in the UI as
 * a flag and in the eval set as a measurable category.
 */
export const Conflict = z
  .object({
    /** Dotted path into the recipe, e.g. "ingredients.3.qty". */
    field: z.string().trim().min(1),
    description: z.string().nullable(),
    caption: z.string().nullable(),
    chosen: SourceKind,
    reason: z.string().trim().min(1),
  })
  .strict();
export type Conflict = z.infer<typeof Conflict>;

export const Recipe = z
  .object({
    videoId: VideoId,
    title: z.string().trim().min(1),
    creator: Creator,

    ingredients: z.array(Ingredient).min(1),
    steps: z.array(Step),
    yield: Yield.nullable(),
    equipment: z.array(z.string().trim().min(1)),

    /** Which sources actually contributed. Never empty. */
    sources: z.array(SourceKind).min(1),
    conflicts: z.array(Conflict),

    extractedAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((recipe, ctx) => {
    // Step indices must be exactly 1..n. Gaps or duplicates mean the extractor
    // dropped or doubled a step, and downstream code that renders "step 3 of 7"
    // would quietly lie about it.
    const indices = recipe.steps.map((s) => s.index);
    const expected = recipe.steps.map((_, i) => i + 1);
    if (indices.join(",") !== expected.join(",")) {
      ctx.addIssue({
        code: "custom",
        message: `step indices must be contiguous from 1, got [${indices.join(", ")}]`,
        path: ["steps"],
      });
    }

    // Every source referenced by a field must be declared at recipe level.
    const declared = new Set(recipe.sources);
    for (const [i, ing] of recipe.ingredients.entries()) {
      if (!declared.has(ing.source)) {
        ctx.addIssue({
          code: "custom",
          message: `ingredient source "${ing.source}" is not in recipe.sources`,
          path: ["ingredients", i, "source"],
        });
      }
    }
    for (const [i, step] of recipe.steps.entries()) {
      if (!declared.has(step.source)) {
        ctx.addIssue({
          code: "custom",
          message: `step source "${step.source}" is not in recipe.sources`,
          path: ["steps", i, "source"],
        });
      }
    }
  });
export type Recipe = z.infer<typeof Recipe>;

/**
 * Why a video produced no recipe.
 *
 * ADR 0001 measured 1 in 5 descriptions carrying nothing usable — creators who
 * deliberately withhold the recipe to drive traffic to their own site. That is
 * a normal outcome, not an error, and it must be representable. The alternative
 * is an LLM inventing a recipe from a title, which is the worst thing this
 * system could do.
 */
export const InsufficientReason = z.enum([
  "no_ingredients_found",
  "description_is_link_only",
  "captions_unavailable",
  "not_a_recipe_video",
]);
export type InsufficientReason = z.infer<typeof InsufficientReason>;

export const ExtractionResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), recipe: Recipe }).strict(),
  z
    .object({
      status: z.literal("insufficient_source_material"),
      videoId: VideoId,
      reason: InsufficientReason,
      /** What was actually checked, so the message can be specific. */
      sourcesTried: z.array(SourceKind).min(1),
    })
    .strict(),
]);
export type ExtractionResult = z.infer<typeof ExtractionResult>;
