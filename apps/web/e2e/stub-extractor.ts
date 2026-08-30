import { Server, ServerCredentials, type ServiceDefinition } from "@grpc/grpc-js";

import { ExtractorDefinition } from "@mise/schema/gen/extractor";

import { RECIPE, VIDEO_ID } from "./fixture";

/**
 * A gRPC extractor that serves one canned recipe.
 *
 * The recipe page loads over gRPC from the server, not over fetch from the
 * browser, so Playwright's request interception cannot reach it. Stubbing at
 * the transport instead means the specs still exercise the real path — the BFF,
 * the generated stubs, the zod parse in loadExtraction — with none of the
 * network.
 *
 * The serializer adapter mirrors the one in lib/extractor.ts, and for the same
 * reason: ts-proto is generated with `generic-definitions`, so it describes the
 * service without binding a transport, and grpc-js needs that description
 * translated into its own shape.
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
      requestSerialize: (value: unknown) => Buffer.from(method.requestType.encode(value).finish()),
      requestDeserialize: (bytes: Buffer) => method.requestType.decode(bytes),
      responseSerialize: (value: unknown) => Buffer.from(method.responseType.encode(value).finish()),
      responseDeserialize: (bytes: Buffer) => method.responseType.decode(bytes),
    };
  }
  return definition as ServiceDefinition;
}

type Handler = (call: { request: Record<string, string> }, cb: (e: unknown, r?: unknown) => void) => void;

export async function startStubExtractor(port: number): Promise<Server> {
  const server = new Server();

  const impl: Record<string, Handler> = {
    getRecipe: (call, cb) => {
      const found = call.request.videoId === VIDEO_ID;
      cb(null, { recipeJson: found ? JSON.stringify(RECIPE) : "", found });
    },
    health: (_call, cb) => cb(null, { status: "ok", service: "stub", version: "0.0.0" }),
  };

  server.addService(toServiceDefinition(), impl as never);

  await new Promise<void>((resolve, reject) => {
    server.bindAsync(`127.0.0.1:${port}`, ServerCredentials.createInsecure(), (err) =>
      err ? reject(err) : resolve(),
    );
  });
  return server;
}
