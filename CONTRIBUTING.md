# Contributing to WakeIntent

WakeIntent has completed its first core-value experiment. Standalone product
expansion is paused because the frozen comparison did not show enough
user-visible benefit over a strong Memory + Proactive Agent baseline to justify
the added complexity and token cost.

Contributions are still welcome when they improve reproducibility, correct a
verified defect, preserve the research record, or make the existing component
safer to study and embed.

## Good first contributions

- Reproduce the frozen experiment without changing its scenarios or scoring.
- Fix documentation or report-generation defects while preserving raw results.
- Add a focused regression test for a verified lifecycle or persistence bug.
- Improve credential handling, deterministic replay, or audit integrity.
- Propose an independent experiment that could falsify a clearly stated new
  hypothesis.

New UI, delivery channels, personas, agent frameworks, or product expansion are
out of scope until new evidence supports reopening that work.

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
- Do not tune the frozen dataset or scoring after seeing model output.
- State what was tested and which limitations remain.
- Treat `contact` as a decision, not proof of delivery.

By contributing, you agree that your contribution is licensed under the MIT
License used by this repository.
