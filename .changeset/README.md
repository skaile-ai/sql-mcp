# Changesets

This repo uses [changesets](https://github.com/changesets/changesets) to manage
the version and `CHANGELOG.md`.

Every PR that changes `src/` must include a changeset:

```bash
bun run changeset
```

Pick a bump level (patch / minor / major) and write a short summary — that
summary becomes the changelog entry. For changes that need no release
(docs/CI-only), add an empty changeset instead:

```bash
bun run changeset --empty
```

On push to main, the Version workflow (`version.yml`) opens/updates a
"Version Packages" PR that applies pending changesets (bumps `package.json`,
regenerates `CHANGELOG.md`). Merging that PR is the release: the workflow
tags the merge commit `v<version>` and triggers `release.yml`, which builds
the bundle and publishes it as a GitHub Release. Nothing is published to npm.
