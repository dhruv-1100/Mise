-- 0002 — accounts, RBAC, and the things a signed-in person accumulates
--
-- Phase 6.2. Two groups of tables live here, and the distinction matters when
-- reading them:
--
--   1. The Auth.js contract (users, accounts, sessions, verification_token).
--      Column names are NOT ours to choose — @auth/pg-adapter issues literal
--      SQL against quoted camelCase identifiers ("emailVerified", "userId",
--      "providerAccountId", "sessionToken"). Renaming any of them to snake_case
--      breaks the adapter at runtime with no type error to warn you, because
--      the adapter builds its SQL as strings. They are quoted here for exactly
--      that reason.
--
--   2. Mise's own tables (saves, cook_logs, notes, creator_claims,
--      recipe_overrides), which follow this repo's snake_case convention.
--
-- Applied with:  pnpm --filter @mise/web migrate
--
-- Note this is NOT run with psql. Neon's Postgres port is 5432, and plenty of
-- networks (including CI runners and the sandbox this was written in) allow
-- only 443 outbound. The runner uses @neondatabase/serverless, which carries
-- SQL over HTTPS, so it works anywhere the app itself works.

BEGIN;

-- ---------------------------------------------------------------------------
-- Auth.js contract
-- ---------------------------------------------------------------------------

-- uuid rather than serial: AdapterUser.id is typed `string` in Auth.js, and a
-- bigint id silently becomes a number that only mostly behaves like one. Also
-- means a user id in a URL or an analytics payload leaks no row count.
CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name            text,
  email           text UNIQUE,
  "emailVerified" timestamptz,
  image           text,

  -- RBAC (BUILD_PLAN.md §6.2). Enforced as a CHECK rather than a Postgres enum:
  -- adding a value to an enum type is a migration with a lock, adding one here
  -- is an ALTER of the constraint. The set is small and stable either way, but
  -- the CHECK keeps the failure mode visible in the schema dump.
  role            text NOT NULL DEFAULT 'user'
                  CHECK (role IN ('user', 'creator', 'admin')),

  created_at      timestamptz NOT NULL DEFAULT now()
);

-- The OAuth tokens themselves. refresh_token is what makes the incremental
-- YouTube scope survive past the access token's hour — see
-- docs/adr/0003-auth-and-sessions.md.
CREATE TABLE IF NOT EXISTS accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type                text NOT NULL,
  provider            text NOT NULL,
  "providerAccountId" text NOT NULL,
  refresh_token       text,
  access_token        text,
  expires_at          bigint,
  id_token            text,
  scope               text,
  session_state       text,
  token_type          text,

  -- One provider identity maps to one row. Without this, a repeated OAuth
  -- callback silently creates duplicate account links.
  UNIQUE (provider, "providerAccountId")
);

CREATE INDEX IF NOT EXISTS accounts_user_id_idx ON accounts ("userId");

-- Unused while the session strategy is JWT, and deliberately created anyway.
-- The adapter's contract includes it, and switching strategy later should be a
-- one-line config change rather than a migration on a live database.
CREATE TABLE IF NOT EXISTS sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires        timestamptz NOT NULL,
  "sessionToken" text NOT NULL UNIQUE
);

-- Likewise unused: there is no email provider. Same reasoning.
CREATE TABLE IF NOT EXISTS verification_token (
  identifier text NOT NULL,
  token      text NOT NULL,
  expires    timestamptz NOT NULL,
  PRIMARY KEY (identifier, token)
);

-- ---------------------------------------------------------------------------
-- Mise
-- ---------------------------------------------------------------------------

-- video_id is a YouTube id, validated as 11 URL-safe base64 characters by
-- `VideoId` in packages/schema. Repeated here as a CHECK because the database
-- outlives any one caller, and a junk id that reaches a UNIQUE index is a
-- permanent bad row.
-- A domain rather than a bare `text` column: the constraint then lives in one
-- place and applies to every table that stores a video id, including the ones
-- Phase 10 has not written yet.
--
-- Guarded by a DO block because Postgres has no CREATE DOMAIN IF NOT EXISTS.
-- The runner applies each file exactly once, so this is belt-and-braces — but a
-- migration that cannot be re-run is a migration you cannot recover with.
DO $$
BEGIN
  CREATE DOMAIN youtube_video_id AS text
    CHECK (VALUE ~ '^[A-Za-z0-9_-]{11}$');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;

CREATE TABLE IF NOT EXISTS saves (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id   youtube_video_id NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);

-- For "N people saved this", and for the Phase 11 ranker's baseline.
CREATE INDEX IF NOT EXISTS saves_video_id_idx ON saves (video_id);

-- Append-only, not a counter column.
--
-- `cooked_count` as an integer gives the same number and destroys the thing
-- that actually matters: WHEN each cook happened. D7/D30 retention (§6.3) is a
-- question about timestamps, and BUILD_PLAN.md §1 is explicit that retention
-- cannot be reconstructed after the fact. A row per cook can always be counted;
-- a count can never be un-summed.
CREATE TABLE IF NOT EXISTS cook_logs (
  id        bigserial PRIMARY KEY,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id  youtube_video_id NOT NULL,
  cooked_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cook_logs_user_cooked_idx ON cook_logs (user_id, cooked_at DESC);
CREATE INDEX IF NOT EXISTS cook_logs_user_video_idx  ON cook_logs (user_id, video_id);

CREATE TABLE IF NOT EXISTS notes (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id   youtube_video_id NOT NULL,
  body       text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, video_id)
);

-- A verified claim that a user owns a YouTube channel.
--
-- Only ever written after channels.list?mine=true has returned the id under the
-- user's own OAuth grant, so a row here is proof rather than an assertion. The
-- UNIQUE on channel_id is the important constraint: one channel has one owner,
-- and a second account cannot claim a channel someone already holds.
CREATE TABLE IF NOT EXISTS creator_claims (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id    text NOT NULL UNIQUE,
  channel_title text NOT NULL,
  verified_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creator_claims_user_id_idx ON creator_claims (user_id);

-- A creator's corrected version of an extraction of their own video.
--
-- Stores the whole Recipe, not a diff: the recipe page needs one authoritative
-- object to render, and reconstructing it from a patch chain at request time
-- would put merge logic on the read path. This is the structured extraction,
-- which BUILD_PLAN.md §1 explicitly permits persisting — it is not, and must
-- never become, raw description or transcript text.
CREATE TABLE IF NOT EXISTS recipe_overrides (
  video_id    youtube_video_id PRIMARY KEY,
  recipe_json jsonb NOT NULL,
  edited_by   uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

COMMIT;
