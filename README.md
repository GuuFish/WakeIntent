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

> **Status: experiment concluded; standalone product development is paused.**
> WakeIntent remains a runnable research artifact and developer component. A
> frozen comparison against a strong Memory + Proactive Agent baseline did not
> show enough behavioral benefit to justify the extra complexity and token cost.

## Research status

WakeIntent is currently preserved as an experimental research repository. Its
two completed comparisons test whether explicit continuity mechanisms add
stable user-visible value beyond a strong Memory + Proactive Agent baseline.

| Experiment | Audited result | Current decision |
| --- | --- | --- |
| Explicit ContactIntent continuity | No reduction in false outreach; more missed follow-ups and 42.2% more tokens | Pause standalone product development |
| Autonomous away-time experience | Behavior differed in 20/60 runs, but only 1/60 passed the full causal and counterfactual chain | Do not pursue as a product direction |

WakeIntent tested a narrow question: does preserving a future contact reason as
an explicit, durable lifecycle object lead to better behavior than saving a
future-follow-up memory and letting the same model reconsider it later?

In the frozen experiment, 20 synthetic longitudinal scenarios were run three
times for both systems with the same model, conversation facts, time, and user
state. Both systems made zero unjustified outreaches. WakeIntent missed 3 of 21
required follow-ups while the strong baseline missed 1, used 42.2% more tokens,
made 17.8% more model calls, and took 31.7% more cumulative latency. The key
busy-then-free demo produced the same `defer -> contact` behavior in all three
runs.

The result does not prove that explicit intent state is useless in every system.
It shows that this implementation did not turn lifecycle structure, earlier
state cleanup, and auditability into better user-visible behavior. The current
decision is therefore to stop expanding WakeIntent as a standalone product and
retain the code, datasets, failures, and reports as an honest engineering
experiment or a possible internal component for another proactive agent.

See the [experiment report](reports/intent-continuity-value/2026-09-05T11-50-41.477Z/experiment-report.md)
and [frozen protocol](docs/25-intent-continuity-value-experiment.md).
A follow-on Autonomous Experience experiment also tested whether one bounded,
actually executed activity during user absence could create useful behavior that
the same baseline could not reconstruct at return. Across another 20 scenarios
and 3 repetitions, behavior differed in 20/60 runs, but only 1/60 passed the
full causal and counterfactual chain, no positive scenario was stable, and the
Autonomous product path used 91.9% more tokens. The result was
**B_DIFFERENT_NOT_VALUABLE**, so the project will not pursue autonomous experience
as a product direction. See the [final result](docs/28-autonomous-experience-result.md)
and [audited machine-readable report](reports/autonomous-experience/2026-09-05T17-43-19.137Z/results.audited.json).

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

`pnpm check` builds and type-checks every workspace package and app, then runs their tests. The final experiment branch passes 209 automated tests.

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

## Final evidence

The final frozen comparison completed 60/60 paired scenario runs with zero
runtime errors and 327 HTTP attempts:

| Metric | WakeIntent | Strong baseline |
| --- | ---: | ---: |
| Unjustified outreach | 0 / 48 | 0 / 48 |
| Missed required follow-up | 3 / 21 | 1 / 21 |
| Model calls | 172 | 146 |
| Total tokens | 155,455 | 109,353 |
| Cumulative latency | 1,663,909 ms | 1,263,853 ms |

Complete internal action sequences agreed in 61/69 cases (88.4%). Several
differences were internal only: neither system sent a message. The stable
user-visible failure was `s16-two-intents-one-cancelled`, where WakeIntent
incorrectly cancelled both intents in all three runs even though the user
cancelled one topic and explicitly kept the other. The baseline handled all
three runs correctly. WakeIntent outperformed the baseline once in
`s17-similar-learning-update`, but that baseline error did not repeat in the
other two runs.

The blind evaluation pack is preserved, but no result from five real human
testers exists. The project therefore makes no claim that WakeIntent feels more
natural or continuous. Model cost in USD is unavailable because provider
pricing was not configured.

Machine-readable data, CSV output, generated messages, failure traces, and the
blind pack are preserved under
[`reports/intent-continuity-value/2026-09-05T11-50-41.477Z`](reports/intent-continuity-value/2026-09-05T11-50-41.477Z).
The repository currently passes 209 automated tests.

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
