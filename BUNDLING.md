# Distribution: self-contained bundles

CodeGraph ships a **vendored Node runtime** alongside the app. Because Node 22.5+
has a built-in real SQLite (`node:sqlite`, with WAL + FTS5), bundling Node means:

- **No native build** — `better-sqlite3` is gone, so there are zero native addons
  to compile or rebuild.
- **No wasm fallback** — and therefore no more `database is locked` (issue #238).
- **No Node-version dependence** — the app always runs on the bundled Node,
  whatever the user has (or doesn't have) installed.

## What's in a bundle

Built by [`scripts/build-bundle.sh`](scripts/build-bundle.sh) — one archive per
platform, identical recipe (only the Node download differs):

```
codegraph-<target>/
  node | node.exe          # official Node runtime for <target>
  lib/
    dist/                  # compiled app (+ tree-sitter .wasm grammars, schema.sql)
    node_modules/          # production deps only (pure JS / wasm — portable)
  bin/
    codegraph | codegraph.cmd   # launcher → runs the bundled Node with the app
```

Targets: `darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`,
`win32-arm64`. Unix targets produce `.tar.gz` (shell launcher); Windows produces
`.zip` (`node.exe` + a `.cmd` launcher).

```bash
scripts/build-bundle.sh linux-x64            # -> release/codegraph-linux-x64.tar.gz
scripts/build-bundle.sh win32-x64            # -> release/codegraph-win32-x64.zip
```

The Node runtime is the official nodejs.org release named by the script's
default `NODE_VERSION` (or its second argument). The download is refused
unless it matches the SHA-256 listed in that release's `SHASUMS256.txt`.

Because dropping better-sqlite3 left **zero native addons**, building a bundle is
pure file-packaging — **any** target builds on **any** OS (the whole matrix builds
on one Linux runner). Cross-compilation isn't a concern; only *run-testing* a
bundle needs the target platform (or emulation, e.g. `docker run --platform
linux/amd64`).

## Build from source with Nix

The flake builds one `codegraph` package on `x86_64-linux` and `aarch64-linux`:

```bash
nix build .#codegraph
./result/bin/codegraph --version
nix run . -- status
nix flake check
```

The package compiles the engine, standalone browser viewer and native extraction
kernel from this checkout. It includes the WASM grammars and production npm
dependencies, using Nix's Node.js 24 runtime instead of downloading or repatching
a release binary. The reusable/private UI library, website, telemetry services,
installers and release archives are not built as separate outputs. Existing CLI
installer commands remain available but are not run during the build.

The viewer retains its upstream experimental opt-in. To view an already indexed
project without changing its index or saving trails:

```bash
CODEGRAPH_UI=1 ./result/bin/codegraph ui /absolute/path/to/project --read-only
```

The **Board** tab (`#/board`) reads the served project's real index. Use Add
symbols or preview folders/namespaces, then Connections to include only chosen
targets. Tests, generated code and uncertain edges are initially excluded, with
explicit controls and counts; selected cards remain. Expand nested members or
follow an indexed source link into another independent source card. In normal mode, named
boards save metadata under `.codegraph/ui/boards/`; `--read-only` allows exploring
and loading, but refuses saving/deleting. Neither mode edits source, the index
or Git state. Run without `--read-only` when you want to save boards.

The review-board clickdummy remains available at `/board-prototype.html` on
that viewer's URL. It is an isolated, session-only synthetic example, not a view
of the indexed project. See [its design plan and development instructions](docs/design/review-board-plan.md#0-interaction-clickdummy-implemented-review-before-live-integration).

`nix develop` provides Node.js, the native build toolchain and the archive tools
used by the full test suite. For installed-package changes, rebuild with
`nix build`; `npm run build` in a dev shell alone does not rebuild the native kernel.
On a headless shell with `TERM=dumb`, run the terminal-glyph assertions with an
explicit Unicode-capable test terminal:

```bash
nix develop -c env TERM=xterm-256color npm test
npm run check --workspace ui
npm run build:lib
# Requires an existing managed browser and agent-browser; installs neither:
CODEGRAPH_BROWSER_EXECUTABLE=/absolute/path/to/chromium node scripts/check-board-browser.mjs
# To exercise the installed immutable Nix viewer instead of local dist:
CODEGRAPH_BOARD_EXECUTABLE="$PWD/result/bin/codegraph" \
  CODEGRAPH_BROWSER_EXECUTABLE=/absolute/path/to/chromium node scripts/check-board-browser.mjs
```

The browser check creates its own generic indexed fixture and writable/read-only
viewers, leaves diagnostics under the printed temporary directory and closes only
its own processes. It never uses a private review checkout or saves into this
repository's index.

`flake.lock`, `package-lock.json` and `codegraph-kernel/Cargo.lock` pin the build
inputs. After changing npm dependencies, update `npmDepsHash` in
`nix/package.nix` (temporarily use `lib.fakeHash` and take the actual hash from
the failed dependency-fetch build). Native registry dependencies are derived
from `Cargo.lock` without a separately maintained Cargo hash.

The package's install checks require successful native loading and extraction,
exercise CLI indexing/querying with native and WASM extraction, and start the
read-only viewer to verify its HTML, JavaScript, indexed search and Board reads,
in-memory identity resolution and metadata-write refusal. A second writable
viewer saves, reopens and deletes a board in the throwaway fixture, checking that
source and graph counts remain unchanged. These are packaging smoke tests, not
the full test suite or browser interaction tests.
Linux ARM64 is exposed for native builds on that platform; exposing an output
is not evidence that it has been built on every architecture.

A consuming flake can pin a committed local patch branch without publishing it:

```nix
inputs.codegraph.url = "git+file:///absolute/path/to/codegraph?ref=nix/source-build";
# In the consumer's package list:
# inputs.codegraph.packages.${pkgs.stdenv.hostPlatform.system}.codegraph
```

The consumer's lock file chooses the exact commit; editing or committing this
repository does not advance an existing consumer pin. The local repository must
remain available when updating that input. Flake builds use Git-tracked files,
so add new source files to Git before building. Install and upgrade this package
through Nix rather than `codegraph upgrade`, whose self-update cannot replace
an immutable Nix store path.

## Install channels (all deliver the same bundle)

1. **`curl | sh`** ([`install.sh`](install.sh)) — no Node required; ideal for a
   fresh Linux VPS over SSH. Detects os/arch, pulls the archive from GitHub
   Releases, symlinks `codegraph` onto PATH. Re-run to upgrade; `--uninstall` to
   remove.
2. **npm** ([`scripts/npm-shim.js`](scripts/npm-shim.js)) — preserves
   `npm i -g @colbymchenry/codegraph`. The main package is a tiny shim; the
   bundles ship as per-platform `optionalDependencies`
   (`@colbymchenry/codegraph-<target>` with `os`/`cpu`), so npm installs only the
   matching one. The shim — run by the user's Node — execs the bundle, so the
   real work runs on the bundled Node 24. Works even on old Node. On Windows it
   invokes the bundled `node.exe` against the app entry directly (not the `.cmd`
   launcher) — modern Node throws `EINVAL` when asked to spawn a `.cmd`/`.bat`.
3. **Windows** ([`install.ps1`](install.ps1)) — `irm … | iex`; same flow as
   install.sh (detect arch, pull the `.zip` from Releases, add to PATH).
4. **Homebrew / Scoop** — TODO (tap + cask pointing at the Release archives).

## Release pipeline

[`.github/workflows/release.yml`](.github/workflows/release.yml) — manually
triggered. Reads the version from `package.json`, builds every platform bundle on
one runner, creates the GitHub Release (notes from `CHANGELOG.md`), and publishes
the npm shim + per-platform packages. Requires the `NPM_TOKEN` repo secret.

Still TODO:
- **Code signing** — the main gap for "download & run": macOS Gatekeeper needs a
  Developer ID + notarization; Windows needs Authenticode. Homebrew softens the
  macOS case (handles quarantine).
- Retire the now-vestigial Node-version gate in `src/bin/codegraph.ts` — the
  bundle always runs Node 24, and the npm shim does no tree-sitter work.
- Re-wire `npm uninstall` cleanup (the agent-config `preuninstall`) through the
  shim — the generated main package doesn't carry it.
