# Autonomous Experience reports

The formal frozen run is:

- `2026-09-05T17-43-19.137Z/results.json`: immutable first-pass output and scoring.
- `2026-09-05T17-43-19.137Z/results.corrected.json`: the same Agent outputs rescored after fixing valid conversation-evidence IDs that were incorrectly marked fabricated.
- `2026-09-05T17-43-19.137Z/results.audited.json`: canonical result after filtering unused evidence from the blind judge and explicitly auditing whether a strong Baseline could reconstruct each potential positive at return.
- `2026-09-05T17-43-19.137Z/experiment-report.audited.md`: generated report for the canonical result.

No Agent output, frozen scenario, model, or conclusion threshold changed between these files. The audit added judge calls only and records them under `methodAudit`.

The earlier `2026-09-05T17-34-52.017Z` directory is a three-pair infrastructure smoke run. It used a pre-freeze judge evidence package and is excluded from the formal conclusion.

The human-readable analysis and stopping decision are in `docs/28-autonomous-experience-result.md`.