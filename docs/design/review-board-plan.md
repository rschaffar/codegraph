# Local Review Board: design and implementation plan

Status: the agreed **single-project Review Board V1 is implemented**, and the
reviewer-reproduced functional defects have local fixes and regression coverage.
Selection, filters, recursive members, linked source cards, reader shortcuts and
metadata persistence are integrated. Validation and outstanding hardening/runtime
qualifications are recorded below; this remains a local experimental feature,
not a declaration that every review finding or platform is acceptance-complete.

This is a deliberate local extension of `codegraph ui`, not a replacement for
Map, Symbol, Flow, Screens or Steps. The source-built Nix package carries the
isolated clickdummy at `/board-prototype.html` and the live view at `#/board`.
The live Board reads the served project's existing index; the clickdummy remains
synthetic, session-only and independent of the graph API.

## Design authority and reuse

The upstream [viewer specification](codegraph-ui-design-spec.md) explicitly
chooses one-symbol reading over node-link neighbourhood exploration. The owner
has authorized an exception for this separate Review Board view. In this patch
series, the board's scope and interactions are governed by this document.
Future sessions must not remove the board or reduce it to a single-symbol view
merely to satisfy the older specification.

The exception is narrow: freely positioned typed-symbol cards, an explicitly
selected relationship graph and multiple movable source cards are permitted here.
Existing reader views retain their existing interaction contracts. The board
still inherits the viewer's security boundaries, theme, source/navigation
facilities, confidence/provenance rules, stale-index handling and accessibility
principles. Reuse these implementations rather than creating parallel versions.

## Reviewer goal

Build a small mental model of a feature whose symbols are spread across several
folders. Start with useful classes or other code entities, inspect their typed
connections, deliberately add relevant targets and compare source without leaving
the picture. This is an exploratory review surface, not a diagram-authoring
application or an AI chat.

The [data model and exhaustive kind inventory](review-board-data-model.md) define
coverage: every current NodeKind and EdgeKind is in scope, with generic fallbacks
for future kinds. Classes/calls are a useful starting perspective, not a whitelist.
The decisions below supersede the first clickdummy's class/call-only graph and
automatically admitted direct neighbours.

The first version is generic and driven by the existing index. It must not
hard-code service names, a particular repository, dependency-injection framework
or language. It must not change extraction or fabricate missing connections to
make a diagram look complete.

## Confirmed product decisions

- Select starting points of any indexed kind by searching or choosing
  folders/namespaces, with kind/project/file labels and previewed selection size.
  The first live version serves one indexed project in one viewer process.
  Selections may cross any directories, namespaces and languages inside that
  index; cross-project selection/linking is deferred.
- Prefer compact type/container cards where useful; expand contained members of
  any kind, not only methods. Every symbol can also be independently pinned.
- Support every indexed relationship kind from the first production Board,
  with exact-kind filters, direction and evidence. Never relabel other kinds as
  calls; containment may be rendered by outlines instead of arrows by default.
- Grow the board through a Connections browser on cards and members: explicitly
  select targets, then Add/Restore/Locate. Adding does not admit the target's
  neighbours. Automatic context is off by default; an explicitly requested
  bounded preview is separate from included membership and never recursive.
- Hide is reversible through Undo hide, named Hidden items and Restore actions
  in Connections, retaining geometry and identity.
- Open new cards at the direct canvas click (slightly offset), or at the visible
  canvas centre for menu/sidebar/keyboard actions; overlap is allowed. Adding or
  expanding something must not rearrange the board or change pan/zoom. Tidy layout
  is an explicit action.
- Support pan, zoom, fit selection/board and a usable way back to readable code.
- Allow several movable, resizable, collapsible source cards on the board, so
  methods can be compared side by side.
- Save named boards locally under `.codegraph/ui/boards/`. Normal viewer mode
  permits saving/deleting that metadata. `--read-only` permits exploration and
  loading existing boards but refuses those filesystem writes.
- Support JSON export/import for moving a board. Save symbol identities and UI
  state, not copied source text, a stale graph snapshot or executable content.
- No Git-diff seeding or before/after graph comparison in version one.

### Single-project authority

