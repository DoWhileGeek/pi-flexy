# Publishing Flexy

- GitHub: <https://github.com/DoWhileGeek/pi-flexy>
- npm package: `@dowhilegeek/pi-flexy`
- Pi installation after the first npm release: `pi install npm:@dowhilegeek/pi-flexy`

Pi's gallery discovers npm packages with the `pi-package` keyword. There is no separate Pi registry upload. The package also declares its extension in `package.json` under `pi.extensions`.

**Current preparation does not publish a release.** Creating the repository or pushing `main` only runs checks. Pushing a matching `v*` version tag triggers the publish workflow.

## One-time prerequisites

1. Own the `dowhilegeek` npm account/scope, or have permission to publish under it. GitHub authentication does not authenticate npm.
2. Enable account-level npm 2FA. Complete authentication in your browser; never put a token or one-time code in source control or chat.
3. Use a clean, reviewed checkout of the public canonical repository. Confirm `package.json`'s name, version, and repository URL.
4. Check package contents with `npm run check:package`. It verifies the Pi manifest and an exact tarball allowlist; tests, workflows, local logs, and credentials are excluded.

Pi supplies its core libraries at runtime. They are optional wildcard peers, not bundled dependencies, following Pi's package guidance. Development dependencies pin the version used by the test suite; this does not claim compatibility with every Pi version.

## First npm publication

npm requires a package to exist before you can configure its trusted publisher. The first release therefore uses your interactive npm authentication, not GitHub OIDC.

Use ordinary npm for login and the first publication. npm 11.15.0+ is only needed for the optional `npm trust` CLI setup below, not these login commands:

```bash
npm ci --ignore-scripts
npm login
npm whoami
```

Confirm the returned identity owns or can publish to the `dowhilegeek` scope. Review the release before running the next command: **npm publication makes this version public, and published versions cannot be overwritten.**

```bash
npm publish --access public
```

`prepublishOnly` runs typechecking, all tests, and the tarball check before publication. The initial prepared version is `0.1.0`; check the current version rather than assuming it remains unchanged.

Verify the registry result:

```bash
npm view @dowhilegeek/pi-flexy version keywords repository.url
```

Do not push a tag for the already-published bootstrap version: the tag workflow would try to publish that version again. Future releases use fresh versions and tags.

## Configure trusted publishing

After the first publication, configure the package's trusted publisher on npmjs.com:

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `DoWhileGeek` |
| Repository | `pi-flexy` |
| Workflow filename | `publish.yml` |
| Environment name | Leave empty; this workflow declares no environment |
| Allowed action | Allow direct publishing with `npm publish` |

Or configure the same relationship using npm 11.15.0+:

```bash
npx --yes npm@11.15.0 trust github @dowhilegeek/pi-flexy \
  --repo DoWhileGeek/pi-flexy \
  --file publish.yml \
  --allow-publish
```

This operation requires account-level 2FA and permission on the existing package. If a publisher already exists, inspect it before changing it; do not blindly revoke a working configuration.

No `NPM_TOKEN` GitHub secret is needed. `.github/workflows/publish.yml` uses a GitHub-hosted runner, `id-token: write`, and npm's OIDC exchange. npm automatically attaches provenance for a public package published from this public repository via trusted publishing.

For stronger controls, configure GitHub tag protection and npm publishing-access restrictions after trusted publishing has been verified. Keep registry and repository names/case identical to the configuration above.

## Subsequent releases

Start from a clean, up-to-date `main` checkout:

```bash
npm ci --ignore-scripts
npm run check
npm run check:package
npm version patch
# Review the release commit and tag before sending them.
git push origin main --follow-tags
```

The annotated version tag triggers the publish workflow. The job:

1. Runs only in `DoWhileGeek/pi-flexy`.
2. Checks that the tag matches `package.json` and is a stable version.
3. Installs pinned development dependencies.
4. Runs the prepublish tests and tarball review check.
5. Publishes through npm trusted publishing, without a long-lived token.

The workflow deliberately rejects prerelease versions; add an explicit dist-tag policy before supporting prerelease releases. An existing npm version is immutable—fix a failed release by investigating its logs, not by overwriting an already-published version.

## Pi gallery verification

After npm publication, check:

- `npm view @dowhilegeek/pi-flexy keywords` includes `pi-package`.
- `pi install npm:@dowhilegeek/pi-flexy` loads `/flex` in a clean Pi session.
- Search for `@dowhilegeek/pi-flexy` in <https://pi.dev/packages> after indexing catches up. No indexing delay is guaranteed.

Optional gallery previews can be added later using `pi.image` or `pi.video` metadata. They are not required for installation or discovery.

## References

- [Pi package format and gallery metadata](https://pi.dev/docs/latest/packages)
- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers)
- [npm trust prerequisites and CLI](https://docs.npmjs.com/cli/v11/commands/npm-trust/)
- [Publishing public scoped npm packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/)
