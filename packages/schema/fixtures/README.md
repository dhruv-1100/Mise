# Shared schema fixtures

Every file under `*/valid/` must parse. Every file under `*/invalid/` must be
rejected. Both test suites assert exactly that against exactly these files:

- `packages/schema/tests/recipe.test.ts` (zod)
- `apps/extractor/tests/test_schema.py` (Pydantic)

That is the whole point. The TypeScript and Python definitions are maintained by
hand until the Phase 4 protobuf replaces them, and two hand-maintained
definitions drift. Anything that parses in one language and not the other fails
CI here rather than in production.

**Adding a fixture is how you change the contract.** Add the case, watch both
suites fail, then change both definitions.

All content is synthetic. Real video descriptions are third-party copyrighted
text and may only ever live in `scripts/spike_output/`, which is gitignored —
so none of it appears here, even though these cases are modelled on shapes
observed during the Phase 2.1 spike. The fixtures carry no comment fields
because both schemas are strict and would reject them; the rationale lives
here instead.

## Why each valid case exists

| Fixture | What it pins down |
| --- | --- |
| `recipe/valid/full-recipe.json` | The ordinary case: quantities, ordered steps, yield, equipment. |
| `recipe/valid/vague-quantities.json` | `qty: null` with the wording kept in `qtyText`. "A good glug" must survive as itself and never become a number. |
| `recipe/valid/ingredients-only.json` | Empty `steps` is legal. ADR 0001 found 1 in 5 descriptions carry a full ingredient list and no method. |
| `recipe/valid/description-caption-conflict.json` | Two sources disagreeing, with the resolution recorded in `conflicts`. Only reachable once a creator grants OAuth, but the shape must exist first. |
| `result/valid/insufficient-*.json` | "No recipe here" as a typed outcome rather than an error or, far worse, an invented recipe. |

## Why each invalid case exists

| Fixture | Invariant |
| --- | --- |
| `negative-qty`, `zero-qty` | Quantities are positive or absent. |
| `unit-without-qty` | A unit with no number is not a quantity. |
| `noncontiguous-steps`, `duplicate-step-index` | Step indices are exactly 1..n, so "step 3 of 7" cannot lie. |
| `missing-creator`, `bad-channel-url` | Attribution is non-negotiable, so an unattributable recipe must be unrepresentable. |
| `empty-ingredients` | A recipe with no ingredients is not a recipe. |
| `undeclared-source`, `unknown-source` | Field-level provenance must be declared at recipe level, or conflict resolution is blind. |
| `unknown-field` | Strictness. A typo'd field from an LLM must fail loudly, not vanish. |
| `bad-video-id`, `bad-timestamp`, `confidence-out-of-range`, `empty-name` | Basic field constraints. |
| `result/invalid/*` | The discriminated union rejects unknown statuses, unknown reasons, and an `ok` with no recipe. |