One `codegraph ui /path/to/project` process serves that project's existing index
and owns boards under that same project's `.codegraph/ui/boards/`. Neither a
query nor imported board JSON can switch the root or authorize another index.
Imported identities are re-resolved only in the currently served index;
unavailable/ambiguous symbols remain placeholders. Separate viewer processes can
be run for separate projects, but there is no combined cross-project Board in
version one. This supersedes the earlier cross-project selection ambition.

## First-use experience

A new **Board** tab opens an empty canvas with an **Add symbols** action.
Search results identify exact kind, namespace/project and file, so repeated names
are distinguishable. Folder/namespace selection previews the number and kinds of
symbols before adding them; a huge folder must not unexpectedly flood the canvas.
Existing Symbol/File views can offer **Add to board** as an alternative to
abandoning the current board for another full-screen reader.

Only explicitly selected symbols enter the board. A class normally appears as a
compact type card; functions, values, files, routes and other kinds have appropriate
compact cards too. Show typed directional relationships between included endpoints,
with cycles represented rather than forced into an execution sequence. Unselected
targets remain discoverable in Connections, not automatically placed as neighbours.
Any optional context preview is visually distinct without relying on colour alone.
Evidence counts are indexed relationships/sites, never runtime execution frequency.

### Symbol and member interaction

- **Expand members** exposes a source-ordered, bounded member list of any indexed
  kind and attaches relevant typed edges to members. Collapse restores the folded
  picture without losing pinned members or independent source cards.
- **Connections…** on a card or member opens an incoming/outgoing browser with
  text search, relationship filters and grouped targets. Show the exact scope:
  a class plus its members versus a specific member; broader container-contents
  scopes are explicit and bounded.
- Each target is labelled **Not on board**, **Hidden**, **Folded in …** or
  **Pinned on board** and offers
  **Add to board**, **Restore** or **Locate**. Allow choosing several targets and
  **Add selected**. Merely listing, selecting for preview or reading a connection
  changes neither board membership nor the viewport arrangement. Following a
  target's Connections pushes a panel-local history entry; Back restores scope,
  direction, filters, selection and result scroll. Compact controls leave target
  rows visible even at laptop heights, with the current scope kept in view.
- Adding includes only chosen symbols, not their callers/callees, type neighbours
  or siblings. A member may be independently pinned or visually wrapped by its
  proven owner; do not silently include the owner as a separate graph node.
- **Hide** removes a symbol from view, not the index or discovery lists. Offer
  immediate **Undo hide** and a named Hidden items list. Restoring from that list
  or Connections recovers prior placement/expansion; a background query must not
  restore something the reviewer deliberately hid. A hidden independently pinned
  member is also marked Hidden in its owner's outline, with Restore and without
  ordinary edge handles. Locate opens the proven ownership path and highlights
  the exact nested member, without materializing every preceding sibling. The
  breadcrumb names that path; ambiguous ownership is not guessed.
- Clicking an aggregate edge opens supporting original relationships, endpoint
  member identities, source locations when present and provenance. Source can
  open in a card or the existing Symbol/File view, with a route back to the board.
- Right-button drag on empty canvas pans; starting on a card does not pan.
  Left-button drag on empty canvas draws an unfilled outline and selects every
  enclosed or touched card; Shift adds to the selection. The outline disappears
  on release, leaving only the individual cards selected. Plain click selects
  only that card, Shift-click toggles it, and an empty click clears selection. Symbol and source cards share one selection;
  dragging a selected header moves the group, while a plain click without a drag
  selects only the clicked card. Text selection, buttons and source scrolling
  must not start a canvas pan or node drag. Remember manually positioned nodes.

A large container's complete contents are not a useful default: prefer connected
members with an explicit, counted way to page/reveal the rest. Complete support
means no kind is excluded, not that every member is drawn immediately.

### Source cards

A code card identifies its symbol, owner when present and current file:line.
Cards are independent canvas items, not extra indexed graph nodes or code editors.
Move, resize, collapse, close and bring to front independently; scrolling a
card scrolls its source, not the board. Code links can open another card rather
than replacing the entire scene. Reopening an existing source card selects and
raises it without moving it or the viewport, even when it is off-screen. Selecting
a card highlights the related graph symbol/evidence on the diagram. A fit/read action makes a card readable after
zooming out.

