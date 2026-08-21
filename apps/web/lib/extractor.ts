/**
 * gRPC client for the extraction service.
 *
 * Server-only. `@grpc/grpc-js` needs Node APIs and must never reach the
 * browser bundle, which is why the generated stubs in `@mise/schema` are
 * transport-agnostic definitions and the transport is bound here instead.
 *
 * BUILD_PLAN.md §4 puts gRPC on this boundary deliberately. The tradeoff worth
 * knowing: Cloud Run scales to zero, so the first call after an idle period
 * pays a cold start on top of the RPC.
 */

import "server-only";

import {
  ChannelCredentials,
  Client,
  type ClientReadableStream,
  makeGenericClientConstructor,
  type ServiceDefinition,
  type ServiceError,
} from "@grpc/grpc-js";

import {
  ExtractorDefinition,
  Job,
  JobStage,
  JobState,
  type ExtractResponse,
} from "@mise/schema/gen/extractor";

export type { ExtractResponse };
export { Job, JobStage, JobState };

const ADDRESS = process.env.EXTRACTOR_GRPC_ADDRESS ?? "127.0.0.1:50051";

/** Codes the extractor uses, mirrored from its HTTP error envelope. */
export type ExtractorErrorCode =
  | "not_a_youtube_url"
  | "video_not_found"
  | "quota_exceeded"
  | "queue_full"
  | "llm_unavailable"
  | "unavailable"
  | "internal_error";

export class ExtractorError extends Error {
  constructor(
    readonly code: ExtractorErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = "ExtractorError";
  }
}

/**
 * gRPC status -> our vocabulary.
 *
 * The BFF branches on one set of codes regardless of transport, so a UI state
 * never has to know whether it came from gRPC or HTTP.
 */
function toExtractorError(error: ServiceError): ExtractorError {
  switch (error.code) {
    case 3: // INVALID_ARGUMENT
      return new ExtractorError("not_a_youtube_url", error.details);
    case 5: // NOT_FOUND
      return new ExtractorError("video_not_found", error.details);
    case 8: // RESOURCE_EXHAUSTED — the extractor's backpressure
      return new ExtractorError("queue_full", error.details, 30);
    case 14: // UNAVAILABLE — service down, or a cold start that timed out
      return new ExtractorError("unavailable", error.details);
    default:
      return new ExtractorError("internal_error", error.details || error.message);
  }
}

/**
 * grpc-js names client methods after the ServiceDefinition KEYS, which are
 * ts-proto's camelCase names — not the PascalCase rpc names in the .proto.
 */
interface ExtractorClient extends Client {
  extract(
    request: { video: string },
    callback: (err: ServiceError | null, res: ExtractResponse) => void,
  ): void;
  getStatus(
    request: { jobId: string },
    callback: (err: ServiceError | null, res: Job) => void,
  ): void;
  getRecipe(
    request: { videoId: string },
    callback: (err: ServiceError | null, res: { recipeJson: string; found: boolean }) => void,
  ): void;
  streamStatus(request: { jobId: string }): ClientReadableStream<Job>;
}

/**
 * ts-proto's generic definition -> a grpc-js ServiceDefinition.
 *
 * This adapter is the whole point of generating `generic-definitions` instead
 * of a grpc-js client: the definition carries protobuf codecs and no
 * transport, so `@mise/schema` stays importable from the browser and the
 * binding to grpc-js happens here, on the server, once.
 */
function toServiceDefinition(): ServiceDefinition {
  const methods = ExtractorDefinition.methods as unknown as Record<
    string,
    {
      name: string;
      requestStream: boolean;
      responseStream: boolean;
      requestType: { encode(v: unknown): { finish(): Uint8Array }; decode(b: Uint8Array): unknown };
      responseType: { encode(v: unknown): { finish(): Uint8Array }; decode(b: Uint8Array): unknown };
    }
  >;

  const definition: Record<string, unknown> = {};
  for (const [key, method] of Object.entries(methods)) {
    definition[key] = {
      path: `/${ExtractorDefinition.fullName}/${method.name}`,
      requestStream: method.requestStream,
      responseStream: method.responseStream,
      requestSerialize: (value: unknown) =>
        Buffer.from(method.requestType.encode(value).finish()),
      requestDeserialize: (bytes: Buffer) => method.requestType.decode(bytes),
      responseSerialize: (value: unknown) =>
        Buffer.from(method.responseType.encode(value).finish()),
      responseDeserialize: (bytes: Buffer) => method.responseType.decode(bytes),
    };
  }
  return definition as ServiceDefinition;
}

let cached: ExtractorClient | null = null;

function client(): ExtractorClient {
  // One channel per process. gRPC channels are long-lived and multiplex, so
  // building one per request would pay a TCP and HTTP/2 handshake every time.
  if (cached === null) {
    const Ctor = makeGenericClientConstructor(toServiceDefinition(), "Extractor");
    // makeGenericClientConstructor returns a dynamically-shaped client, so
    // TypeScript cannot see the methods the definition adds. The narrowing goes
    // through unknown deliberately — the shape is guaranteed by the generated
    // ExtractorDefinition, not by the constructor's declared type.
    cached = new Ctor(
      ADDRESS,
      ChannelCredentials.createInsecure(),
    ) as unknown as ExtractorClient;
  }
  return cached;
}

export function extract(video: string): Promise<ExtractResponse> {
  return new Promise((resolve, reject) => {
    client().extract({ video }, (err, res) =>
      err ? reject(toExtractorError(err)) : resolve(res),
    );
  });
}

export function getStatus(jobId: string): Promise<Job> {
  return new Promise((resolve, reject) => {
    client().getStatus({ jobId }, (err, res) =>
      err ? reject(toExtractorError(err)) : resolve(res),
    );
  });
}

/**
 * Fetch an already-extracted recipe by VIDEO id.
 *
 * Keyed by video, not job: a recipe outlives the job that produced it, and
 * recipe URLs have to stay stable and shareable.
 */
export function getRecipe(videoId: string): Promise<{ recipeJson: string; found: boolean }> {
  return new Promise((resolve, reject) => {
    client().getRecipe({ videoId }, (err, res) =>
      err ? reject(toExtractorError(err)) : resolve(res),
    );
  });
}

/**
 * Async iterator over job status, ending when the job reaches a terminal state.
 *
 * The server only emits on change, so this yields nothing while a stage is
 * still running rather than repeating itself.
 */
export async function* streamStatus(jobId: string): AsyncGenerator<Job> {
  const stream = client().streamStatus({ jobId });
  try {
    for await (const job of stream as AsyncIterable<Job>) {
      yield job;
    }
  } finally {
    stream.cancel();
  }
}

export function isTerminal(job: Job): boolean {
  return job.state === JobState.JOB_STATE_SUCCEEDED || job.state === JobState.JOB_STATE_FAILED;
}
