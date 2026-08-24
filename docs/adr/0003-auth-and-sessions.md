# 0003 — Accounts: JWT sessions over database users, and a token we refuse to keep

- **Status:** Accepted
- **Date:** 2026-08-24
- **Phase:** 6.2 (accounts)
- **Asked for by:** `BUILD_PLAN.md` §6.2 — "NextAuth with Google OAuth2.
  Sessions as JWT. Document the token lifecycle in an ADR."

## Decision

1. **Auth.js v5 (`next-auth@5`) with a single Google OAuth2 provider.**
2. **Sessions are JWTs; users, roles and claims are rows.** Both, not either.
3. **No OAuth token is ever written to the session cookie**, and the YouTube
   access token is not persisted anywhere at all — it is used once, inside the
   OAuth callback, and dropped.
4. **RBAC is `user` / `creator` / `admin`**, but a role never authorises a
   write on its own. Ownership does.

## The token lifecycle, concretely

```
  Google  ──id_token──▶  Auth.js callback
                              │
                              ├─▶ users / accounts rows      (Postgres, long-lived)
                              │
                              ├─▶ JWT  { sub, userId, role } (JWE cookie, 30d, httpOnly)
                              │
                              └─▶ access_token ──▶ channels.list?mine=true ──▶ discarded
```

| Stage | Where it lives | Lifetime | Who can read it |
| --- | --- | --- | --- |
| Google `id_token` | request memory | the callback | server only |
| Google `access_token` | request memory | the callback | server only |
| Google `refresh_token` | **not requested** | — | — |
| Session JWT | `authjs.session-token` cookie | 30 days, rolling | server only (`httpOnly`, `SameSite=Lax`, `Secure`) |
| `userId`, `role` | inside that JWT | same | server only |
| user, role, claims | Postgres | until deleted | server only |

The session cookie is a JWE — encrypted, not merely signed — derived from
`AUTH_SECRET`. Rotating `AUTH_SECRET` invalidates every session, which is the
intended emergency lever and the reason it is not derived from anything else.

## Why JWT sessions *and* a database adapter

These are usually presented as alternatives. They are not, and this project
needs both halves:

- **Rows**, because a role, a channel claim, a save and a note all have to
  outlive a cookie and be queryable. A session-only design cannot answer "who
  owns this channel".
- **A stateless session**, because the alternative is a `SELECT` on the sessions
  table on every request to every page, and the recipe page already pays for a
  gRPC call to the extractor.

The cost is **staleness**: a JWT keeps saying `role: "user"` after the row says
`creator`. This is handled rather than ignored — the `jwt` callback re-reads the
role from the database on sign-in and on an explicit session update, so a claim
takes effect immediately instead of in thirty days.

## Why the role is not an authorisation decision

`session.user.role` decides what to render. It never decides what may be
written. Every mutating route re-derives permission from ownership:
`canEditChannel(userId, channelId)` asks whether *this* person holds a verified
claim on *this* channel.

The concrete attack this closes: `PUT /api/recipes/[videoId]` authorises against
the **extractor's** copy of the recipe, never the creator's override. Reading
`creator.channelId` out of the override would mean the first edit could rewrite
that field to a channel the editor owns, and the second edit would authorise
itself. Reading upstream every time breaks the loop.

## Why the YouTube token is used once and thrown away

Channel ownership has to be *proved*, not asserted, or "claim your channel" is a
text box that says "I am Hebbar's Kitchen". The only honest proof available is
`channels.list?mine=true` under the person's own OAuth grant — the official
YouTube Data API v3, which `CLAUDE.md` requires and ADR 0001 explains.

Having proved it, we have no further use for the token. So:

- the scope is requested **incrementally**, from the claim page only, never at
  signup — a visitor who wants to save a recipe is never shown a consent screen
  asking for access to their YouTube account;
- `access_type` is `online`, so **no refresh token is issued**;
- the verification runs inside the `signIn` callback, where the token is already
  in memory, and the function returns without storing it.

This is the same rule the pipeline applies to transcripts — fetch, use, discard
— and it applies with more force to a credential. The database holds the
*answer* (a `creator_claims` row), not the means of asking again.

`prompt: "consent"` is required, not decorative: Google silently skips the
consent screen for an account that has already authorised the app and returns a
token carrying only the original scopes. Without it the claim fails with a 403
that looks like a bug in our code.

## Known cost: Google app verification

`youtube.readonly` is a **sensitive scope**. Google caps unverified apps at 100
users for sensitive scopes and requires a verification review beyond that. The
incremental design contains the blast radius — only people who claim a channel
ever touch the scope, and everyone else signs in under `openid email profile`,
which needs no review. If claiming ever outgrows 100 creators, that is a good
problem and a form to fill in, not an architecture change.

## Alternatives rejected

| Option | Why not |
| --- | --- |
| Database sessions | A `SELECT` per request for a value that changes about twice a year. The plan asks for JWT by name, and the resume line is "OAuth2 + JWT session handling". |
| Ask for `youtube.readonly` at signup | Worst consent screen in the funnel, shown to everyone, for a feature almost nobody uses. Also pulls every user into the 100-user verification cap. |
| Store the YouTube refresh token | Would let us re-check ownership later. Also a permanent credential for someone else's YouTube account, sitting in our database, for a check we run once. Not worth it. |
| Manual admin approval of claims | No OAuth scope cost and no verification review, but the proof is "someone emailed and said so", and it scales exactly as far as one person's inbox. |
| Trust `role: "creator"` for edits | A role says what kind of person someone is. It does not say which channel is theirs, and that is the only question that matters here. |

## Consequences

- Reading the session reads cookies, which opts every page under the site layout
  into dynamic rendering, including the home page. Deliberate: one cheap server
  render against a client-side session fetch and a signed-out flash on every
  page. Partial prerendering is the fix when it stabilises in Next.
- `AUTH_SECRET` is now a real operational secret. Losing it signs everyone out;
  leaking it is a full session-forgery compromise.
- `@auth/core` is an explicit devDependency of `apps/web` purely so the `JWT`
  interface can be reopened. Augmenting `next-auth/jwt` instead compiles
  cleanly, does nothing, and leaves `token.role` untyped — which is precisely
  how an authorisation field stops being checked.