**Open sibling sources** on callable symbol/member and source cards opens the other
methods of the nearest proven indexed type, or other top-level free functions in
the exact same file when there is no type owner. Nested local functions and
methods of unrelated types are not file siblings. Discovery respects the Board
filters, does not pin symbols, reuses existing source cards and preserves their
positions and the viewport. The entire batch must fit the existing 32-source-card
and 128-retained-identity limits; otherwise no partial batch is opened.

Source cards have their own typed relationship layer, never connections to symbol
cards. Only relationships originating in a callable (including its parameters or
local values) are eligible; imports, exports, containment and class/file-header
dependencies are excluded. Endpoints attach to the nearest open, verified source
card in their proven ownership path, preferring an individual method over its
open class. Original evidence, uncertainty, synthesis and exact kinds remain
inspectable. Each distinct indexed site leaves the right-hand source-line dot
and arrives on the target card's left edge at the original target declaration
line, including a method inside a whole-class card. Separate call sites are not
merged merely because their cards match. Scroll/resize measurements use actual
rendered rows in card-local coordinates, independently of board zoom, and do not
refetch source or graph. Above/below-viewport endpoints use labelled line-number
markers; activating a marker reveals that line, including on another source
page. Several hidden lines can share a counted marker without merging their
identities. Relationships without an indexed site remain inspectable in links,
not attached to guessed lines. Source-only identities do not seed the symbol
diagram. Unverified, drifted or current-file bytes do not acquire source-card
arrows.

Class and function source cards load reference/evidence pages automatically in
sequential batches of at most 64 requests (32 targets or 200 evidence items per
request). A recoverable evidence-preview cap is rechecked through the full
evidence endpoint rather than permanently disabling links. Larger scopes have an
explicit continuation; hard containment bounds, unknown exclusions, ambiguous
token targets and changed source still withhold inline precision. The focused
`scripts/check-board-source-browser.mjs` exercises whole-class links across target
pages, class/file siblings and the independent arrow layers against a throwaway
real index; `CODEGRAPH_BOARD_EXECUTABLE` can select an installed Nix viewer and
`CODEGRAPH_BOARD_ARTIFACT_ROOT` keeps evidence in a chosen task directory.

Fetch source on demand through the existing source API and reuse syntax
classification and highlighting. Show current disk source with the existing
drift treatment; do not keep obsolete line-anchored edges attached to changed
source. The viewer remains unable to edit source in either mode.

## Graph semantics and boundaries

The board needs a selected-subgraph projection, not the directory Map's
aggregation and not Flow's shortest connecting path.

1. Resolve explicit seed identities of every supported kind and their actual
   containment where needed for folding; membership is independent of discovery.
2. Query existing incoming/outgoing edges across all kinds in batches. Provide a
   separately paged Connections query that includes hidden/not-on-board targets
   without inserting them into the canvas.
3. Project edges between included endpoint representatives, preserving exact
   symbols and ownership paths behind any optional folding. Group by relation
   kind and retain mixed provenance; never flatten all edges to calls.
4. Return evidence with original endpoint/member identities, exact kind, source
   location when available, confidence and synthesis/wiring metadata. Make missing
   or inaccessible targets explicit boundaries rather than silent omissions.
5. Reveal member-level relationships on expansion or independent pinning without
   double-counting the same evidence at owner and member levels. Within-owner
   relationships can fold into a counted, typed self-relationship.

Use containment/identity evidence, not suffixes such as `Service` or `Factory`,
to decide ownership. Handle nested symbols and overloads deliberately. Do not
merge same-named symbols across projects, or partial declarations across files,
without enough identity evidence. Free functions/values remain their own kinds;
a visual file/module wrapper is not an invented class or implicitly included node.

Do not assume the existing Symbol API is an exhaustive graph API. Its containment
outline, type-use chips, grouped rails and caps are reader-specific projections.
Reuse low-level queries, security and serialization, but define a complete,
bounded Board connection/evidence contract without changing existing readers.

An interface-typed call is not proof of a particular runtime implementation.
Preserve interface boundaries and all ambiguity. A uniquely supported
interface-to-implementation bridge may be presented compactly, but remains a
marked, inspectable path of existing edges, not a newly asserted direct call.
Multiple candidates must not be silently reduced to the nearest class name.

