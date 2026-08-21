# Design — Phase 5

The canvas is the deliverable; these are the working files it is seeded from.
Nine artboards: a token sheet and eight screens at 390px.

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

Rather than abandon the principle, the matched trio stays for fills and icons —
where the 3:1 non-text threshold applies and perceptual evenness is what
matters — and a text tier was added:

| Pair | Ratio | Needs | Used for |
| --- | --- | --- | --- |
| ink on ground | 15.9:1 | 4.5 | body text |
| ink-soft on ground | 6.3:1 | 4.5 | secondary text |
| ink-faint on ground | 3.4:1 | 3.0 | meta, 12px bold and up only |
| accent-deep on ground | 7.4:1 | 4.5 | links |
| ground on accent | 4.7:1 | 4.5 | primary button label |
| warn-text on warn-wash | 5.4:1 | 4.5 | advisory text |
| herb-text on ground | 5.2:1 | 4.5 | creator-corrected badge |
| warn on ground | 4.4:1 | 3.0 | icons and fills only |
| herb on ground | 4.0:1 | 3.0 | icons and fills only |
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

## Handoff

Tokens live in `apps/web/app/globals.css` as CSS custom properties plus a
Tailwind 4 `@theme` mapping. Build components against the tokens, never
hardcoded values.

There is deliberately **no dark-mode block**. Cook mode is the dark surface this
product needs, and it is a mode the cook chooses rather than an OS preference —
a recipe page flipping dark because of a system setting is a different design,
not the same one inverted.

## Not done

- **Desktop widths.** `BUILD_PLAN.md` §5.2 asks for eight screens at mobile
  *and* desktop. Only 390px exists. The plan's own instruction is to design at
  390 first and treat desktop as the adaptation, so this is the ordering it
  asks for — but it is half the deliverable, and Phase 5's exit criteria are
  not met until the desktop pass exists.
- Open Graph / share images (Phase 6).
- The feed's ranked surface is a placeholder; it has nothing to rank until
  Phase 10.
