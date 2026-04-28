# Contributing to arnie

Thanks for considering a contribution. arnie is a small, focused tool — fixes and additions that match its scope (IT troubleshooting on a single machine) are welcome.

## Setup

```sh
git clone https://github.com/askalf/arnie
cd arnie
npm install
npm run build
```

You'll need:

- Node 20+
- An `ANTHROPIC_API_KEY` (for live runs; not required for tests)

## Workflow

| Task | Command |
| --- | --- |
| Type-check | `npm run typecheck` |
| Build | `npm run build` |
| Run from source | `npm start` |
| Watch mode | `npm run dev` |
| Offline tests | `npm test` (no API key needed) |
| Run after install | `npm link` then `arnie` |

The offline test harness (`src/test-tools.ts`) covers every internal module — tools, sessions, config, redactors, sandbox, etc. New code should add cases there.

## Adding a tool

1. Create `src/tools/<name>.ts` with `runX(input)` plus a `X_TOOL_DEFINITION`.
2. Register in `src/tools/registry.ts`: import, schema, handler entry, and inclusion in `buildToolList()`.
3. If the tool is read-only, add it to `PARALLEL_SAFE` in the same file.
4. If the tool is mutating (writes, runs commands), add it to `MUTATING_TOOLS` in `src/dryRun.ts` so `--dry-run` blocks it.
5. Mention the tool in `src/systemPrompt.ts` so the model knows when to reach for it.
6. Add tests to `src/test-tools.ts`.
7. Update `README.md`.

## Style

- TypeScript strict mode is on. Prefer typed parameters over `any`.
- One concept per file; don't grow `cli.ts`.
- Keep tool implementations under ~200 lines. If a tool needs more, it's probably two tools.
- No new dependencies without a reason — the SDK + chalk + zod cover almost everything.
- Comments explain WHY, not WHAT.

## Filing issues

Include:

- Platform (`process.platform`, OS version)
- Node version (`node --version`)
- arnie version (`arnie --version`)
- Minimum command/transcript to reproduce
- What you expected vs. what happened
