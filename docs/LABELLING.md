# Labelling the eval set

50 videos in `apps/extractor/tests/fixtures/eval/`. This is the most valuable
few hours in the project: without it there is no accuracy number, no Phase 2
exit decision, no nightly regression job, and no defensible resume bullet.

## The one rule that matters

**Never label from the pipeline's own output, and never from the description
via an LLM.** The pipeline reads the description and asks Gemini to extract a
recipe. If ground truth comes from that same route, every mistake the model
makes becomes a mistake you agree with, recall reads ~1.00, and the number
measures nothing.

Label from **the video**. That is the independent source.

An LLM may be used as a *formatter* — you supply the content, it produces JSON.
See the prompt at the bottom.

## Setup

```bash
cd apps/extractor
set -a; . ../../.env; set +a

ls tests/fixtures/eval/                       # the 50 stubs
cat ../../scripts/spike_output/eval/<id>.txt  # cleaned description, for reference
open "https://youtu.be/<id>"                  # the actual source
```

Progress check, any time:

```bash
uv run python - <<'PY'
import json, pathlib
d = pathlib.Path("tests/fixtures/eval")
done = sum(
    1 for p in d.glob("*.json")
    if "_instructions" not in (j := json.loads(p.read_text()))
    and (j.get("expect") == "insufficient"
         or any(str(i.get("name", "")).strip() for i in (j.get("ingredients") or [])))
)
print(f"{done}/50 labelled")
PY
```

## What ground truth means here

**The recipe as the video presents it.** Not "what a clever person could squeeze
out of the description".

That choice makes recall measure the whole system, source limitations included,
which is the honest thing to report — a user does not care whether an ingredient
was missed because the model failed or because the creator never wrote it down.
The `Worst recall` list in the eval output is what separates the two afterwards.

## Decision rules

**`expect`** — set to `"insufficient"` when the *description* carries no usable
recipe, and leave `ingredients` and `steps` empty. About 8 of the 50 are like
this, all Hebbars Kitchen plus `Od7Z_F6dn0I`, whose description is entirely
empty. Correctly refusing these is a measured behaviour, not a gap.

Three Your Food Lab videos (`oWFKMG48Y8o`, `i_E-m62p144`, `kYRcu5ZWxbo`) put the
recipe in a **pinned comment**. The Data API does not return comments, so the
pipeline genuinely cannot see it — label those `insufficient` too.

**Quantities** — write what the source says, never a tidier version.

| Source says | `qty` | `qty_text` | `unit` |
| --- | --- | --- | --- |
| `2 tbsp oil` | `2` | `null` | `"tbsp"` |
| `salt to taste` | `null` | `"to taste"` | `null` |
| `8-10 cloves garlic` | `8` | `"8-10"` | `"clove"` |
| `a pinch of hing` | `null` | `"a pinch"` | `null` |
| `3 onions` | `3` | `null` | `null` |
| `500g paneer` | `500` | `null` | `"g"` |

A number you invented is worse than an admitted absence. The scorer treats a
number against a `null` as a miss in both directions, deliberately.

**Names** — lower case, the plain ingredient. `"tomato"`, not
`"TOMATO | टमाटर"`. Put preparation in `prep`, not the name: `"garlic"` with
`prep: "minced"`. The matcher already strips words like *chopped* and *fresh*,
so do not agonise over them.

**Steps** — one per real instruction, in order, `index` starting at 1. Paraphrase
freely; the scorer matches on similarity and only measures ordering. Skip
"subscribe" and "link in bio".

**Optional ingredients** — `optional: true` for anything the creator calls
optional or for-garnish.

## Worked example

```json
{
  "video_id": "59nYjDQqjs8",
  "title": "Shahi Dal Tadka",
  "creator": "Chef Ranveer Brar",
  "expect": "ok",
  "ingredients": [
    {"name": "toor dal", "qty": 1, "qty_text": null, "unit": "cup",
     "prep": "soaked", "optional": false},
    {"name": "salt", "qty": null, "qty_text": "to taste", "unit": null,
     "prep": null, "optional": false},
    {"name": "ghee", "qty": 2, "qty_text": null, "unit": "tbsp",
     "prep": null, "optional": false},
    {"name": "coriander leaves", "qty": null, "qty_text": "for garnish",
     "unit": null, "prep": "chopped", "optional": true}
  ],
  "steps": [
    {"index": 1, "text": "Pressure cook the soaked dal with salt and turmeric."},
    {"index": 2, "text": "Heat ghee and temper cumin, garlic and dried chillies."},
    {"index": 3, "text": "Pour the tempering over the dal and simmer."}
  ],
  "yield": {"qty": 4, "unit": "serving"},
  "equipment": ["pressure cooker"]
}
```

Delete `_instructions` when a file is done — that field is what marks a stub as
unlabelled.

## Prompt: formatting your notes

Use this only after watching the video. You provide the content; the model only
shapes it. Paste your rough notes at the bottom.

```text
You are formatting my hand-written recipe notes into a strict JSON format. You
are a formatter, not an extractor.

Rules:
- Use ONLY what my notes say. Do not add ingredients, steps, quantities or
  equipment from your own knowledge of this dish, however obvious they seem. If
  my notes omit something, it stays omitted — the omission is the data.
- Never convert a vague amount into a number. "to taste" stays qty: null with
  qty_text: "to taste".
- For a range like "8-10 cloves", set qty to the LOWER bound and put the full
  range in qty_text.
- Ingredient names lower case and plain. Preparation goes in "prep", not the
  name.
- Steps in the order I give them, index starting at 1.
- If I say there is no usable recipe, return "expect": "insufficient" with empty
  ingredients and steps.
- Output only the JSON object. No commentary, no markdown fence.

Shape:
{
  "video_id": "<I will give this>",
  "title": "<I will give this>",
  "creator": "<I will give this>",
  "expect": "ok" | "insufficient",
  "ingredients": [
    {"name": "", "qty": null, "qty_text": null, "unit": null, "prep": null,
     "optional": false}
  ],
  "steps": [{"index": 1, "text": ""}],
  "yield": {"qty": null, "unit": "serving"},
  "equipment": []
}

video_id: <ID>
title: <TITLE>
creator: <CREATOR>

My notes:
<PASTE YOUR NOTES>
```

## Validate as you go

```bash
uv run pytest tests/test_eval_labels.py -q
```

That checks every labelled file parses, has no leftover `_instructions`, uses
sane quantity combinations, and has contiguous step indices.

## Then

```bash
uv run python scripts/eval.py --limit 5      # cheap check
uv run python scripts/eval.py --json /tmp/eval.json
```
