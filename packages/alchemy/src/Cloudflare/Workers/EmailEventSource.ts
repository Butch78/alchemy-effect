import type * as cf from "@cloudflare/workers-types";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Binding from "../../Binding.ts";
import type { ResourceLike } from "../../Resource.ts";
import { RuntimeContext } from "../../RuntimeContext.ts";
import type { FunctionContext } from "../../Serverless/Function.ts";
import { EmailRouting } from "../Email/EmailRouting.ts";
import { EmailRule, type EmailMatcher } from "../Email/EmailRule.ts";
import type { ZoneReference } from "../Zone/index.ts";
import { isWorker, isWorkerEvent } from "./Worker.ts";

/**
 * Effect-native wrapper around Cloudflare's
 * [`ForwardableEmailMessage`](https://developers.cloudflare.com/email-routing/email-workers/runtime-api/#forwardableemailmessage).
 *
 * Follows the same shape as the other Cloudflare bindings (R2, KV, …):
 *
 * - `raw` is the underlying `cf.ForwardableEmailMessage` — an escape
 *   hatch for any field or future API not yet wrapped.
 * - Ergonomic fields (`from`, `to`, `headers`, `body`, `bodySize`) are
 *   forwarded verbatim.
 * - Action methods (`forward`, `reply`, `setReject`) return `Effect`s
 *   instead of `Promise`/`void`.
 */
export interface ForwardableEmailMessage {
  /** Underlying Cloudflare message — escape hatch for unwrapped APIs. */
  readonly raw: cf.ForwardableEmailMessage;
  /** Envelope From address. */
  readonly from: string;
  /** Envelope To address. */
  readonly to: string;
  /** RFC 5322 headers. */
  readonly headers: cf.Headers;
  /** Raw message body stream (RFC 5322 wire bytes). */
  readonly body: cf.ReadableStream<Uint8Array>;
  /** Size of the raw message body in bytes. */
  readonly bodySize: number;
  /**
   * Reject this message back to the connecting client with a permanent
   * SMTP error and the given reason.
   */
  setReject(reason: string): Effect.Effect<void>;
  /**
   * Forward this message to a verified destination address on the
   * account. Fails with `EmailError` if Cloudflare rejects the forward
   * (e.g. unverified destination).
   */
  forward(
    rcptTo: string,
    headers?: cf.Headers,
  ): Effect.Effect<void, EmailError>;
  /**
   * Reply to the sender with a new outbound message. Fails with
   * `EmailError` if Cloudflare rejects the reply.
   */
  reply(message: cf.EmailMessage): Effect.Effect<void, EmailError>;
}

export class EmailError extends Data.TaggedError("EmailError")<{
  action: "forward" | "reply";
  message: string;
  cause: unknown;
}> {}

const wrap = (raw: cf.ForwardableEmailMessage): ForwardableEmailMessage => ({
  raw,
  from: raw.from,
  to: raw.to,
  headers: raw.headers,
  body: raw.raw,
  bodySize: raw.rawSize,
  setReject: (reason) => Effect.sync(() => raw.setReject(reason)),
  forward: (rcptTo, headers) =>
    Effect.tryPromise({
      try: () => raw.forward(rcptTo, headers),
      catch: (cause) =>
        new EmailError({
          action: "forward",
          message: `Cloudflare email forward failed: ${formatCause(cause)}`,
          cause,
        }),
    }),
  reply: (msg) =>
    Effect.tryPromise({
      try: () => raw.reply(msg),
      catch: (cause) =>
        new EmailError({
          action: "reply",
          message: `Cloudflare email reply failed: ${formatCause(cause)}`,
          cause,
        }),
    }),
});

const formatCause = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * Settings for {@link email} — both halves of the consumer in one
 * place. `zone` opts in to the deploy-time setup: an `EmailRouting`
 * toggle on the zone plus an `EmailRule` whose action routes matched
 * mail to the host Worker. Omit `zone` to manage routing yourself.
 */
export interface EmailSubscribeProps {
  /**
   * Zone to enable email routing on and attach the routing rule to.
   * Accepts a zone id, a zone name (`example.com`), or a
   * `{ zoneId, name? }` object. Required to auto-create routing
   * resources; omit if you're managing `EmailRouting` and `EmailRule`
   * yourself.
   */
  zone?: ZoneReference;
  /**
   * Matchers for the auto-created `EmailRule`. Ignored when `zone` is
   * omitted.
   *
   * @default [{ type: "all" }]
   */
  matchers?: EmailMatcher[];
  /**
   * Display name for the auto-created `EmailRule`.
   *
   * @default the host worker's logical id
   */
  ruleName?: string;
  /**
   * Priority of the auto-created `EmailRule`. Lower numbers run first.
   *
   * @default 0
   */
  priority?: number;
  /**
   * Whether the auto-created `EmailRule` is enabled.
   *
   * @default true
   */
  enabled?: boolean;
}

