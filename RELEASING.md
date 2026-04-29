# Releasing arnie

How a release ships and what to verify post-publish.

## How releases ship

Auto-release on master. The version bump in `package.json` is the release trigger — `.github/workflows/auto-release.yml` runs on every push to master that touches `package.json`, detects whether the `version` field actually changed, and (if so) tags `vX.Y.Z`, creates a GitHub release from the matching CHANGELOG section, and runs `npm publish --provenance --access public` against the registry. Idempotent — if the tag already exists or the version field didn't change, the workflow exits cleanly.

The author's job is just to land the version bump:

```sh
# 1. Update version in two places — these must match
#    - package.json: "version": "X.Y.Z"
#    - src/cli.ts:   const VERSION = "X.Y.Z"
#    The auto-release workflow runs `arnie --version` post-build and
#    refuses to publish if they disagree.

# 2. Update CHANGELOG.md — promote the `## [Unreleased]` heading
#    to `## [X.Y.Z] - YYYY-MM-DD` and add a fresh `## [Unreleased]`
#    above it. The workflow extracts this section verbatim as the
#    GitHub release notes.

# 3. Land on master
git commit -am "vX.Y.Z — <one-line summary>"
git push
```

That's it. The workflow handles tag, GitHub release, and npm publish.

If the workflow is unavailable (e.g., GitHub Actions is down) the manual fallback is:

```sh
git tag -a vX.Y.Z -m "vX.Y.Z"
git push --tags
TMPRC=$(mktemp); chmod 600 "$TMPRC"
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$TMPRC"
npm publish --userconfig "$TMPRC"
rm -f "$TMPRC"
gh release create vX.Y.Z --notes-file <(awk '/^## \[X\.Y\.Z\]/{f=1;next} f&&/^## \[/{exit} f' CHANGELOG.md)
```

The `--userconfig` route avoids leaving the auth token in `~/.npmrc`. Use only if the workflow is broken — under normal operation, all three (tag/release/publish) come for free from the version bump.

## Pre-merge checklist (PR author / reviewer)

- [ ] `npm run typecheck` clean
- [ ] `npm run build` clean
- [ ] `npm test` — 153/153 pass (current baseline)
- [ ] `npm run test:integration` — passes via dario or skips cleanly
- [ ] `package.json` and `src/cli.ts` versions match if this is a release
- [ ] `CHANGELOG.md` has a `## [X.Y.Z] - YYYY-MM-DD` heading above `## [Unreleased]`, populated with user-visible changes
- [ ] PR description names what's user-visible

## Post-publish smoke

Within ~10 minutes of `npm publish` completing:

```sh
# Wait for the registry to serve the new version
until [ "$(npm view arnie-cli version)" = "X.Y.Z" ]; do sleep 2; done

# Install globally and confirm the bin shim works on the actual installed
# package, not just the dev tree. Dev tree runs `node dist/cli.js …`,
# end users run the symlinked `arnie` shim — these can drift.
npm install -g arnie-cli@X.Y.Z
which arnie
arnie --version

# Quick functional smoke. Either path is fine.
arnie --dario --print "Use list_dir on ${HOME} and report the count. One sentence."
# or
arnie --print "Use list_dir on ${HOME} and report the count. One sentence."
```

If the bin shim fails or `--version` prints the wrong value, fast-follow with a patch release.

## Post-publish housekeeping

- [ ] `gh release create vX.Y.Z` — paste the matching CHANGELOG section as the release notes (or skip if you set up auto-releases)
- [ ] Verify the npm page at `https://www.npmjs.com/package/arnie-cli` shows the new version, and that the GitHub link still resolves
- [ ] Update any cross-repo references (org profile READMEs at `askalf/askalf` and `askalf/.github` are pinned to the registry, not a version, so usually no-op)

## Notes

- **Dependabot security updates** are on. If a CVE in an `@anthropic-ai/sdk` / `chalk` / `zod` etc. lands, Dependabot opens a PR; merging it triggers the same flow above (bump versions, push, tag, publish).
- **CodeQL** runs on every push and PR plus weekly. Open alerts (if any) in the Security tab; fix as patch releases.
- **`NPM_TOKEN`** is stored as a GitHub Actions secret on the arnie repo and used by the auto-release workflow only. To rotate: revoke at npmjs.com → Access Tokens, generate a new automation token, then `gh secret set NPM_TOKEN -R askalf/arnie -b '<new-token>'`. The published-package metadata includes a [provenance attestation](https://docs.npmjs.com/generating-provenance-statements) so consumers can verify it was built from this repo at the recorded commit.
