# WakeIntent

[English](README.md) | [简体中文](README.zh-CN.md)

WakeIntent is a framework-agnostic contact-intent engine for conversational AI.
It turns a conversational reason to follow up later into a durable `ContactIntent`,
then revalidates that reason against newer context before deciding to contact,
defer, cancel, expire, resolve, or stay silent.

> **Status: research Alpha 0.1.** The core engine, local persistence, model
> adapter, audit trail, and evaluation tooling run today. WakeIntent is not yet a
> production notification service or a finished chat application.

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
- OpenAI-compatible Responses and Chat Completions adapter;
- deterministic test clock, evaluation datasets, baselines, and token telemetry.

## Quick start

Requirements: Node.js 22.14 or newer and pnpm 11.19.

```bash
pnpm install --frozen-lockfile
pnpm demo:alpha -- .wakeintent/my-alpha-demo.json
pnpm check
```

The Alpha demo is fully local. It uses a deterministic fake semantic model,
persists state, simulates a restart, cancels an invalidated job-fair follow-up,
and silences an excessively late low-value check-in. It does not need an API
key and does not spend tokens.

Run the same command again with the same state path to see idempotent restart
behavior: no old intent is contacted or evaluated twice.

## Try a real model

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
write detailed, auditable reports under `reports/core-api-smoke/`.

## Packages

| Package | Responsibility |
| --- | --- |
| `@wakeintent/core` | Domain types, lifecycle, gates, routing, orchestration, scheduling, and telemetry |
| `@wakeintent/schemas` | Public JSON Schemas and runtime validation |
| `@wakeintent/store-json` | Single-process local persistence and restart recovery |
| `@wakeintent/model-openai-compatible` | Structured extraction, routing, and reevaluation model adapter |
| `@wakeintent/eval` | Baselines, datasets, scoring, and longitudinal evaluation tools |

Packages are currently private workspace packages and are not published to
npm. They can be embedded from this monorepo while the public API stabilizes.

## Current evidence

On 2026-09-03, the complete repository check passed with 178 tests across five
packages. Two fresh real-model smoke runs using `gpt-5.5` also passed:

- cancellation after the follow-up reason became invalid: 2 model calls, 1,452
  tokens, 0 contact decisions;
- timing change: 3 model calls, 2,627 tokens, deferred until after the updated
  event window, 0 contact decisions.

The reports are preserved in
[`reports/core-api-smoke`](reports/core-api-smoke). Earlier feasibility results
and their limitations are documented in
[`docs/10-feasibility-conclusion.md`](docs/10-feasibility-conclusion.md).

This evidence shows that the mechanism runs end to end. It does **not** yet show
that WakeIntent is cheaper than a strong due-gated heartbeat or that it improves
user experience in production. Current experiments found better early state
cleanup and auditability, but often higher token usage.

## Scope and limitations

WakeIntent currently does not provide:

- a background daemon, hosted API, notification channel, or message delivery;
- multi-process writes to one JSON store;
- a stable npm release or backward-compatibility promise;
- a role/persona policy or end-user chat UI;
- proof of lower total cost than every heartbeat implementation.

`contact` means the engine decided that contact is appropriate. It does not mean
a message was generated, attempted, or delivered. A host application must own
delivery and feed receipts back through a future delivery contract.

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

## Contributing

WakeIntent is intentionally early. Reproducible failure cases, adversarial
conversation timelines, storage adapters, framework integrations, and careful
evaluation work are especially useful. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
