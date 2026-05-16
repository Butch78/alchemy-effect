---
title: Infrastructure-as-Code, Infrastructure-as-Effects, Agents-as-Effects
date: 2026-05-16
draft: true
excerpt: Three floors stacked, each one load-bearing for the next. The "as Effects" thread is what merges them — one declarative, type-safe program that holds the cloud, the runtime that uses it, and the agents that live inside it.
---

Picture the whole thing in one place.

Every cloud resource your product runs on.
Every line of runtime code that touches
those resources. Every agent that lives
inside the product and helps shape it.
Not three repositories with a wiki holding
them together. Not a Terraform module here,
a Worker over there, an agent configured
in some console.

**One source tree. One type checker.
One reconciler. One deploy.**

That picture is the destination. Alchemy
is how we are trying to get there. We are
trying to get there by stacking three
floors on top of each other:

1. **Infrastructure-as-Code** — declare
   what the cloud should look like; let
   an engine converge it.
2. **Infrastructure-as-Effects** — fuse
   the cloud and the runtime that uses it
   into one typed program.
3. **Agents-as-Effects** — put the agents
   inside that program too, and let them
   modify the system the only safe way:
   by editing the code.

Each floor is load-bearing for the next.
None of them would be enough on its own.
And the part of each name that does the
real work — the part that lets them stack
at all — is the two words at the end.

*As Effects.*

## What "as Effects" means

Effect is a way of writing code where every
computation is a value. Each value is typed.
Each value carries its dependencies in its
type. Each value carries its errors in its
type. Two values compose by yielding one
inside the other, and the result is itself
a value of the same shape. Nothing leaks
out the side. Nothing escapes the type
system.

Once you start writing this way, the
boundaries between things you used to think
of as different stop existing. A bucket is
a value. A handler that reads from the
bucket is a value. The IAM policy that
makes the read possible is a value. The
agent that helps shape the system is a
value. They all live in the same tree.
They speak the same language. They are
checked by the same compiler. They are
deployed by the same command.

This is the unification that makes the
three floors stack. Not a marketing word
for the layers — *the actual common
substrate.* The cloud is Effects. The
runtime is Effects. The agents are
Effects. The program you write is the
graph that ties them together, and the
graph is the source of truth from the
console at the bottom of your stack to
the LLM call at the top.

That is the claim. The rest of this post
is what it buys you, one floor at a time.

## Floor one — Infrastructure-as-Code

There was a time before IaC. You logged
into a cloud console and clicked. You
made a bucket, scribbled its name on a
sticky note, pasted some code into a
Lambda textarea, typed the bucket's name
into an environment variable, and hoped
to remember which was which. Two months
later something broke, and the answer to
"what is actually deployed in production"
lived in someone's head.

IaC was the response. You write down what
you want the cloud to look like. A tool
converges the cloud to match. The source
of truth lives in your repository. Diffs
are reviewable. Rollbacks are real. The
cloud stops being folklore.

This was a real shift, and it is the
floor everything else stands on. **The
author no longer manages state. They
declare it. The engine reconciles.** Hold
on to that sentence; it is the entire
product, said in seven words. It is going
to get repeated.

But there is still a seam, and the seam
is the whole reason we kept building.

The infrastructure lives in one tool, in
one language. The runtime — the Lambda,
the Worker, the handler — lives in
another. The two sides talk through ARNs
smuggled in environment variables and
IAM policies typed by hand. You rename a
resource on the infra side; the handler
on the runtime side hardcodes the old
name; nothing catches the mismatch until
production does. The bridge is brittle
because the type checker on either side
cannot see across it.

Two worlds. One narrow plank between them.

## Floor two — Infrastructure-as-Effects

Now imagine the plank isn't there.

The bucket isn't declared on one side and
consumed on the other. The bucket is a
value in a TypeScript program. The Worker
that uses the bucket is another value in
the same program. A single line —
`yield* bucket.bind(...)` — wires the IAM
policy at deploy time and hands the runtime
a typed client. Rename the bucket and the
handler breaks at compile time, not at
3 a.m. Add a method the policy doesn't
cover and the compiler will tell you,
before you ever ship.

The reason this works is that the bucket,
the policy, the binding, and the handler
are *all Effects*. Effects compose. Effects
carry their dependencies up the call tree.
Effects carry their errors in the type
system. So the program that *describes*
the cloud and the program that *runs on*
the cloud become the same program, written
in the same language, checked by the same
compiler, deployed by the same command.

The two worlds don't get bridged. They
collapse. There is no bridge anymore
because there is nothing on either side
of it.

This is what we shipped. We have spent
the better part of a year making the
abstractions earn their keep —
[bindings](/blog/2026-04-30-bindings),
[reconcilers](/blog/2026-05-04-reconcile),
[circular references](/blog/2026-04-25-circular-references),
[actions](/blog/2026-05-13-actions) —
and every one of those pieces exists for
the same reason: to keep the promise that
your cloud and your code are one program.

The author's life gets simpler again.
They don't write IaC and runtime
separately and keep them in sync. They
write one thing. One file, or one tree
of files, with the cloud and the code
that runs on it sitting side by side as
peers — values of the same kind, composed
the same way, type-checked together.

And the same sentence as before still
holds, just bigger this time. The author
no longer manages state. They declare
it — the cloud, *and* the runtime that
uses it. The engine reconciles.