/**
 * Subscribe to Cloudflare Email Worker events with an Effect handler.
 *
 * Wires both halves of the consumer in one call:
 *
 * - **Runtime**: registers an `email` event listener on the Worker.
 *   The handler receives a {@link ForwardableEmailMessage} whose
 *   action methods (`forward`, `reply`, `setReject`) return `Effect`s.
 * - **Deploy-time** (when `zone` is set): yields a
 *   `Cloudflare.EmailRouting` toggle on the zone plus a
 *   `Cloudflare.EmailRule` whose `actions: [{ type: "worker", … }]`
 *   targets this Worker. No manual wiring needed in `alchemy.run.ts`.
 *
 * @binding Cloudflare.Workers.EmailEventSource
 *
 * @section Subscribing to Inbound Mail
 * @example Catch-all on a zone — auto-creates routing + rule
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 *
 * export default Cloudflare.Worker(
 *   "Inbox",
 *   { main: import.meta.path },
 *   Effect.gen(function* () {
 *     yield* Cloudflare.email({ zone: "example.com" }).subscribe(
 *       (message) => message.forward("ops@example.com"),
 *     );
 *     return {};
 *   }).pipe(Effect.provide(Cloudflare.EmailEventSourceLive)),
 * );
 * ```
 *
 * @example Match a specific address
 * ```typescript
 * yield* Cloudflare.email({
 *   zone: "example.com",
 *   matchers: [{ type: "literal", field: "to", value: "hello@example.com" }],
 * }).subscribe((message) => message.forward("ops@example.com"));
 * ```
 *
 * @example Reject (bounce) a message
 * ```typescript
 * yield* Cloudflare.email({ zone: "example.com" }).subscribe((message) =>
 *   message.setReject("Mailbox closed"),
 * );
 * ```
 *
 * @example Bring-your-own routing — no `zone`, no auto-create
 * ```typescript
 * // Manage `EmailRouting` / `EmailRule` yourself in alchemy.run.ts.
 * yield* Cloudflare.email().subscribe((message) =>
 *   Effect.log(`from ${message.from}`),
 * );
 * ```
 *
 * @see https://developers.cloudflare.com/email-routing/email-workers/
 */
export const email = (props: EmailSubscribeProps = {}) => ({
  subscribe: <E = never, Req = never>(
    process: (message: ForwardableEmailMessage) => Effect.Effect<void, E, Req>,
  ) => EmailEventSource.use((source) => source(props, process)),
});

export type EmailEventSourceService = <E = never, Req = never>(
  props: EmailSubscribeProps,
  process: (message: ForwardableEmailMessage) => Effect.Effect<void, E, Req>,
) => Effect.Effect<void, never, never>;

export class EmailEventSource extends Context.Service<
  EmailEventSource,
  EmailEventSourceService
>()("Cloudflare.Workers.EmailEventSource") {}

/**
 * Deploy-time policy that yields `Cloudflare.EmailRouting` and
 * `Cloudflare.EmailRule` resources pointing the configured zone at
 * the host Worker. Provided in `Cloudflare.providers()` and consumed
 * by {@link EmailEventSourceLive} via `yield* EmailEventSourcePolicy(...)`.
 * At runtime the policy is absent, so the call is a no-op.
 */
export class EmailEventSourcePolicy extends Binding.Policy<
  EmailEventSourcePolicy,
  (props: EmailSubscribeProps) => Effect.Effect<void>
>()("Cloudflare.Workers.EmailEventSource") {}

export const EmailEventSourcePolicyLive = EmailEventSourcePolicy.layer.succeed(
  // See `QueueEventSourcePolicyLive` for the rationale on the cast:
  // yielding sibling Resources requires the Cloudflare `Providers`
  // services, which the deploy-time stack provides; `layer.succeed`
  // types the body too narrowly for that.
  ((host: ResourceLike, props: EmailSubscribeProps) =>
    Effect.gen(function* () {
      if (!isWorker(host)) {
        return yield* Effect.die(
          `Cloudflare.email(...).subscribe(...) is only supported on ` +
            `Cloudflare.Worker hosts (got '${host.Type}').`,
        );
      }
      // Bring-your-own routing: skip auto-create if zone is omitted.
      if (!props.zone) return;

      yield* EmailRouting(`${host.LogicalId}EmailRouting`, {
        zone: props.zone,
        enabled: true,
      });
      yield* EmailRule(`${host.LogicalId}EmailRule`, {
        zone: props.zone,
        name: props.ruleName ?? host.LogicalId,
        enabled: props.enabled ?? true,
        priority: props.priority ?? 0,
        matchers: props.matchers ?? [{ type: "all" }],
        actions: [{ type: "worker", value: [host.workerName] }],
      });
    })) as unknown as (
    host: ResourceLike,
    props: EmailSubscribeProps,
  ) => Effect.Effect<void>,
);

export const EmailEventSourceLive = Layer.effect(
  EmailEventSource,
  Effect.gen(function* () {
    const policy = yield* EmailEventSourcePolicy;
    return Effect.fn(function* <E, Req>(
      props: EmailSubscribeProps,
      process: (
        message: ForwardableEmailMessage,
      ) => Effect.Effect<void, E, Req>,
    ) {
      // Deploy-time: ensure EmailRouting + EmailRule exist. At runtime
      // the policy resolves to a no-op variant via `Effect.serviceOption`.
      yield* policy(props);

      const ctx = (yield* RuntimeContext) as unknown as FunctionContext;
      yield* ctx.listen<void, Req>((event) => {
        if (!isWorkerEvent(event) || event.type !== "email") return;

        const message = wrap(event.input as cf.ForwardableEmailMessage);
        return process(message).pipe(Effect.catchCause(() => Effect.void));
      });
    }) as EmailEventSourceService;
  }),
);
