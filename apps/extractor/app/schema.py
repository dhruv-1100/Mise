"""The recipe contract, Python side.

Mirrors `packages/schema/src/recipe.ts` field for field and invariant for
invariant. The two are hand-maintained until the Phase 4 protobuf generates
both, so they are checked against the same JSON fixtures in
`packages/schema/fixtures/` — see `tests/test_schema.py`. If you change one
definition without the other, that test fails.

JSON is camelCase on the wire because TypeScript is the other consumer; Python
attributes stay snake_case and the alias generator bridges them.
"""

from datetime import datetime
from enum import StrEnum
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    TypeAdapter,
    model_validator,
)
from pydantic.alias_generators import to_camel


class Base(BaseModel):
    """Shared config.

    `extra="forbid"` mirrors zod's `.strict()`. It matters more than it looks:
    a typo'd field from an LLM response must fail loudly rather than being
    silently dropped and read back as a missing value.
    """

    model_config = ConfigDict(
        alias_generator=to_camel,
        populate_by_name=True,
        extra="forbid",
        str_strip_whitespace=True,
    )


class SourceKind(StrEnum):
    """Where a piece of extracted data came from.

    Load-bearing after ADR 0001: descriptions are primary, captions need
    creator OAuth and arrive later for a minority of videos. When both exist
    they disagree, and the resolution rule cannot be applied without knowing
    which field came from where.
    """

    DESCRIPTION = "description"
    CAPTION = "caption"
    #: The model watching the video itself (ADR 0006). Reads on the same rule as
    #: CAPTION: best source for technique, worst for quantities.
    VIDEO = "video"
    TITLE = "title"
    MANUAL = "manual"


class InsufficientReason(StrEnum):
    NO_INGREDIENTS_FOUND = "no_ingredients_found"
    DESCRIPTION_IS_LINK_ONLY = "description_is_link_only"
    CAPTIONS_UNAVAILABLE = "captions_unavailable"
    NOT_A_RECIPE_VIDEO = "not_a_recipe_video"


# YouTube video IDs are exactly 11 characters of URL-safe base64.
VideoId = Annotated[str, Field(pattern=r"^[A-Za-z0-9_-]{11}$")]
Confidence = Annotated[float, Field(ge=0, le=1)]


class Ingredient(Base):
    name: str = Field(min_length=1)

    # Never invent precision that was not in the source. "a glug", "a good
    # handful", "season to taste" produce qty=None with the original wording in
    # qty_text. A plausible number nobody wrote down is the worst failure this
    # schema can permit — downstream it is indistinguishable from a real one.
    qty: float | None = Field(gt=0)
    qty_text: str | None = Field(min_length=1)

    unit: str | None = Field(min_length=1)
    prep: str | None = Field(min_length=1)
    optional: bool
    source: SourceKind
    confidence: Confidence

    @model_validator(mode="after")
    def unit_requires_quantity(self) -> "Ingredient":
        if self.qty is None and self.unit is not None:
            raise ValueError("unit without a quantity is meaningless — set qty or clear unit")
        return self


class Step(Base):
    index: int = Field(gt=0)
    text: str = Field(min_length=1)
    duration_s: int | None = Field(gt=0)
    # Celsius. Fahrenheit is converted at extraction, never stored.
    temp_c: float | None
    source: SourceKind


class Yield(Base):
    qty: float | None = Field(gt=0)
    qty_text: str | None = Field(min_length=1)
    unit: str = Field(min_length=1)


class Creator(Base):
    """Attribution is not optional (CLAUDE.md).

    Required fields rather than a convention: a recipe that cannot be
    attributed cannot be represented, which is the correct outcome.
    """

    name: str = Field(min_length=1)
    channel_id: str = Field(min_length=1)
    channel_url: HttpUrl


class Conflict(Base):
    """A disagreement between sources, recorded rather than silently resolved.

    A resolution rule applied invisibly is a rule you cannot evaluate.
    """

    field: str = Field(min_length=1)
    description: str | None
    caption: str | None
    chosen: SourceKind
    reason: str = Field(min_length=1)


