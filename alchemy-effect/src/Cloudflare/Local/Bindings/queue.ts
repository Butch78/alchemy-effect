import type * as cf from "@cloudflare/workers-types";
import * as Effect from "effect/Effect";

// ---------------------------------------------------------------------------
// Client-side sender facade (runs locally)
// ---------------------------------------------------------------------------

export interface QueueFacade<Body = unknown> {
  send(
    message: Body,
    options?: { contentType?: string; delaySeconds?: number },
  ): Promise<void>;
  sendBatch(
    messages: Array<{
      body: Body;
      contentType?: string;
      delaySeconds?: number;
    }>,
    options?: { delaySeconds?: number },
  ): Promise<void>;
}

async function throwIfNotOk(response: Response): Promise<void> {
  if (response.ok) {
    return;
  }
  const body = await response.text().catch(() => "");
  throw new Error(
    `Queue request failed: ${response.status} ${response.statusText}${body ? ` - ${body}` : ""}`,
  );
}

export function makeQueueFacade<Body = unknown>(
  workerUrl: string,
  queue: string,
): QueueFacade<Body> {
  return {
    async send(message, options) {
      const response = await fetch(`${workerUrl}/queue/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queue,
          body: message,
          contentType: options?.contentType,
          delaySeconds: options?.delaySeconds,
        }),
      });
      await throwIfNotOk(response);
    },
    async sendBatch(messages, options) {
      const response = await fetch(`${workerUrl}/queue/send-batch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          queue,
          messages: messages.map((m) => ({
            body: m.body,
            contentType: m.contentType,
            delaySeconds: m.delaySeconds,
          })),
          delaySeconds: options?.delaySeconds,
        }),
      });
      await throwIfNotOk(response);
    },
  };
}

// ---------------------------------------------------------------------------
// Client-side consumer (runs locally) -- receiving
// ---------------------------------------------------------------------------

export interface QueueMessage<Body = unknown> {
  readonly id: string;
  readonly body: Body;
  readonly timestamp: Date;
  readonly attempts: number;
  ack(): Promise<void>;
  retry(options?: { delaySeconds?: number }): Promise<void>;
}

export interface QueueBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: ReadonlyArray<QueueMessage<Body>>;
  ackAll(): Promise<void>;
  retryAll(options?: { delaySeconds?: number }): Promise<void>;
}

export interface QueueBatchDecision {
  readonly ackedIds: ReadonlyArray<string>;
  readonly retriedIds: ReadonlyArray<{
    readonly id: string;
    readonly delaySeconds?: number;
  }>;
  readonly ackAll: boolean;
  readonly retryAll: boolean;
  readonly retryAllDelay?: number;
}

export type QueueHandler<Body = unknown> = (
  batch: QueueBatch<Body>,
) => void | Promise<void>;

/**
 * Creates a `localQueueBatch` handler for LocalRpcs.toLayer.
 * The handler returns a batch decision instead of sending follow-up RPCs back
 * to the Durable Object, avoiding a re-entrant RPC deadlock.
 */
export const makeQueueConsumer = <Body = unknown>(
  handler: QueueHandler<Body>,
) => ({
  localQueueBatch: ({
    queue,
    messages,
  }: {
    queue: string;
    messages: ReadonlyArray<{
      readonly id: string;
      readonly body: unknown;
      readonly timestamp: string;
      readonly attempts: number;
    }>;
  }) =>
    Effect.promise(async () => {
      const decision: {
        ackedIds: string[];
        retriedIds: Array<{ id: string; delaySeconds?: number }>;
        ackAll: boolean;
        retryAll: boolean;
        retryAllDelay?: number;
      } = {
        ackedIds: [],
        retriedIds: [],
        ackAll: false,
        retryAll: false,
      };
      const batch: QueueBatch<Body> = {
        queue,
        messages: messages.map((m) => ({
          id: m.id,
          body: m.body as Body,
          timestamp: new Date(m.timestamp),
          attempts: m.attempts,
          ack: async () => {
            decision.ackedIds.push(m.id);
          },
          retry: async (opts?: { delaySeconds?: number }) => {
            decision.retriedIds.push({
              id: m.id,
              delaySeconds: opts?.delaySeconds,
            });
          },
        })),
        ackAll: async () => {
          decision.ackAll = true;
        },
        retryAll: async (opts?: { delaySeconds?: number }) => {
          decision.retryAll = true;
          decision.retryAllDelay = opts?.delaySeconds;
        },
      };
      await handler(batch);
      return decision satisfies QueueBatchDecision;
    }),
});

// ---------------------------------------------------------------------------
// Queue sender client factory
// ---------------------------------------------------------------------------

export const makeQueueClient = (workerUrl: string) =>
  Effect.succeed({
    queue: <Body = unknown>(queueName: string) =>
      makeQueueFacade<Body>(workerUrl, queueName),
  });
