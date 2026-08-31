-- 0004 — a person's own version of a recipe
--
-- Distinct from `recipe_overrides`, and the distinction is the whole point:
--
--   recipe_overrides   one row per video, written only by a creator who has
--                      proved they own the channel, and authoritative for
--                      EVERY reader. It corrects what the extractor got wrong.
--
--   personal_recipes   one row per (person, video), written by anyone signed
--                      in, and visible ONLY to its author. It is not a
--                      correction; it is "I use less chilli than he does".
--
-- Folding them into one table would mean a reader's private preference could
-- become everybody's recipe through a missing WHERE clause. Separate tables
-- make that a schema error rather than an authorisation bug.
--
--   pnpm --filter @mise/web migrate

BEGIN;

CREATE TABLE IF NOT EXISTS personal_recipes (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id    youtube_video_id NOT NULL,

  -- The whole recipe, not a diff. Same reasoning as recipe_overrides: the page
  -- needs one object to render, and reconstructing it from a patch chain would
  -- put merge logic on the read path.
  --
  -- Quantities here are ALWAYS at the recipe's own yield, never at whatever
  -- serving count the editor happened to be viewing. Storing scaled values
  -- would make the scaling engine compose with itself and quietly double.
  recipe_json jsonb NOT NULL,

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (user_id, video_id)
);

-- For "which recipes have I made my own", on /me.
CREATE INDEX IF NOT EXISTS personal_recipes_user_idx
  ON personal_recipes (user_id, updated_at DESC);

COMMIT;
