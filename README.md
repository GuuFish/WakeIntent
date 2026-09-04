# WakeIntent

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/GuuFish/WakeIntent/actions/workflows/ci.yml/badge.svg)](https://github.com/GuuFish/WakeIntent/actions/workflows/ci.yml)

> **Developer component — not an end-user app.** This repository is for
> developers who want to embed proactive contact decisions into an AI product.
> Cloning it gives you an engine, adapters, examples, and evaluation tools; it
> does not launch a chat UI, run a background assistant, or send notifications.

WakeIntent is a framework-agnostic contact-intent engine for conversational AI.
It turns a conversational reason to follow up later into a durable `ContactIntent`,
then revalidates that reason against newer context before deciding to contact,
defer, cancel, expire, resolve, or stay silent.

> **Status: research Alpha 0.1.** The core engine, local persistence, model
> adapter, audit trail, and evaluation tooling run today. WakeIntent is not yet a
> production notification service or a finished chat application.

## Vision

Most conversational AI still lives inside a request-response loop: it speaks
when called and disappears when the user stops typing. WakeIntent's long-term
goal is to provide the missing continuity layer—not by making a model think in
an expensive endless loop, but by letting an assistant preserve a concrete
reason to reconnect, sleep without polling, and wake only when time or relevant
new context makes that reason worth reconsidering.

If the project succeeds, an assistant, companion, tutor, recruiter, support
agent, or other user-authorized AI product could share the same small protocol:
create a contact intent during normal conversation; revise or invalidate it as
life changes; revalidate it against current context, policy, relationship, and
persona; then contact through the host's chosen channel—or deliberately remain
silent. Different characters may be reserved, warm, or talkative, but none
should bypass consent, interruption budgets, or explainability.

The ambition is therefore larger than a reminder feature and smaller than a
general autonomous-agent framework: make thoughtful, accountable continuity a
reusable piece of AI infrastructure. This is a direction, not a claim that the
Alpha has already achieved it.

## Why this exists

A fixed heartbeat can periodically ask a model whether it should message a
user, but it still wakes without a specific reason. A normal reminder knows
when to fire, but usually does not know whether the reason has become obsolete.

WakeIntent separates those concerns:

1. Normal conversation may create a future contact reason.
2. The reason is stored with evidence, timing, cancellation hints, priority,
   interruption cost, and lifecycle state.
3. Relevant new conversation events can wake only the affected intent.
4. At evaluation time, deterministic safety gates and the latest context decide
   whether to contact or remain silent.

The scheduler is deliberately boring: it only wakes the engine at the nearest
`nextEvaluationAt`. It does not decide whether a message deserves to exist.

## Example scenarios

```text
1. The outcome arrived early

Day 1  User: "The company said I should hear back by Friday."
       -> create an intent to check in after the result window

Day 3  User: "I got the offer! No need to ask about it later."
       -> resolve the intent immediately and clear its future wakeup

Friday -> no redundant check-in
```

```text
2. The reason remains, but the timing changes

Day 1  User: "My driving test is Saturday morning."
       -> create a possible post-test follow-up

Day 2  User: "It was moved to next Tuesday; please don't ask before then."
       -> keep the reason, defer the evaluation window

Saturday -> stay silent
Tuesday   -> revalidate against the latest context before contacting
```

```text
3. The original reason becomes invalid

Day 1  User: "I may move to Shanghai next month."
       -> create a low-priority intent to revisit the decision later

Day 8  User: "The move is cancelled. I am staying here."
       -> cancel the intent and remove its schedule

Next month -> no stale question about the move
```

```text
4. There is no future contact reason

User: "Lunch was pretty good today."
      -> create no ContactIntent, schedule nothing, spend no future tokens
```

The important behavior is not merely sending messages. It is preserving a
specific reason across time, revising it when circumstances change, and doing
nothing when contact is no longer justified.

## What works now

- framework-independent TypeScript domain model and lifecycle;
- candidate extraction and latest-context semantic reevaluation;
- separate validity and contact-eligibility gates;
- relevance routing for conversation-triggered reevaluation;
- authorization, do-not-disturb, expiry, late-wakeup, and contact-budget policy;
- idempotent decisions, optimistic revisions, failure backoff, and audit events;
- recoverable local JSON storage with snapshot migrations;
- a local HTTP reference host with durable conversation ingestion, optional
  model processing, and a receipt-aware outbox;
- OpenAI-compatible Responses and Chat Completions adapter;
- deterministic test clock, evaluation datasets, baselines, and token telemetry.

## Quick start

Requirements: Node.js 22.14 or newer and pnpm 11.19.

Check your tools first:

```bash
node --version
pnpm --version
```

If `pnpm` is missing, install the version pinned by this repository and verify
it. This command works in PowerShell, Command Prompt, and common Unix shells:

```bash
npm install --global pnpm@11.19.0
pnpm --version
```

Then install and verify the repository:

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` builds and type-checks every workspace package and app, then runs
their tests. At the independently verified commit `53d5e49`, the summary was
178 passing tests across five packages and 22 test files. The exact count grows
as the project changes.

Now run the local Alpha demo twice with the same state file:

```bash
pnpm demo:alpha -- .wakeintent/my-alpha-demo.json
pnpm demo:alpha -- .wakeintent/my-alpha-demo.json
```

The Alpha demo is fully local. It uses a deterministic fake semantic model,
persists state, simulates a restart, cancels an invalidated job-fair follow-up,
and silences an excessively late low-value check-in. It does not need an API
key and does not spend tokens.

On the first run, expect two `created` registrations, `dueCount: 2`, one
`cancel` decision, one `silent` decision, and `contactDecisions: 0`. On the
second run, expect two `duplicate` registrations, `dueCount: 0`,
`semanticModelCalls: 0`, no new decisions, and an unchanged audit count.

### Decision, lifecycle, and schedule are different

The demo's late low-value intent deliberately ends with `action: "silent"`,
`status: "active"`, and `nextEvaluationAt: null`:

- `silent` is the result of this evaluation: do not contact now;
- `active` means the reason was not declared resolved, cancelled, or expired;
- `nextEvaluationAt: null` means there is no pending time-based wakeup.

This is a dormant, non-terminal intent. It will not wake again merely because
of its old schedule, but a later relevant conversation event or an explicit
host request may schedule another evaluation. Terminal actions are `cancel`,
`resolve`, and `expire`.

`contact` is also only a decision. WakeIntent does not generate or send a
message in this flow; the host application owns generation, delivery, receipts,
and any user-facing error handling.

## Runnable reference host

The offline reference host shows how a product consumes WakeIntent decisions:

```bash
pnpm demo:host
```

It runs three synthetic recruitment follow-ups: one valid contact, one result
resolved before contact, and one case without known authorization. Only the
valid, authorized decision enters the host outbox; the other two create no
message work. The outbox item is explicitly `delivered: false` because message
generation and delivery remain host responsibilities. This demo uses no API and
no real user data.

For a persistent local HTTP integration boundary, start the Alpha reference
host:

```bash
pnpm host:start
```

It binds to `127.0.0.1:8787` by default and exposes structured intent,
evaluation, state, outbox, and delivery-receipt endpoints. This default mode
makes no model calls. Its purpose is to make the core's host contract runnable
and to recover the crash window between a committed `contact` decision and
outbox enqueue.

To opt into natural-language event ingestion with the configured model:

```bash
cp .env.example .env
pnpm host:start:model
```

That mode can persist conversation events, extract new intents, route relevant
updates to existing intents, and reevaluate due work from stored context. A
completed idempotent event replay performs no model work; an interrupted batch
reuses its persisted processing plan. The host still does not generate or send
messages. See the [reference host API guide](docs/22-reference-host-api.md) and
[conversation ingestion design](docs/23-conversation-ingestion.md).

## Try a real model

This section is opt-in and spends tokens. `pnpm demo:api` makes at most two
model requests: candidate extraction, followed by latest-context reevaluation
when an active intent was extracted. It can stop after the first request when
no active intent exists. Token usage and price depend on the configured model
and provider.

Copy the safe template and edit the local `.env` file:

```bash
cp .env.example .env
pnpm demo:api
```

PowerShell equivalent:

```powershell
Copy-Item .env.example .env
pnpm demo:api
```

The real `.env` file is ignored by Git. Never commit an API key.

For an end-to-end persistence/restart smoke test:

```bash
pnpm smoke:core-api -- --mode=cancellation
pnpm smoke:core-api -- --mode=timing
```

These tests use synthetic conversations but call the configured model. They
write detailed, auditable reports under `reports/core-api-smoke/`. The
`cancellation` mode makes at most two requests; `timing` makes at most three.

To verify the complete HTTP conversation-ingestion path, including invalidation
and idempotent replay:

```bash
pnpm smoke:host-ingestion-api
```

This synthetic smoke makes exactly three model requests when it passes: one
initial extraction, then one relevance route and one extraction for the
invalidating turn. It asserts that closure requires no later semantic model
call, produces no contact or outbox item, and that replaying the same event
performs no model work. Reports are written under
`reports/host-ingestion-smoke/`.

## Packages

| Package | Responsibility |
| --- | --- |
| `@wakeintent/core` | Domain types, lifecycle, gates, routing, orchestration, scheduling, and telemetry |
| `@wakeintent/schemas` | Public JSON Schemas and runtime validation |
| `@wakeintent/store-json` | Single-process local persistence and restart recovery |
| `@wakeintent/model-openai-compatible` | Structured extraction, routing, and reevaluation model adapter |
| `@wakeintent/eval` | Baselines, datasets, scoring, and longitudinal evaluation tools |
| `@wakeintent/reference-host` | Local structured HTTP API, persistent outbox, delivery receipts, and crash recovery |

Packages are currently private workspace packages and are not published to
npm. The currently supported integration path is to add a host package to this
pnpm workspace and depend on the packages through `workspace:*`. A separate
application cannot yet install a stable registry release. See the
[host integration guide](docs/20-host-integration.md) and the runnable
[`examples/minimal.mjs`](examples/minimal.mjs) reference.

## Current evidence

An independent clean-clone verification reproduced the complete repository
check at commit `53d5e49`: 178 tests across five packages. Two real-model smoke
runs performed during development using `gpt-5.5` also passed:

- cancellation after the follow-up reason became invalid: 2 model calls, 1,452
  tokens, 0 contact decisions;
- timing change: 3 model calls, 2,627 tokens, deferred until after the updated
  event window, 0 contact decisions.

The first reference-host ingestion smoke also passed with `gpt-5.5`: a natural
language study plan created an active intent, a later completion-and-withdrawal
message resolved it, final evaluation made no semantic model call and produced
no contact, and duplicate replay made no model call. The full path used 3 model
requests and 2,432 tokens. This is a synthetic regression result, not a user
study or a cost comparison.

The reports are preserved in
[`reports/core-api-smoke`](reports/core-api-smoke). Earlier feasibility results
and their limitations are documented in
[`docs/10-feasibility-conclusion.md`](docs/10-feasibility-conclusion.md).
The host-ingestion evidence is preserved in
[`reports/host-ingestion-smoke`](reports/host-ingestion-smoke).
The independent installation result, including the issues it found, is preserved
in [`reports/external-verification/2026-09-04-clean-clone.md`](reports/external-verification/2026-09-04-clean-clone.md).

This evidence shows that the mechanism runs end to end. It does **not** yet show
that WakeIntent is cheaper than a strong due-gated heartbeat or that it improves
user experience in production. Current experiments found better early state
cleanup and auditability, but often higher token usage.

## Scope and limitations

WakeIntent currently does not provide:

- a managed background scheduler, hosted API, notification channel, or message delivery;
- multi-process writes to one JSON store;
- a stable npm release or backward-compatibility promise;
- a role/persona policy or end-user chat UI;
- proof of lower total cost than every heartbeat implementation.

`contact` means the engine decided that contact is appropriate. It does not mean
a message was generated, attempted, or delivered. The reference host now makes
that delivery contract executable and persistent, but a real host application
still owns generation and delivery.

### Terminology

| API term | Meaning |
| --- | --- |
| `contact` | Contact decision; no message has been delivered |
| `silent` | Do not contact in this evaluation; not necessarily terminal |
| `defer` | Keep the intent active and evaluate it later |
| `cancel` | Invalidate the reason and move to `cancelled` |
| `resolve` | Mark the reason as handled and move to `resolved` |
| `expire` | Move an out-of-window reason to `expired` |
| `nextEvaluationAt` | The store's next scheduled evaluation projection, or `null` |

## Troubleshooting

- `pnpm` is not recognized: run `npm install --global pnpm@11.19.0` and open a
  new terminal if necessary.
- Node.js is too old: install Node.js 22.14 or newer, then verify with
  `node --version`.
- Dependency download fails or is slow: retry on a stable network; a registry
  timeout is separate from a WakeIntent test failure.
- A real-model run returns 401/403, 404, a `json_schema` error, or times out:
  follow [the API troubleshooting guide](docs/08-api-local-testing.md). Never
  paste a credential into an issue.

## Documentation

Start with:

- [Requirements analysis](docs/01-requirements-analysis.md)
- [Domain model](docs/02-domain-model.md)
- [System architecture](docs/03-system-architecture.md)
- [Technology selection](docs/04-technology-selection.md)
- [Evaluation and acceptance](docs/05-evaluation-and-acceptance.md)
- [Alpha 0.1 scope](docs/12-alpha-0.1-scope.md)
- [Engine orchestration](docs/13-alpha-engine-orchestration.md)
- [Unified execution trace](docs/19-unified-execution-trace.md)
- [Host integration and delivery boundary](docs/20-host-integration.md)
- [Recruitment pilot plan](docs/21-recruitment-pilot.md)
- [Reference host HTTP API](docs/22-reference-host-api.md)
- [Conversation ingestion and model mode](docs/23-conversation-ingestion.md)

## Contributing

WakeIntent is intentionally early. Reproducible failure cases, adversarial
conversation timelines, storage adapters, framework integrations, and careful
evaluation work are especially useful. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
