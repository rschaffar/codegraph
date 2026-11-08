# Review Board authoring

## Compatibility and authority

This describes the **local Review Board extension**, checked against CodeGraph
1.6.2, source commit `51e3b8791787c6bdfa5880669a2c87d683a26717` (2026-11-08),
including plain-text comment cards. This reference also reflects the subsequent
removal of the separate 32-source-panel and 4,096-pixel source-height caps. Older
builds may still enforce those caps or reject the `comments` field; check
capabilities before sending boards.
Version number alone does not prove a build has Board support. When upgrading or
using another installation, check its capabilities and current format first.
In an available CodeGraph source checkout, the maintained owners are:

- `src/ui-server/api/board-store.ts`: document/storage types and strict validator.
- `src/ui-server/api/boards.ts`: exact identity resolution and save/load APIs.
- `ui/src/components/board/ReviewBoardCanvas.svelte`: import/export behavior.
- `docs/design/review-board-plan.md` and `review-board-data-model.md` in that same
  design directory: the view's selection and evidence contracts.

Use existing tools/help and an already running, explicitly identified project
viewer where possible. If starting a viewer is within the request, the checked
local build uses `CODEGRAPH_UI=1 codegraph ui "$project" --no-open`; use the URL
it prints, not an assumed port. Board lives at `#/board`. This is a local viewer
feature gate, not a reason to install a different build or change permissions.
Respect read-only mode; do not bypass it with a direct filesystem write.

## 1. Select exact indexed symbols

Use `codegraph_explore` for structural context. For machine-readable identities:

```bash
codegraph query --path "$project" --json --limit 20 'UserService'
```

The checked CLI returns an array of results with a `node` object. Copy
`node.qualifiedName`, `node.kind` and `node.filePath` into the board's
`identity.qualifiedName`, `identity.kind` and `identity.file`. Normalize path
separators to `/`. The optional `identity.id` is only a hint, never sufficient
identity. Copy `node.signature` exactly if needed to distinguish declarations;
whitespace, including tabs and line breaks, is significant. Do not guess qualified
names from a class's display name or treat a search result limit as completeness.

An existing viewer also offers `GET /api/board/search` with `q`, `kind`, `path`,
`namespace`, `offset`, `limit` and `tests`/`generated`/`uncertain` flags (`0` or
`1`). Use its `items` as search matches, not its broader `symbols` context.
Follow `nextOffset` as needed and check `bounded`, `notes` and excluded counts.
Wire symbols already use `file`, rather than the CLI node's `filePath`.

Resolution requires an exact match on `(qualifiedName, kind, file)` and, when
supplied, `signature`. Zero matches means **missing**; multiple matches means
**ambiguous**, even with an ID. An otherwise exact identity whose ID changed is
**moved**, not missing. Narrow a search or ask when the requested component cannot
be chosen reliably; do not silently substitute a similarly named symbol.

All indexed node kinds are eligible, not only classes or callable functions.
Choose file/module/type/function/component nodes according to the user's scope.
A board holds one project's indexed identities. Reviewer notes belong in the
separate `comments` array, not fake symbol identities. Invented edges and
cross-project identities are not supported by this V1 format.

## 2. Build the document and rough layout

For a simple board, create one `symbols` entry per selected component, with unique
local keys, `included: true`, `hidden: false`, `expanded: false`, and `cards: []`.
Start near `(0, 0)` with a viewport offset such as `(40, 40)` and `zoom: 1`.
As a **layout heuristic**, use columns about 500 units apart and rows about 300
units apart. Increase spacing for expanded symbols or source panels. A rough
layout is sufficient unless visual polish was requested.

This is a complete **illustrative import document**, not proof these symbols
exist in any particular project; replace identities with real query results:

```json
{
  "version": 1,
  "symbols": [
    {
      "key": "service",
      "identity": {
        "qualifiedName": "UserService",
        "kind": "class",
        "file": "src/user-service.ts"
      },
      "position": { "x": 0, "y": 0 },
      "included": true,
      "hidden": false,
      "expanded": false
    },
    {
      "key": "repository",
      "identity": {
        "qualifiedName": "UserRepository",
        "kind": "class",
        "file": "src/user-repository.ts"
      },
      "position": { "x": 500, "y": 0 },
      "included": true,
      "hidden": false,
      "expanded": false
    }
  ],
  "cards": [],
  "viewport": { "x": 40, "y": 40, "zoom": 1 },
  "filters": { "kind": "", "showStructure": true }
}
```

