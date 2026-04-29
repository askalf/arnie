# Releasing arnie

How a release ships and what to verify post-publish.

## How releases ship (today)

Manual flow. The version bump is the release trigger — once on master, tag and publish follow immediately.

```sh
# 1. Update version in two places
#    - package.json: "version": "X.Y.Z"
#    - src/cli.ts:   const VERSION = "X.Y.Z"
#    Both must match. CI's read_file: read package.json test asserts the
#    package name; mismatched VERSION is caught by the build's --version
#    smoke step in the post-publish checklist below.

# 2. Land the bump on master
git commit -am "vX.Y.Z — <one-line summary>"
git push

# 3. Wait for CI green (test + codeql)
gh run list -R askalf/arnie -L 2

# 4. Tag annotated and push
git tag -a vX.Y.Z -m "vX.Y.Z — <one-line summary>"
git push --tags

# 5. Publish to npm
TMPRC=$(mktemp); chmod 600 "$TMPRC"
printf '//registry.npmjs.org/:_authToken=%s\n' "$NPM_TOKEN" > "$TMPRC"
npm publish --userconfig "$TMPRC"
rm -f "$TMPRC"
```

The `--userconfig` route avoids leaving the auth token in `~/.npmrc`. The token gets read from the env var only at publish time and never persisted.

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
- **No auto-release workflow yet.** If you want one (version bump on master → tagged release + npm publish in CI), add a workflow that listens for `paths: [package.json]` on master and uses an `NPM_TOKEN` repo secret. Tradeoff: removes the manual `npm publish` step but requires a long-lived token in CI.
