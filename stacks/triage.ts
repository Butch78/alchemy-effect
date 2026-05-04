import * as Triage from "@alchemy.run/triage";
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Discord from "alchemy/Discord";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Logs, Traces } from "./otel/Datasets.ts";
import {
  TriageChannelWebhook,
  TriageDiscordApp,
} from "./triage/Bindings.ts";
import TriageWorker from "./triage/Worker.ts";

/**
 * Triage stack. Wires Axiom OTEL signals through Cloudflare Workers AI into
 * per-project Durable Objects, with Discord notifications on first detection.
 *
 * Storage architecture: every event is sharded into a per-project Durable
 * Object addressed by the `alchemy.git.root_commit` attribute set by the
 * alchemy CLI's telemetry layer. Each `ProjectDO` keeps the raw event log
 * forever, runs an alarm-driven AI summarizer to answer "what is this user
 * trying to build / what errors are they hitting", and owns its own issue
 * catalog. A single `IndexDO` mirrors a sortable cross-project list so the
 * Discord slash command and `/projects` / `/issues` endpoints don't have
 * to fan out.
 *
 * Configuration (`Config`):
 * - `DISCORD_BOT_TOKEN`         — bot token (consumed by `alchemy/Discord`)
 * - `DISCORD_APPLICATION_ID`    — bot's application id
 * - `DISCORD_CHANNEL_ID`        — channel for webhook posts
 * - `DISCORD_GUILD_ID` (opt.)   — register `/triage` in this guild only
 *
 * What it provisions:
 * - `TriageWorker`       — Cloudflare Worker hosting `ProjectDO` + `IndexDO`
 * - `TriageDiscordApp`   — imports the bot
 * - `TriageChannelWebhook` — channel webhook
 * - `Discord.SlashCommand` — `/triage [status]`
 * - `Axiom.Notifier`     — customWebhook pointing at the worker
 * - `Axiom.Monitor` x 2  — error stream (logs) + resource activity stream (traces)
 */
export default Alchemy.Stack(
  "AlchemyTriage",
  {
    providers: Layer.mergeAll(
      Axiom.providers(),
      Cloudflare.providers(),
      Discord.providers(),
    ),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const guildIdOpt = yield* Config.string("DISCORD_GUILD_ID").pipe(
      Config.option,
    );
    const guildId = guildIdOpt._tag === "Some" ? guildIdOpt.value : undefined;

    const triageWebhookSecret = yield* Config.string(
      "TRIAGE_WEBHOOK_SECRET",
    );

    const app = yield* TriageDiscordApp;
    const channelWebhook = yield* TriageChannelWebhook;

    yield* Discord.SlashCommand("TriageSlash", {
      applicationId: app.applicationId,
      guildId,
      name: "triage",
      description: "Show the highest-priority open triage issues",
      options: [
        {
          type: 3, // STRING
          name: "status",
          description: "Filter by status",
          required: false,
          choices: [
            { name: "open", value: "open" },
            { name: "triaging", value: "triaging" },
            { name: "reproduced", value: "reproduced" },
            { name: "fixing", value: "fixing" },
            { name: "closed", value: "closed" },
          ],
        },
      ],
    });

    const worker = yield* TriageWorker;
    const traces = yield* Traces;
    const logs = yield* Logs;

    const notifier = yield* Axiom.Notifier("TriageWorker", {
      name: "alchemy-triage-worker",
      properties: {
        customWebhook: {
          url: Output.interpolate`${worker.url}/webhooks/axiom`,
          body: "",
          headers: {
            Authorization: `Bearer ${triageWebhookSecret}`,
          },
        },
      },
    });

    // Errors stream — every ERROR/FATAL log gets classified and folded into
    // its project's ProjectDO. Project attribution flows through via the
    // `alchemy.git.root_commit` resource attribute set by the alchemy CLI's
    // telemetry layer (packages/alchemy/src/Telemetry/Attributes.ts).
    yield* Axiom.Monitor("ErrorRate", {
      name: "Error rate (logs)",
      description:
        "Fires for every log event with severity >= ERROR so the triage worker can classify it and attach it to its project.",
      type: "MatchEvent",
      aplQuery: Output.interpolate`
        ['${logs.name}']
        | where ['severity_text'] in ("ERROR", "FATAL")
        | project _time, message=['body'], severity=['severity_text'],
                  service=tostring(['resource.attributes']['service.name']),
                  errorType=tostring(['attributes']['exception.type']),
                  location=tostring(['attributes']['code.filepath']),
                  attributes=['attributes'],
                  projectId=tostring(['resource.attributes']['alchemy.git.root_commit']),
                  userId=tostring(['resource.attributes']['alchemy.user.id']),
                  ['alchemy.git.origin_hash']=tostring(['resource.attributes']['alchemy.git.origin_hash']),
                  ['alchemy.git.branch_hash']=tostring(['resource.attributes']['alchemy.git.branch_hash']),
                  ['alchemy.version']=tostring(['resource.attributes']['alchemy.version'])
      `,
      intervalMinutes: 1,
      rangeMinutes: 1,
      notifierIds: [notifier.id],
    });

    // Resource activity stream — every provider.* span (success or error)
    // ships to the worker so each ProjectDO can roll up "what is this user
    // building" without us doing a separate Axiom query at summary time.
    yield* Axiom.Monitor("ResourceActivity", {
      name: "Resource activity (traces)",
      description:
        "Fires for every provider.* lifecycle span so the triage worker can attribute resource usage to its owning project.",
      type: "MatchEvent",
      aplQuery: Output.interpolate`
        ['${traces.name}']
        | where name startswith "provider."
        | project _time, message=name,
                  resourceType=tostring(['attributes']['alchemy.resource.type']),
                  resourceOp=tostring(['attributes']['alchemy.resource.op']),
                  status=iif(tobool(['error']), "error", "success"),
                  service=tostring(['resource.attributes']['service.name']),
                  attributes=['attributes'],
                  projectId=tostring(['resource.attributes']['alchemy.git.root_commit']),
                  userId=tostring(['resource.attributes']['alchemy.user.id']),
                  ['alchemy.git.origin_hash']=tostring(['resource.attributes']['alchemy.git.origin_hash']),
                  ['alchemy.git.branch_hash']=tostring(['resource.attributes']['alchemy.git.branch_hash']),
                  ['alchemy.version']=tostring(['resource.attributes']['alchemy.version'])
      `,
      intervalMinutes: 1,
      rangeMinutes: 1,
      notifierIds: [notifier.id],
    });

    return {
      workerUrl: worker.url.as<string>(),
      discordWebhookUrl: channelWebhook.url,
    };
  }).pipe(Effect.orDie),
);