There is no saved `edges` array and no copied source text. The viewer derives
relationships from the index and represents them according to selected symbols,
containment/expansion and active filters. Choosing a component does not admit all
its neighbours. `filters.kind: ""` means all relationship kinds; `showStructure`
controls structural relations. Optional `includeTests`, `includeGenerated` and
`includeUncertain` default to `false` and govern exclusions, not membership.

Distinguish four concepts:

- `included`: explicitly pinned graph membership.
- `hidden` / `expanded` / optional `memberLimit`: visibility and outline state.
  A hidden inline member restored later must not become a new pin.
- `cards`: additional movable **source-code panels**, not the graph component
  cards themselves. A source-only identity may have `included: false`.
- `comments` (optional): independent, editable plain-text notes with no indexed
  identity, source panel or graph connection; omit it when no notes are requested.

For a requested source panel, add one card with `key`, `symbolKey` (an existing
symbol key), `position`, `width`, `height`, `collapsed` and `zIndex`. For example,
use position `(0, 350)`, size `600 × 400`, `collapsed: false`, `zIndex: 1` and a key
like `source-service`. Only one source panel per symbol is allowed.

The validator rejects unknown properties and duplicate symbol identities. Keys
use letters, digits, underscore and dash (max 128 characters); symbol/source/comment keys
must not collide. Required booleans must be real JSON booleans. Paths are
project-relative, forward-slash paths with no absolute prefix, colon, empty,
`.` or `..` segment. Do not add labels, line numbers, discovery scope or API node
metadata to an identity: only `id?`, `qualifiedName`, `kind`, `file`, `signature?`
are allowed.

Checked limits: 128 symbol entries (including hidden/source-only entries), one
source panel per symbol with no separate panel-count cap, 64 comment cards,
16,384 characters per comment, 1 MiB per import/stored file,
coordinates within ±1,000,000, zoom 0.05–8, source width 100–4096 and finite source
height at least 60 (no height ceiling). `zIndex` is an integer from 0–1,000,000;
optional `memberLimit` is an integer from 1–2048. These include hidden/source-only entries. Check the current
validator for all limits; split an oversized selection instead of dropping items
silently. Metadata also consumes space, so stay below the maximum file size.

### Plain-text comment cards

When requested, add notes to the document's optional `comments` array. A comment
needs exactly `key`, `text`, `position`, `width`, `height` and `zIndex`. For example,
this complete comment-only board is also valid; indexed symbols are not required:

```json
{
  "version": 1,
  "symbols": [],
  "cards": [],
  "comments": [
    {
      "key": "review-note",
      "text": "Questions for the review:\n- Confirm the retry behavior.\n- Check the error path.",
      "position": { "x": 0, "y": 0 },
      "width": 320,
      "height": 240,
      "zIndex": 10
    }
  ],
  "viewport": { "x": 40, "y": 40, "zoom": 1 },
  "filters": { "kind": "", "showStructure": false }
}
```

Text is literal: HTML/Markdown is not rendered. Empty drafts, tabs and line breaks
are allowed; other control bytes are rejected. Keep whitespace and user text
unchanged. Width is 240–4096, height 160–4096; coordinate and integer `zIndex`
bounds are the same as above. The aggregate file limit still applies, including
JSON encoding/metadata overhead: all individual maxima cannot fit together.

In the viewer, **+ Add comment** creates a card at the visible canvas centre and
focuses its multiline editor. Drag its header, use resize handles or **Size**
buttons, select/move it with symbol/source cards, or delete it. Text editing and
scrolling do not move the canvas. Save/Open and JSON export/import retain note
text, position, dimensions and stacking order. Notes can be edited/exported in
read-only mode, but cannot be persisted there; respect the existing write refusal.
They do not create indexed symbols, source requests, arrows or attachments.

Preserve comments and their keys when editing an existing board. A comment-only
board has no symbol resolutions to inspect; still validate its full document.
Legacy V1 documents without `comments` need no migration. Do not remove notes to
make an older viewer accept a document without an explicit user decision.

