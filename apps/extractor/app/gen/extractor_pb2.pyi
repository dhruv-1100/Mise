from google.protobuf.internal import enum_type_wrapper as _enum_type_wrapper
from google.protobuf import descriptor as _descriptor
from google.protobuf import message as _message
from collections.abc import Mapping as _Mapping
from typing import ClassVar as _ClassVar, Optional as _Optional, Union as _Union

DESCRIPTOR: _descriptor.FileDescriptor

class JobState(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    JOB_STATE_UNSPECIFIED: _ClassVar[JobState]
    JOB_STATE_QUEUED: _ClassVar[JobState]
    JOB_STATE_RUNNING: _ClassVar[JobState]
    JOB_STATE_SUCCEEDED: _ClassVar[JobState]
    JOB_STATE_FAILED: _ClassVar[JobState]

class JobStage(int, metaclass=_enum_type_wrapper.EnumTypeWrapper):
    __slots__ = ()
    JOB_STAGE_UNSPECIFIED: _ClassVar[JobStage]
    JOB_STAGE_FETCHING: _ClassVar[JobStage]
    JOB_STAGE_NORMALIZING: _ClassVar[JobStage]
    JOB_STAGE_EXTRACTING: _ClassVar[JobStage]
    JOB_STAGE_CANONICALISING: _ClassVar[JobStage]
    JOB_STAGE_WATCHING: _ClassVar[JobStage]
JOB_STATE_UNSPECIFIED: JobState
JOB_STATE_QUEUED: JobState
JOB_STATE_RUNNING: JobState
JOB_STATE_SUCCEEDED: JobState
JOB_STATE_FAILED: JobState
JOB_STAGE_UNSPECIFIED: JobStage
JOB_STAGE_FETCHING: JobStage
JOB_STAGE_NORMALIZING: JobStage
JOB_STAGE_EXTRACTING: JobStage
JOB_STAGE_CANONICALISING: JobStage
JOB_STAGE_WATCHING: JobStage

class ExtractRequest(_message.Message):
    __slots__ = ("video",)
    VIDEO_FIELD_NUMBER: _ClassVar[int]
    video: str
    def __init__(self, video: _Optional[str] = ...) -> None: ...

class ExtractResponse(_message.Message):
    __slots__ = ("job", "created")
    JOB_FIELD_NUMBER: _ClassVar[int]
    CREATED_FIELD_NUMBER: _ClassVar[int]
    job: Job
    created: bool
    def __init__(self, job: _Optional[_Union[Job, _Mapping]] = ..., created: _Optional[bool] = ...) -> None: ...

class StreamStatusRequest(_message.Message):
    __slots__ = ("job_id",)
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    job_id: str
    def __init__(self, job_id: _Optional[str] = ...) -> None: ...

class GetStatusRequest(_message.Message):
    __slots__ = ("job_id",)
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    job_id: str
    def __init__(self, job_id: _Optional[str] = ...) -> None: ...

class GetRecipeRequest(_message.Message):
    __slots__ = ("video_id",)
    VIDEO_ID_FIELD_NUMBER: _ClassVar[int]
    video_id: str
    def __init__(self, video_id: _Optional[str] = ...) -> None: ...

class GetRecipeResponse(_message.Message):
    __slots__ = ("recipe_json", "found")
    RECIPE_JSON_FIELD_NUMBER: _ClassVar[int]
    FOUND_FIELD_NUMBER: _ClassVar[int]
    recipe_json: str
    found: bool
    def __init__(self, recipe_json: _Optional[str] = ..., found: _Optional[bool] = ...) -> None: ...

class JobError(_message.Message):
    __slots__ = ("code", "message")
    CODE_FIELD_NUMBER: _ClassVar[int]
    MESSAGE_FIELD_NUMBER: _ClassVar[int]
    code: str
    message: str
    def __init__(self, code: _Optional[str] = ..., message: _Optional[str] = ...) -> None: ...

class Job(_message.Message):
    __slots__ = ("job_id", "video_id", "state", "attempt", "queued_at", "started_at", "finished_at", "stage", "error", "cached", "recipe_json")
    JOB_ID_FIELD_NUMBER: _ClassVar[int]
    VIDEO_ID_FIELD_NUMBER: _ClassVar[int]
    STATE_FIELD_NUMBER: _ClassVar[int]
    ATTEMPT_FIELD_NUMBER: _ClassVar[int]
    QUEUED_AT_FIELD_NUMBER: _ClassVar[int]
    STARTED_AT_FIELD_NUMBER: _ClassVar[int]
    FINISHED_AT_FIELD_NUMBER: _ClassVar[int]
    STAGE_FIELD_NUMBER: _ClassVar[int]
    ERROR_FIELD_NUMBER: _ClassVar[int]
    CACHED_FIELD_NUMBER: _ClassVar[int]
    RECIPE_JSON_FIELD_NUMBER: _ClassVar[int]
    job_id: str
    video_id: str
    state: JobState
    attempt: int
    queued_at: str
    started_at: str
    finished_at: str
    stage: JobStage
    error: JobError
    cached: bool
    recipe_json: str
    def __init__(self, job_id: _Optional[str] = ..., video_id: _Optional[str] = ..., state: _Optional[_Union[JobState, str]] = ..., attempt: _Optional[int] = ..., queued_at: _Optional[str] = ..., started_at: _Optional[str] = ..., finished_at: _Optional[str] = ..., stage: _Optional[_Union[JobStage, str]] = ..., error: _Optional[_Union[JobError, _Mapping]] = ..., cached: _Optional[bool] = ..., recipe_json: _Optional[str] = ...) -> None: ...

class HealthRequest(_message.Message):
    __slots__ = ()
    def __init__(self) -> None: ...

class HealthResponse(_message.Message):
    __slots__ = ("status", "service", "version")
    STATUS_FIELD_NUMBER: _ClassVar[int]
    SERVICE_FIELD_NUMBER: _ClassVar[int]
    VERSION_FIELD_NUMBER: _ClassVar[int]
    status: str
    service: str
    version: str
    def __init__(self, status: _Optional[str] = ..., service: _Optional[str] = ..., version: _Optional[str] = ...) -> None: ...