class Recipe(Base):
    video_id: VideoId
    title: str = Field(min_length=1)
    creator: Creator

    ingredients: list[Ingredient] = Field(min_length=1)
    steps: list[Step]
    # "yield" is a Python keyword, so the attribute is renamed and the wire
    # name is pinned explicitly.
    recipe_yield: Yield | None = Field(alias="yield")
    equipment: list[str]

    sources: list[SourceKind] = Field(min_length=1)
    conflicts: list[Conflict]

    extracted_at: datetime

    @model_validator(mode="after")
    def steps_are_contiguous(self) -> "Recipe":
        indices = [s.index for s in self.steps]
        expected = list(range(1, len(self.steps) + 1))
        if indices != expected:
            raise ValueError(f"step indices must be contiguous from 1, got {indices}")
        return self

    @model_validator(mode="after")
    def sources_are_declared(self) -> "Recipe":
        declared = set(self.sources)
        for i, ingredient in enumerate(self.ingredients):
            if ingredient.source not in declared:
                raise ValueError(
                    f'ingredient {i} source "{ingredient.source}" is not in recipe.sources'
                )
        for i, step in enumerate(self.steps):
            if step.source not in declared:
                raise ValueError(f'step {i} source "{step.source}" is not in recipe.sources')
        return self


class JobState(StrEnum):
    """Lifecycle of an extraction job."""

    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"


class JobStage(StrEnum):
    """Pipeline stages, in order.

    User-facing on purpose. BUILD_PLAN.md §5.2 asks for "live status, not a
    spinner. Show stage names." — so this is contract, not an internal detail.
    """

    FETCHING = "fetching"
    NORMALIZING = "normalizing"
    EXTRACTING = "extracting"
    #: Only when the description carried no recipe — see ADR 0006. Its own stage
    #: because it takes tens of seconds, and a progress screen that sat on
    #: "extracting" that long would look stuck rather than busy.
    WATCHING = "watching"
    CANONICALISING = "canonicalising"


class JobError(Base):
    code: str = Field(min_length=1)
    message: str = Field(min_length=1)


class Job(Base):
    """Mirrors `packages/schema/src/job.ts`. Change both or neither."""

    job_id: str = Field(min_length=1)
    video_id: VideoId
    state: JobState
    #: Completed attempts; 0 while first queued.
    attempt: int = Field(ge=0)

    queued_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

    stage: JobStage | None
    error: JobError | None

    #: Served from cache without re-extracting. Cache hit rate is a Phase 7
    #: metric and is unmeasurable if the response does not say.
    cached: bool

    @model_validator(mode="after")
    def error_matches_state(self) -> "Job":
        if self.state is JobState.FAILED and self.error is None:
            raise ValueError("a failed job must carry an error")
        if self.state is not JobState.FAILED and self.error is not None:
            raise ValueError(f'state "{self.state}" must not carry an error')
        return self

    @model_validator(mode="after")
    def timestamps_match_state(self) -> "Job":
        if self.state is JobState.RUNNING and self.started_at is None:
            raise ValueError("a running job must have startedAt")
        if self.state in (JobState.SUCCEEDED, JobState.FAILED) and self.finished_at is None:
            raise ValueError(f'state "{self.state}" is terminal and must have finishedAt')
        return self

    @model_validator(mode="after")
    def stage_only_while_running(self) -> "Job":
        # A stage is a position inside the work; it means nothing outside it.
        if self.state is not JobState.RUNNING and self.stage is not None:
            raise ValueError(f'state "{self.state}" must not carry a stage')
        return self


class ExtractionOk(Base):
    status: Literal["ok"]
    recipe: Recipe


class ExtractionInsufficient(Base):
    """Not an error.

    ADR 0001 measured 1 in 5 descriptions carrying nothing usable — creators
    who withhold the recipe to drive traffic to their own site. The alternative
    to representing this is an LLM inventing a recipe from a title.
    """

    status: Literal["insufficient_source_material"]
    video_id: VideoId
    reason: InsufficientReason
    sources_tried: list[SourceKind] = Field(min_length=1)


ExtractionResult = Annotated[
    ExtractionOk | ExtractionInsufficient,
    Field(discriminator="status"),
]

extraction_result_adapter: TypeAdapter[ExtractionResult] = TypeAdapter(ExtractionResult)