## 3. Choose import versus saved storage

**Portable import (default when no destination was specified):** write the bare
document above, or the viewer's export envelope `{ "name": "...", "document": ... }`,
to the agreed deliverable path. “Import JSON” resolves it into memory only;
“Save as” persists it later. Put previews, experiments and validation outputs in
the user's per-task workspace, not scattered into the project or installed skill.
Do not overwrite an existing output without scope to do so.

**Saved board:** the default project-local location is
`.codegraph/ui/boards/<id>.json`. Board storage honors the viewer process's
`CODEGRAPH_DIR` override; `GET /api/boards` reports the effective project-relative
`directory`. Resolve that location before writing rather than assuming it is the
default or changing an override. A bare document or import envelope is **not** a
stored board. A stored JSON object requires these fields:

- `version: 1`, `id`, `name`, `createdAt`, `updatedAt`, `document`.
- `document` is the complete version-1 document above.
- `id` matches the filename without `.json`: lowercase letters, digits and dash,
  starts with a letter/digit, max 80 characters; not a Windows device basename
  such as `con`, `nul`, `com1` or `lpt1`.
- `name` is nonempty, at most 120 characters. Use distinct names for new boards.
- Timestamps use UTC ISO form with milliseconds, e.g. `2026-11-08T14:00:00.000Z`.
  Preserve `createdAt` when editing; update `updatedAt`.

An agent **can write a new stored file directly**: no browser, SQLite mutation or
source-code change is required. Check the destination, existing names and complete
directory inventory first. The checked limits are **200 valid boards** and **400
scanned directory entries**, including temporary/non-board files: a new file must
not exceed either limit. If a listing is `bounded`, or skipped/unexamined entries
prevent complete name/capacity checks, stop rather than bypassing the save API's
safeguards. Overfilling this directory can hide boards and block later API saves.
Create exclusively and leave existing boards untouched. Use only real local
directories and regular files, not symlinks or files with extra hardlinks. Avoid
direct writes during concurrent viewer saves; never remove a `.write.lock` to
proceed. For editing an active board, prefer its save API to its backing file.

When an authorized writable viewer is available, `POST /api/boards` accepts
`{ "name": "...", "document": ... }` to create and assigns ID/timestamps itself.
Supplying an existing `id` updates that board; it does **not** create a caller-chosen
ID. POST requests require `Content-Type: application/json` and a nonempty
`x-codegraph-ui` header. The save API is preferable to direct writing when it can
handle locking, name collisions and limits for you. A write timeout is uncertain:
check the known board/list before retrying. Do not bypass refusals or limits.

## 4. Validate, resolve and hand off

1. Parse the JSON and run the current board validator if available. Syntax alone
   does not establish format validity or valid symbol identities.
2. Against the intended viewer, `POST /api/boards/validate` accepts a **bare
   document**. `POST /api/boards/resolve` instead requires exactly
   `{ "document": ... }`. Both are non-persisting operations, available even in
   read-only mode, and require the POST headers above. For a bare document file:
   ```bash
   curl --fail-with-body --silent --show-error \
     -H 'Content-Type: application/json' -H 'x-codegraph-ui: 1' \
     --data-binary @"$document_file" "$base_url/api/boards/validate"
   ```
   Inspect every returned `resolutions` entry: HTTP success can still contain
   `missing` or `ambiguous` identities. Accept `ok` and inspect `moved`; do not
   claim all components resolved when any remain placeholders.
3. For a saved board, use `GET /api/boards/<id>` or the viewer to check the loaded
   document and resolutions; existence alone does not prove it loads. That GET
   returns no saved-board wrapper. Check `id`, `name` and `updatedAt` separately
   through `GET /api/boards`, and inspect the stored JSON to verify `createdAt`
   and the full wrapper when needed.
4. If the viewer/validator is unavailable, report precisely what was checked and
   leave format/resolution or visual verification marked unverified. Do not start
   a server, index a project or install a package solely to hide a validation gap.
5. Return the absolute output path, included components, any unresolved/excluded
   items and how to import/open it. Claim visual verification only after actually
   viewing the board; a valid document does not prove good visual arrangement.
