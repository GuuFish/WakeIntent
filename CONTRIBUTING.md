# Contributing to WakeIntent

WakeIntent is a research Alpha. Contributions should make the contact decision
engine easier to verify, embed, or operate without weakening user control.

## Good first contributions

- Add a reproducible conversation timeline that exposes a wrong contact,
  missed cancellation, poor deferral, or unnecessary model call.
- Improve documentation or examples whose current behavior you verified.
- Add an adapter without coupling it into `@wakeintent/core`.
- Improve deterministic policy gates, persistence safety, or telemetry.

Large UI, delivery-channel, or full-Agent changes should begin with a design
discussion so the core project does not accidentally become a chat client.

## Development

Requirements: Node.js 22.14 or newer and pnpm 11.19.

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm demo:alpha -- .wakeintent/contributor-demo.json
```

Tests that need a model must be opt-in, use synthetic data, disclose their
maximum request count, and never print or commit credentials. Copy
`.env.example` to `.env` for local configuration.

## Pull requests

- Keep changes focused and include tests for behavior changes.
- Preserve raw evaluation reports; do not rewrite an unfavorable result.
- Compare systems with the same model, context, time information, and request
  opportunity when making performance claims.
- State what was tested and which limitations remain.
- Treat `contact` as a decision, not proof of delivery.

By contributing, you agree that your contribution is licensed under the MIT
License used by this repository.
