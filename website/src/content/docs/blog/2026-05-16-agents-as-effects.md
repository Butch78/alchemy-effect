---
title: Infrastructure-as-Code, Infrastructure-as-Effects, Agents-as-Effects
date: 2026-05-16
draft: true
excerpt: Three floors stacked, each one load-bearing for the next. From the cloud resource to the runtime to the agent that lives inside it — one Effect program, type-safe, declarative, controlled end-to-end by versioned code.
---

Picture the whole thing in one place.

Every cloud resource your product runs on.
Every line of runtime code that touches
those resources. Every agent that lives
inside the product and helps shape it.
Not three repositories with a wiki holding
them together. Not a Terraform module here,
a Worker over there, an agent configured
in some console. **One source tree. One
type checker. One reconciler. One deploy.**

That picture is the destination. Alchemy is
how we are trying to get there, and we are
trying to get there by stacking three
floors on top of each other:

- **Infrastructure-as-Code** — declare what
  the cloud should look like; let an engine
  converge it.
- **Infrastructure-as-Effects** — fuse the
  cloud and the runtime that uses it into
  one typed program.
- **Agents-as-Effects** — put the agents
  inside that program too, and let them
  modify the system the only safe way:
  by editing the code.

Each floor is load-bearing for the next.
None of them would be enough on their own.
This post is the story of those floors,
and the building they make once they're
all up.

## The first floor — Infrastructure-as-Code

There was a time before IaC. You logged
into a cloud console and you clicked. You
made a bucket. You wrote down its name on
a sticky note. You created a Lambda by
pasting some code into a textarea. You
typed the bucket's name into an environment
variable. You hoped you remembered which
one was which. Two months later something
broke, and "what is actually deployed in
production" was a question only the senior
engineer who had been there since the
beginning could answer.

IaC was the response. You write down what
you want the cloud to look like. A tool
converges the cloud to match. The source
of truth lives in your repository instead
of in someone's head. Diffs are reviewable.
Rollbacks are real. The cloud stops being
folklore.

This was a real shift, and it is the floor
everything else stands on. The author no
longer manages state imperatively — no more
"create the bucket, then the role, then
attach the policy, then update the env
var." They declare the desired state, and
the engine reconciles. State management is
the engine's job. The author's job is to
say what should exist.

But there is still a seam, and the seam is
the whole story of why we kept building.

The seam is this. The infrastructure lives
in one language. The runtime lives in
another. Two worlds joined by ARNs smuggled
through environment variables and IAM
policies typed by hand. You rename a
resource on the infra side and the handler
on the runtime side hardcodes the old name
and your test suite has no idea. The
bridge is brittle because the type checker
on either side cannot see across it.

## The second floor — Infrastructure-as-Effects

Now imagine the seam isn't there.

The bucket isn't a resource declared in
Terraform and consumed in TypeScript. The
bucket is a value in a TypeScript program.
The Worker that uses the bucket is another
value in the same program. A single line —
`yield* bucket.bind(...)` — wires the IAM
policy at deploy time and hands the runtime
a typed client. Rename the bucket and the
handler breaks at compile time, not in
production. Add a method call the policy
doesn't cover and the compiler will tell
you, before you ever deploy.

This is what we shipped as Alchemy.

We call it Infrastructure-as-Effects because
every node — the bucket, the policy, the
Worker, the handler that runs inside it —
is an Effect. Effects compose. Effects
carry typed errors. Effects aggregate
dependencies up the call tree. So the
program that *describes* the cloud and the
program that *runs on* the cloud become
the same program, written in the same
language, checked by the same type
checker, deployed by the same command.

Two worlds collapse into one. The bridge
disappears, because there is nothing left
on either side of it.

The author's life gets simpler again. They
don't write IaC and runtime separately and
keep them in sync. They write one thing. A
declaration is a value, a runtime call is
a value, a binding between them is a
value, and the whole thing is reasoned
about end to end by one program.

We've spent the last year-ish making this
real. [Bindings.](/blog/2026-04-30-bindings)
[Reconcilers.](/blog/2026-05-04-reconcile)
[Circular references.](/blog/2026-04-25-circular-references)
[Actions.](/blog/2026-05-13-actions) Every
piece in service of the same simple
principle: one program for everything that
runs in the cloud.

That principle is the second floor. And on
top of it, you can finally put something
that wouldn't have been safe to put on
either of the first two alone.

## The third floor — Agents-as-Effects

Once everything is one program, the agents
can move in too.

