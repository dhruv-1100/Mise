-- 0003 — remember which channel an override belongs to
--
-- PUT /api/recipes/[videoId] authorises against the channel id on the
-- EXTRACTOR's copy of the recipe, never the creator's override — otherwise the
-- first edit could rewrite creator.channelId to a channel the editor owns and
-- the second edit would authorise itself (ADR 0003).
--
-- That is correct and, on its own, fragile: the extractor's recipe cache
-- expires. When it does, `GetRecipe` returns not-found and a creator can no
-- longer edit an override they already own — authorisation fails for a reason
-- that has nothing to do with authorisation.
--
-- Storing the channel id here fixes it without reopening the hole, because this
-- column is written by the server from the upstream extraction at the moment of
-- an already-authorised edit. It is never taken from the request body. So it is
-- the same trusted value, cached on our side instead of theirs.
--
--   pnpm --filter @mise/web migrate

BEGIN;

ALTER TABLE recipe_overrides
  ADD COLUMN IF NOT EXISTS channel_id text;

CREATE INDEX IF NOT EXISTS recipe_overrides_channel_id_idx
  ON recipe_overrides (channel_id);

COMMIT;
