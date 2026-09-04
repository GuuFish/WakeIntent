# Independent clean-clone verification — 2026-09-04

## Result

**PASS WITH ISSUES**

An independent agent cloned commit `53d5e49fa394a58fef87c7fd2573953a47c781dc` into a previously nonexistent temporary directory and followed the public README without modifying source code.

The result confirms that WakeIntent is a locally runnable research Alpha. It does not establish production readiness.

## Environment

- Windows 11 64-bit (`10.0.26200`)
- Node.js `v22.14.0`
- pnpm `11.19.0`
- Git `2.45.1.windows.1`

The clean environment initially had neither pnpm nor an available Corepack command. The verifier installed the repository-pinned version with `npm install --global pnpm@11.19.0`. This onboarding gap was addressed after the verification.

## Commands reproduced

```powershell
git clone --depth 1 https://github.com/GuuFish/WakeIntent.git <new-temporary-directory>
pnpm install --frozen-lockfile
pnpm check
pnpm demo:alpha -- .wakeintent/external-verification.json
pnpm demo:alpha -- .wakeintent/external-verification.json
```

## Observed results

- Frozen install completed without changing `pnpm-lock.yaml`.
- All five packages built and type-checked successfully.
- 178/178 tests passed across 22 test files.
- The first offline demo run created two intents, committed one `cancel` and one `silent`, and produced zero contact decisions.
- The second run returned duplicate registrations, `dueCount: 0`, `semanticModelCalls: 0`, no new decisions, and an unchanged audit count.
- `.env`, `node_modules`, `dist`, and `.wakeintent` outputs were correctly ignored.
- English and Chinese README links resolved successfully.

## Issues found

The verifier found documentation and onboarding issues rather than an engine failure:

1. The README required pnpm but did not explain how to install the pinned version.
2. The quick-start sequence and expected first/second demo outputs were not explicit.
3. The relationship between `silent`, an `active` lifecycle state, and `nextEvaluationAt: null` was easy to misunderstand.
4. The host delivery boundary and current monorepo-only integration path needed a concrete explanation.
5. Real-model examples needed their maximum request counts near the commands.
6. Chinese lifecycle terminology was not fully consistent.

These issues are addressed in the follow-up documentation and CI commit. The report remains `PASS WITH ISSUES` because the original verification result must not be retroactively rewritten.

## Not verified

This run deliberately made no real model calls and therefore does not confirm:

- OpenAI-compatible provider behavior or model semantic accuracy;
- lower cost than a strong due-gated heartbeat;
- multi-process storage safety;
- message generation, delivery, or delivery receipts;
- production user experience, availability, or security.