An agent in this picture is not a service
living outside your infrastructure that
has to be configured to know about it. It
is a node in the same graph as the bucket
and the Worker, sitting alongside them.
Its prompt is not a string in a config
file you keep in sync by hand; it is a
value, with the same typed references to
resources that the Worker uses. Its tools
are not a separate registry to maintain;
they are bindings, exactly the same shape
as the bindings your handlers already use.
Its dependencies bubble up the same `Req`
channel that everything else's does.
Remove the resource the agent depends on
and the agent's type breaks. Provide the
resource and the deploy goes through.

Stack. Worker. Agent. One program. One
type checker. One reconciler. One deploy.

That is the architectural picture. And it
is already, on its own, a thing worth
having. But the reason we are excited
about this floor — the reason we built the
first two — is what becomes possible once
the agents are *inside* the program rather
than outside it.

## The move that ties it together

Here is the part that turns the three
floors into a building.

When agents are bolted onto an imperative
tool surface — `create_table`, `update_dns`,
`delete_worker`, `restart_service` — they
have to manage state. They hold a mental
picture of what is deployed. They issue
calls to change it. They watch for errors.
They retry. They poll. They drift. They
guess. Every imperative tool you give them
is a new way for their picture of the
world to be wrong.

We already solved that problem for the
human. The human doesn't call CRUD APIs
in the right order. The human declares
the desired state and the engine
converges to it. **Source code is the
truth. State management is the engine's
responsibility, not the author's.**

So we do exactly the same thing for the
agent.

The agent has one tool that touches the
system: **edit the code.** Open the file.
Change the value. Run the type checker.
Run the tests. Open a pull request. If
everything passes, the deploy goes out,
the cloud converges, the runtime updates,
the agent's own prompt — if it referenced
a renamed resource — comes back type-safe.

The agent did not manage state. It did
not call infrastructure APIs. It did not
keep a picture of what's deployed. It
modified a file in a git repository the
same way a human teammate would, and the
same machinery that handles the human's
change handles the agent's. Type checks.
Tests. Preview environment. Review.
Merge. Deploy.

This is what we mean by **stateless from
the author's perspective**. Neither the
human nor the agent ever has to know what
is actually deployed. They write code.
The engine reconciles. The source is the
desired state. Everything else is the
engine's problem.

The same property that made IaC worth
building in the first place — *the author
declares; the engine reconciles* — now
extends all the way up the stack. To the
runtime. To the agents. To the
organization the agents are members of.

## What the building looks like

So what does an organization look like
when it's described this way?

A repository. One file at the top. Inside
it: a chat-shaped service — channels,
members, messages, an HTTP and WebSocket
front door. Sitting alongside it in the
same program: a handful of agents, each
one a node in the graph, each one with a
typed prompt that references the resources
it uses and a typed toolkit of bindings.
Among them, the first one we deploy: a
coding agent, whose prompt references the
repository itself.

You talk to the coding agent in a channel.
You say, "add a moderation agent that
watches `#general`." The agent opens a
pull request. CI runs the type checker.
CI runs the tests. CI deploys a preview
to a fresh stage. A link appears back in
the channel. You click the link and you
are talking to the proposed moderation
agent in a parallel universe of the
service. You verify it does what you
wanted. You merge. Production deploys.
The channel now has a new member.

No one ran a script. No one updated a
wiki. No one logged into a console. The
change went through the same path every
other change goes through — code, review,
type-checks, tests, preview, merge — and
the cloud quietly converged at the end of
it.

The system has rearranged itself, and
every step of the rearrangement is in the
git history.

## Why all three floors are needed

You could not build this on plain
Terraform. The infrastructure would be
there but the runtime would not, and the
agent's prompt would reference resources
that the type checker couldn't see, and
the seam between infra and runtime that
broke things for humans would break them
for agents too — only faster.

You could not build it on plain Effect
either. The composition story would be
there but the cloud-converging engine
would not, and the agent's "edit the
code" workflow would terminate at a
commit that doesn't actually deploy
itself.

You need both. A reconciler underneath,
so neither human nor agent ever has to
manage state. A single typed program
above, so the agent's prompts and tools
and runtime live in the same graph as
the cloud they touch. The floors have to
stack, in that order, each one strictly
above the last.

That stack is what Alchemy is.

## What we mean by an organization in one program

An organization is not the boxes on the
org chart. It is the work the people do
and the systems they do it on. Most
software companies today describe pieces
of that — the infrastructure in one
place, the application in another, the
processes in a wiki, the agents in some
third-party tool — and the rest is held
together by tradition and Slack threads.

We think it can all live in one program.
Type-checked. Declarative. Versioned.
The cloud the company runs on, the code
that runs in that cloud, and the agents
that work alongside the humans inside
that code — all of it in a source tree
you can clone, read, and reason about
end to end.

That is the announcement. The first two
floors are built. The third is going up.
The first thing we are putting on it is
a chat-shaped service whose first member
is a coding agent pointed at the repo
that describes it.

From there, the system writes itself.