That is floor two. On top of it, something
becomes possible that wouldn't have been
safe on either of the first two alone.

## Floor three — Agents-as-Effects

Once everything is one program of Effects,
the agents can move in.

An agent in this picture is not a service
living outside your infrastructure that
has to be configured to know about it. It
is a node in the same graph as the bucket
and the Worker. Its prompt is not a free
string in a config file you keep in sync
by hand — it is a value, with the same
typed references to resources that the
Worker uses. Its tools are not a separate
registry — they are bindings, the exact
same shape as `S3.GetObject.bind(bucket)`.
Its dependencies bubble up the `Req`
channel the same way every other Effect's
do. Remove the resource the agent depends
on and the agent's type breaks. Provide
it and the deploy goes through.

There is no new framework here. There is
no agent runtime separate from the
application runtime. There is no schema
that has to be kept in sync with the
infrastructure. The agent is an Effect.
The bucket is an Effect. The binding
between them is an Effect. The graph that
holds them is a TypeScript program.

Stack. Worker. Agent. **One program.**
One type checker. One reconciler.
One deploy.

This is the architectural payoff of the
floors stacking. But it is not yet the
real prize. The real prize is what
happens when you take the IaC principle
seriously — the one we keep repeating —
and let it climb all the way to the top.

## The pattern, applied to the agent

When agents are bolted onto an imperative
tool surface — `create_table`, `update_dns`,
`delete_worker`, `restart_service` — they
have to manage state. They hold a mental
model of what is deployed. They issue
calls to change it. They watch for
errors. They retry. They poll. They
drift. They guess. Every imperative tool
you give them is a new way for their
picture of the world to be wrong.

We already solved that problem. Not for
the agent — for the human. **The human
no longer manages state. They declare it.
The engine reconciles.** It is the only
sentence the framework has ever really
said.

So we say it again. **The agent no
longer manages state. It declares it.
The engine reconciles.**

The agent has exactly one tool that
touches the system: *edit the code.*
Open the file. Change the value. Run the
type checker. Run the tests. Open a pull
request. If everything passes, the deploy
goes out, the cloud converges, the
runtime updates, the agent's own prompt —
if it referenced a renamed resource —
comes back type-safe in the next plan.

The agent did not call infrastructure
APIs. It did not keep a picture of what's
deployed. It did not race with itself or
with another agent. It edited a file in
a git repository, the same way a human
teammate would, and the same machinery
that handles the human's change handles
the agent's. Type checks. Tests. Preview
environment. Review. Merge. Deploy.

This is what we mean by **stateless from
the author's perspective**. Neither the
human nor the agent ever has to know what
is actually deployed. They write code.
The source is the desired state.
Everything else is the engine's problem.

The same property that made IaC worth
building in the first place now extends
all the way up the stack — through the
runtime, through the agents, into the
organization the agents are members of.

## What it looks like

A repository. One file at the top. Inside
it, a chat-shaped service: channels,
members, message history, an HTTP and
WebSocket front door. Sitting next to it
in the same program, a handful of
agents — each one a node in the graph,
each one with a typed prompt that
references the resources it uses, each
one with a typed toolkit of bindings.

Among them, the first one we deploy: a
coding agent, whose prompt references the
repository itself.

You talk to the coding agent in a
channel. You say, "add a moderation
agent that watches `#general` and flags
PII." The agent opens a pull request. CI
runs the type checker. CI runs the tests.
CI deploys a preview to a fresh stage. A
link appears back in the channel. You
click it. You are talking to the
proposed moderation agent in a parallel
universe of the service. You verify it
does what you wanted. You merge.
Production deploys. The channel has a
new member.

No one ran a script. No one updated a
wiki. No one logged into a console. The
change went through the same path every
other change goes through — code, review,
type checks, tests, preview, merge — and
the cloud quietly converged at the end
of it.

The system has rearranged itself, and
every step of the rearrangement is in
the git history.

## Why each floor needs the others

You could not build this on plain
Terraform. The infrastructure would be
there but the runtime would not. The
agent's prompt would reference resources
the type checker couldn't see. The seam
that broke things for humans would break
them faster for agents.

You could not build it on plain Effect.
The composition story would be there but
the cloud-converging engine would not.
The agent's "edit the code" workflow
would terminate at a commit that doesn't
deploy itself.

You need both, in that order. A reconciler
underneath, so neither human nor agent
ever has to manage state. A graph of
Effects above it, so the agent's prompts
and tools and runtime are first-class
nodes in the same program as the cloud.
Each floor exists to make the next one
possible.

## The vision, said straight

An organization is not the boxes on the
org chart. It is the work the people do
and the systems they do it on. Most
software companies describe pieces of
that — the infrastructure in one place,
the application in another, the
processes in a wiki, the agents in some
third-party console — and the rest is
held together by tradition and Slack
threads.

We think the whole thing can live in one
program.

Type-checked. Declarative. Versioned.
The cloud the company runs on. The code
that runs in that cloud. The agents that
work alongside the humans inside that
code. All of it visible in one source
tree, reasoned about by one type checker,
deployed by one reconciler, modified by
one workflow: write code, run tests,
ship.

Effects all the way down — from the
console at the bottom of the stack to
the LLM call at the top.

The first two floors are built. The
third is going up. The first thing we
are putting on it is a chat-shaped
service whose first member is a coding
agent pointed at the repository that
describes it.

From there, the system writes itself.
