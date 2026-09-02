# Design — Phase 5

The canvas is the deliverable; these are the working files it is seeded from.
Seventeen artboards across two pages: a token sheet and eight screens at 390px,
then the same eight at 1440px.

Re-seed after editing any `.dc.html`, then republish to the same artifact URL.

## Direction

`BUILD_PLAN.md` §5.1 set it: a warm neutral base with one saturated accent,
deliberately not the Tailwind blue-and-gray that reads as template. Instrument
Serif for display, Manrope for anything read at speed.

Cook mode drove the type scale rather than being adapted to it. The constraint
is stated in the plan — legible at arm's length, on a counter, by someone with
wet hands — so it was designed first at 28px step text and an 18px floor, and
the browsing screens scale down from there.

## Built against real data

Nothing here is lorem. The recipe screen is the actual Ranveer Brar Aloo
Paratha extraction; the progress screen shows the real `stage` values from the
Phase 4 job contract; the error states carry the real codes the pipeline
returns, including `description_is_link_only` — the Hebbars Kitchen case from
ADR 0001, which is roughly one video in five and the one place the product
must refuse rather than invent.

The serving stepper runs the Phase 3 engine rather than mocking it: salt and
spices grow by `factor^0.7176`, potatoes round to whole units and say so, and
"to taste" never becomes a number.

## Accessibility (§5.5)

Contrast was computed from the oklch values, not eyeballed, and the audit found
a real problem worth recording.

The palette principle was "accent, herb and warn share lightness 0.565 and
chroma 0.168, and differ only in hue" — which makes them *perceptually* even.
But **WCAG relative luminance is not perceptual lightness**: at that shared
lightness, herb measured 4.01:1 and warn 4.37:1 against ground, both under the
4.5:1 small text requires. They were being used for 11–12px bold labels.

**Re-measured after the 2a chroma pass.** That pass was specified as "lightness
and hue unchanged, only chroma moves", which would have left every ratio here
intact. It is not what the values do — lightness or hue moves on all nine, and
herb's lightness moves by 0.045 — so the table was recomputed rather than
trusted. Nothing regressed and two things improved: `ground on accent` 4.7 to
5.0, and `herb on ground` 4.01 to 4.63, which is what lets herb become a
section-heading colour instead of a fill. Under the old value that promotion
would have shipped a heading at 4.01:1.

Rather than abandon the principle, the matched trio stays for fills and icons —
where the 3:1 non-text threshold applies and perceptual evenness is what
matters — and a text tier was added:

| Pair | Ratio | Needs | Used for |
| --- | --- | --- | --- |
| ink on ground | 15.6:1 | 4.5 | body text |
| ink-soft on ground | 6.2:1 | 4.5 | secondary text |
| ink-faint on ground | 3.3:1 | 3.0 | meta, 12px bold and up only |
| accent-deep on ground | 7.3:1 | 4.5 | links |
| ground on accent | 5.0:1 | 4.5 | primary button label |
| warn-text on warn-wash | 5.4:1 | 4.5 | advisory text |
| herb-text on ground | 5.7:1 | 4.5 | creator-corrected badge |
| warn on ground | 4.3:1 | 3.0 | icons and fills only |
| herb on ground | 4.6:1 | 4.5 | section headings and fills |
| cook-ink on cook-ground | 16.9:1 | 4.5 | cook mode step text |
| cook-ink-soft on cook-ground | 8.7:1 | 4.5 | cook mode secondary |

Other commitments encoded in the design:

- **44px minimum targets** everywhere, via a `.tap` rule rather than per-element
  discipline. Wet hands are not precise.
- **18px body floor in cook mode**, 28px for step text.
- **Meaning never rests on colour alone** — the progress screen pairs its state
  colours with a tick, a ring and an outline; advisories pair the wash with an
  icon and a label.
- **`prefers-reduced-motion`** honoured in `globals.css`; cook mode animates
  progress and timers.
- **No fake OS chrome.** No painted status bar or keyboard — the real ones
  render over the layout on a device, and a painted copy reads as doubled up.

Not yet verified: focus order and screen-reader labelling. Those need the real
DOM in Phase 6, not a static artboard, and claiming them from a mockup would be
dishonest.

## Desktop (§5.4)

390px was designed first and desktop is the adaptation, which is the ordering
the plan asks for. The rule applied: **only restructure where the extra width
changes what a person can do.**

| Screen | At 1440px | Why |
| --- | --- | --- |
| Recipe | Two columns, sticky ingredient rail | The rail stays put while the method scrolls — the actual reason to want a big screen while cooking |
| Feed, Creator | Three-column grid | Scanning many is the task |
| Landing | Split hero with a real extraction beside it | Room to show the output rather than describe it |
| Cook mode | Two columns, 42px step text | Further from the eye than a phone on a counter |
| Extracting, Saved, States | Centred column, unchanged structure | Wider would only mean longer lines to read |

Cook mode drops the app chrome at every width — no nav, no search. It is the
one screen where the phone is propped up and everything else is in the way.

## Handoff

Tokens live in `apps/web/app/globals.css` as CSS custom properties plus a
Tailwind 4 `@theme` mapping. Build components against the tokens, never
hardcoded values.

There is deliberately **no dark-mode block**. Cook mode is the dark surface this
product needs, and it is a mode the cook chooses rather than an OS preference —
a recipe page flipping dark because of a system setting is a different design,
not the same one inverted.

## Not done

- Open Graph / share images (Phase 6).
- **Focus order and screen-reader labelling.** These need the real DOM, not a
  static artboard, so they are a Phase 6 obligation rather than a claim that
  can honestly be made here.
- A tablet breakpoint. The two widths bracket it; whether it needs its own
  layout is a question for real usage.
- The feed's ranked surface is a placeholder; it has nothing to rank until
  Phase 10.