Type references, construction, inheritance, imports, navigation, decoration and
containment are first-class indexed relationships, not deferred Board features.
A `references` edge does not by itself distinguish reads from writes, and a
`returns` edge describes a return type, not runtime data flow. Do not invent new
edge semantics. See the complete kind inventory for individual filter groups.

Tests and generated code are filtered initially with explicit controls/counts;
Connections can include them deliberately. Weak/name-only edges, unresolved
references and outside-index targets retain the existing uncertainty/boundary
treatment. Large hubs require bounded/paged connection, member and evidence
lists, with truthful totals and continuation/**Show more**, never silent drops.

## Layout, state and persistence

Separate **what is selected**, **what the index currently says** and **how the
reviewer arranged it**. Panning, dragging and reading source should not query
or rewrite the graph. Placement is not a constantly running physics simulation.
Direct on-card openings use the click location; menu/sidebar/keyboard openings use
visible canvas centre (small deterministic offsets distinguish batch additions).
Overlap is permitted and existing placements are retained; only explicit Tidy is
allowed to re-layout it all.

A versioned board file records name, explicitly included project-scoped symbol
identities of any kind, hidden items, expansion/preview/filter settings, node/card
positions and sizes, source-card identities/z-order and viewport. Source text and
graph edges are not persisted.
Use qualified name + kind + file and signature/owner evidence to re-resolve
symbols; node IDs and line numbers are hints, not durable identity. Preserve
missing/ambiguous entries as labelled placeholders instead of replacing them
with fuzzy matches. A fresh graph response updates facts without resetting
layout or silently overwriting the saved board.

The initial save workflow is explicit **Save / Save as**, with an unsaved-changes
indicator and a warning before losing changes. No save-on-every-drag filesystem
writes. Imported files are untrusted data: validate version, size, finite geometry,
allowed identities and cardinality; reject unsupported versions without repair.
Restore live graph/source only for symbols the current project/index permits.

Reuse the trail store's validated project-path access, atomic replacement and
bounded-file patterns. Server writes are restricted to board metadata; preserve
Host/Origin/marker-header checks and reject all board mutations in read-only
mode. Export/import does not authorize arbitrary paths, source writes, indexing
or Git operations. Exported identities and paths may still be private project
information; exporting is explicit, not network publication.

## Implemented V1, validation and limits

All agreed single-project functionality is integrated:

- Search all kinds by name/kind/relative path; preview indexed folder and exact
  namespace scopes with totals/by-kind counts, then choose individual or bounded
  batch additions. Symbol, file-outline and whole-file readers offer Add to board.
- Default-off test/generated/uncertain controls apply to discovery, member pages
  and relationships, with exact, disjoint exclusion reasons. Explicit cards stay
  present; filtering never silently changes membership or claims runtime counts.
- Connections pages preserve submitted criteria independently of unsubmitted
  text; Back restores scope, direction, filters, selection and scroll. Target
  windows and ten-entry history keep discovery bounded. Newly observed kinds
  remain filterable, including when an exact-kind page is empty.
- Recursive, source-ordered member outlines support exact-path Locate, paging,
  independent pinning and persistent inline hide/restore. A hidden unpinned member
  is not promoted to a graph card when restored. Visible ports attach to the
  deepest proven row; ambiguous/cyclic ownership remains an explicit boundary.
- Independent source cards follow indexed references into other cards, show
  paged raw evidence, highlight related original endpoints and preserve drift
  safety. Current-file reading drops indexed markings. Source and link requests
  are lazy; geometry/selection-only updates do not refetch them. Native size
  controls and keyboard resizing coexist with move/collapse/close and Fit actions.
- Save/Save as/Open/Delete and JSON import/export retain recipes only. Exact
  re-resolution supports shifted lines, missing/ambiguous placeholders and
  source-only identities. Unsaved Board state survives reader-tab navigation.

The reusable UI exports the Board, its pure model and wire types. All Board
adapter methods and the navigation driver's Board address are optional for older
hosts; missing operations are explained/disabled. Metadata writes retain
Host/Origin/marker checks. Read-only mode permits loading and in-memory resolution
but refuses Save/Delete. Imported identities cannot switch project authority.
Strict validation and no-follow/atomic storage remain in force; interrupted
writes can leave `.write.lock`, which requires operator inspection before removal.

Identity facts and eligible membership are separate: projection `scopeIds` and
paged member IDs describe eligibility; `symbols` may carry extra ancestor context.
Restoration projects **only included identities**, so expanded/hidden/source-only
context cannot seed otherwise-filtered branches. Eligible counts never expand
merely because old discovery facts remain cached. Retained/requested outline rows
outside the current filter/page are labelled separately from eligible totals.

Bounds remain explicit: 128 retained identities (including expanded/hidden and
source-only identities), 32 source cards, 2,048 symbols per projection contains
scope, 64 containment levels, 2,048 ancestor identities and 5,000 projection
relationships. Each outline reveal is capped at 2,048 eligible rows; Connections
can inspect/pin the remainder without making a recipe unsaveable. Discovery-only
facts have a 16K cache target, with current/retained/displayed facts protected.
Search, groups, targets, members, source and evidence requests are paged/bounded;
exact broad search/group counts can still scan indexed data. An expanded outline
can exceed the current viewport: pan or explicitly Fit, without moving cards.
This is not arbitrary-size whole-repository rendering.

Validation is reproducible through the full `npm test` suite, Svelte/TypeScript
checks, reusable-library pruning, `nix build .#codegraph` install checks and
`scripts/check-board-browser.mjs`. On headless NixOS use
`nix develop -c env TERM=xterm-256color npm test`; the shell includes archive-test
tools, and launcher fixtures admit `dirname` without admitting host Node.
The browser script uses throwaway TypeScript/C#/Python code, writable/read-only
viewers, a 700-member hub, keyboard/focus and source-scroll checks, and repeated
projection/Connections timing samples. Set `CODEGRAPH_BOARD_EXECUTABLE` to an
installed Nix executable to test its immutable viewer assets instead of `dist`.

A separate read-only private C# review exercised more than 25 actions across
folders, nested members, two source cards, Add/Pin, Restore and Back. Logical
node/edge/file hashes and existing UI metadata were unchanged. Its 24 measured
requests had projection p95 below 15 ms and Connections p95 below 50 ms. Private
artifacts remain outside this repository. That session spanned UI rebuilds and
its native wheel check was inconclusive; the isolated generic browser check
covers scrolling and the immutable-package workflow separately.

Runtime validation is **x86_64 Linux / managed Chromium**. Windows/ARM64 runtime
and native screen-reader sessions have not been exercised; automated accessible
labels/keyboard/focus and Svelte diagnostics are not substitutes for those claims.
Cross-project boards and the deliberately deferred items below remain out of V1.

## Reviewer follow-up and remaining qualifications

The local fixes separate metadata permission from graph permission: every viewer
connection opens SQLite read-only, including normal metadata-saving mode. A
SELECT-only readiness check refuses incompatible schemas and interrupted bulk-load
states, without migrating or repairing them; ordinary concurrent library/MCP
readers keep their existing permissive contract. Logical contents/schema and live
WAL bytes are covered independently of main-file hashing or graph counts.

Board projection uses a marker-gated, byte-bounded JSON POST so long valid
selections do not exceed HTTP header limits; GET/HEAD remain compatible. Signature
identity preserves bounded tabs and line breaks exactly. Exact hidden inline
identities restore without requiring a guessed owner or becoming independent pins.
Source-token links wait for complete, uncapped evidence without unknown exclusions;
explicit targets remain navigable while pages are incomplete.

Save/Delete ordering and matching Open/refresh invalidation prevent stale saved
bindings. Refresh preserves in-flight Save/Save-as receipts. Completed Connections
criteria/results are atomic; Back restores the completed context and keeps text
drafts separate, refetching entries that never completed. New/replacement reset
clears recipe/discovery caches and stale continuations, exclusions replace rather
than merge, and unavailable evidence paging is disabled and explained.

Mounted regressions compare identities rather than generated keys, including moved,
missing and ambiguous resolutions, source-only cards, positions, visibility,
member limits, source dimensions/collapse/z-order and viewport. The generic browser
walkthrough also checks real pointer drag/pan, trusted native wheel zoom, resized
and collapsed card round-trips, and focus after restoring the final hidden row.
Installed-package checks compare logical schema/content and DB/WAL bytes in both
metadata modes and verify the wrapper's actual selected Node executable/version.
The post-review x86_64-linux run passed 9,017 tests with 416 skips,
zero Svelte errors/warnings, the pruned reusable-library build, offline source-built
Nix package/flake checks, and the complete installed-package browser walkthrough.

Remaining qualifications are explicit, not claimed fixed:

- Concurrent local directory replacement can still race pathname-based board
  storage; leaf no-follow checks and atomic publication do not pin ancestors.
  Browser actions/imports alone cannot perform that replacement, and the default
  private single-user deployment limits the practical threat. Descriptor-capability
  storage and a changed-project-root authority policy remain deferred; no Linux-only
  persistence restriction was introduced. Hostile shared-filesystem use is not claimed.
- The locked Nix runtime is Node 24.21.0 (observed OpenSSL 3.5.9), while the
  bundle's version floor is 24.22.1. Complete security-backport coverage is unverified;
  a version mismatch is not proof of vulnerability. Runtime selection is now tested,
  but no unsupported security claim, source download or runtime repin was made.
- Windows/ARM64 runtime and native screen-reader qualifications still apply.

## Implementation sequence

### 0. Interaction clickdummy (implemented; review before live integration)

`ui/board-prototype.html` is a separate entry that mounts neither the live App
nor its graph adapter. Its mixed-symbol fixture covers every current node/edge
kind plus unknown-kind fallbacks, source/metadata cards, a callback cycle and
separate interface/implementation identities. Nothing is persisted. It reuses
Svelte Flow, kind glyphs, SourceBlock and the viewer theme, and is pruned from
the reusable UI library package.

Open `/board-prototype.html` on the source-built viewer server. For development
without any project index:

```bash
# The dev shell prepares the locked root/UI npm dependencies offline.
nix develop -c bash -c 'cd ui && node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5176 --strictPort'
# Open http://127.0.0.1:5176/board-prototype.html
```

Review explicit target selection, kind/direction filters, dragging, member
expansion, typed evidence, restoration and movable/resizable source cards before
implementing the real data projection. Use the prototype to revise interactions;
do not treat its hard-coded positions, fixture graph or display counts as a
production graph/layout implementation. Its HTTP packaging and model tests do
not substitute for actual browser interaction checks.

The revised prototype includes the all-kind card families and typed Connections
browser, individual/batch target inclusion, independently pinned members, Locate,
named Hidden items and Undo/Restore. No automatic context is admitted. Kind gallery
explicitly selects one representative of each kind plus an unknown-kind fallback;
the normal example starts with just three chosen classes. Parallel relation kinds
use separate labelled lanes and ownership arrows are opt-in. Catalogue/model tests
cover all kinds; browser checks accompany model tests for interactions. This remains
a synthetic clickdummy, not proof of live-index/API completeness.

### 1. Read-only symbol projection and evidence (implemented)

Add a shared derivation under `src/graph/` (proposed `board-projection.ts`) with
bounded inputs and batched node/edge access. Define explicit membership, optional
preview roles, all-kind member ownership, typed aggregation, uncertainty and
evidence contracts before rendering. Add read-only endpoints under
`src/ui-server/api/` for selection, projection, paged Connections and evidence.
Keep projection usable without the browser. Do not alter global
extraction/resolution or existing Map/Flow answers.

Proof: catalogue-driven fixtures cover every NodeKind and EdgeKind, with unknown
kind fallbacks. Include classes in one file/directory, cross-folder relations,
standalone functions/values, containers, routes, bindings, cycles/self-relations,
overloads, interfaces with one/many implementations, repeated names, mixed edge
kinds between a pair, hidden tests/generated code and paged hubs. Test incoming
and outgoing discovery of hidden/unselected targets, member scope and exact
filtering. Every displayed relationship must trace back to indexed evidence.

### 2. Basic board as a new viewer route (implemented)

Add `ui/src/views/ReviewBoardView.svelte`, a board model/state store and shared
symbol-card families under `ui/src/components/board/`. Reuse `@xyflow/svelte`,
theme tokens, kind glyphs, search, navigation and live-index notifications. Add
Board routing and optional adapter capabilities so other hosts of the reusable
components do not break merely because they do not implement boards yet.

Deliver all-kind selection across folders/namespaces, explicitly included cards,
typed directional aggregate edges, pan/zoom, automatic initial placement, free
dragging and explicit Tidy/Fit. Validate on a real review before expanding the
feature; do not call a class-only implementation complete.

### 3. Incremental Connections and member detail (implemented)

Add all-kind incoming/outgoing connection browsing, individual/batch target
inclusion, Restore/Locate, Undo hide, named hidden items, member expansion/collapse
and evidence inspection. Preserve layout and existing selections throughout.
Add no neighbours automatically; any context preview is an explicit extra action.
Reuse existing traversal/cycle/identity helpers where contracts fit; do not force
the directory-specific Map layout to serve a different ownership model. Add
keyboard-accessible controls and sensible focus restoration.

### 4. Multiple source cards (implemented)

Compose reusable source/highlight/drift facilities into canvas source cards.
Support move/resize/collapse/close, evidence/source navigation and readable fit.
For entities without a meaningful source body, show the indexed declaration or
registration/metadata and source links, not a fabricated method implementation.
Ensure code selection/scrolling and canvas dragging do not fight. Keep source
requests bounded and lazy, and verify multiple open cards under pan/zoom.

### 5. Named project-local boards (implemented)

Add versioned board store/API and Save/Save as/Open/Delete/export/import. Extend
the adapter with optional persistence capabilities. Share low-level persistence
safeguards with trails where useful without coupling their different data models.
Cover read-only behaviour, malformed imports, path/symlink refusals, atomic saves,
name collisions, missing/renamed symbols and re-indexing with shifted line numbers.

### 6. Acceptance, documentation and local distribution (Linux validation)

Run targeted graph/API/model/component tests and the existing Map/Symbol/Flow,
source/drift, security, navigation and reusable-UI contract regressions. Build
through the Nix flake; extend installed-viewer checks for the board endpoints and
metadata-only save/read-only refusal. Perform actual browser interaction checks
for board movement, expansion, cards and reloads; HTTP smoke tests alone do not
establish usability.

Use a private real-world review checkout as manual acceptance evidence, without
committing its code, names, screenshots or generated board files into this
upstream-derived repository. Include a small unrelated-language fixture to
verify the generic fallback. Measure response/payload growth and interaction
responsiveness on a modest and a hub-heavy board. Report platform checks actually
performed; do not infer Windows/ARM64 success from Linux evaluation.

Only after feature acceptance, update the consumer Nix pin through a separately
reviewed change. Do not publish, modify upstream or activate the system as part
of this plan. Keep generic commits separable for a possible contribution; upstream
acceptance is uncertain because this deliberately departs from its current UX.

## Acceptance walkthrough

1. Add related types plus a function/value or other kind from another folder to
   a new board; no neighbours are admitted automatically.
2. Browse a class's Connections and an individual member's Connections, in both
   directions. Filter calls, types, construction, module links and other kinds
   without losing exact semantics, scope, counts or continuation.
3. Select one or several listed targets to add; only those symbols appear. Locate
   an existing target without duplication. Hide a connected symbol and restore
   it directly from Connections or Hidden items; test Undo hide and retained
   placement with automatic context off.
4. Expand a container/type, pin a member independently, inspect typed evidence
   and open two source cards side by side without double-counting relationships.
5. Drag/resize cards, collapse the owner, pan and zoom without losing the scene.
6. Exercise fixtures for every current node/edge kind, plus unknown-kind fallback,
   parallel relationship kinds, containment outlines/drawing and filtered edges.
7. Save a named board, close the viewer and reopen with all-kind identities,
   relation filters, hidden membership, layout and source cards restored.
8. Re-index after adding lines above a symbol: restore its identity, not an
   obsolete node ID. Mark deleted/ambiguous symbols rather than guessing.
9. Open read-only: exploration still works, but Save/Delete are visibly disabled
   and equivalent mutation requests are refused by the server.
10. Confirm Map, Symbol and Flow still behave as before, and neither board mode
    writes source files or runs Git/indexing operations.

## Deliberately deferred

Cross-project selection/linking; Git-diff seeding/graph comparison; AI-authored explanations; framework-specific
runtime/data-flow reconstruction; collaborative editing; arbitrary drawn arrows,
notes or diagram shapes; browser-hosted remote services; source editing; and
automatic repository changes. Static exports beyond board JSON can follow the
core interaction work rather than delaying the reviewer workflow.
