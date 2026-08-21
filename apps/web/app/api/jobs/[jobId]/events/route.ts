import { ExtractorError, isTerminal, streamStatus } from "@/lib/extractor";

/**
 * Bridges the extractor's gRPC status stream to SSE for the browser.
 *
 * The browser cannot speak gRPC without a proxy, and this is that proxy. It is
 * a thin one on purpose: no polling, no buffering, no reshaping — the server
 * already emits only on change, so every event here is a real transition.
 */
export const dynamic = "force-dynamic";
// Node, not edge: @grpc/grpc-js needs Node APIs.
export const runtime = "nodejs";

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  const { jobId } = await params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const job of streamStatus(jobId)) {
          controller.enqueue(encoder.encode(frame("status", job)));
          if (isTerminal(job)) break;
        }
      } catch (error) {
        const payload =
          error instanceof ExtractorError
            ? { error: error.code, detail: error.message }
            : { error: "internal_error", detail: "Status stream failed." };
        controller.enqueue(encoder.encode(frame("error", payload)));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Without this a proxy may buffer the whole stream and deliver it at the
      // end — which looks exactly like the spinner this replaced.
      "X-Accel-Buffering": "no",
    },
  });
}
