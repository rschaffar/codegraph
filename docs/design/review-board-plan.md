# Local Review Board: design and implementation plan

Status: interactive sample-data clickdummy implemented; live-index board and
persistence not started.

This is a deliberate local extension of `codegraph ui`, not a replacement for
Map, Symbol, Flow, Screens or Steps. The source-built Nix package carries the
isolated clickdummy at `/board-prototype.html`; the production functionality
planned below does not ship yet.

## Design authority and reuse

The upstream [viewer specification](codegraph-ui-design-spec.md) explicitly
chooses one-symbol reading over node-link neighbourhood exploration. The owner
has authorized an exception for this separate Review Board view. In this patch
series, the board's scope and interactions are governed by this document.
Future sessions must not remove the board or reduce it to a single-symbol view
merely to satisfy the older specification.

The exception is narrow: freely positioned component/method nodes, a selected
neighbourhood graph and multiple movable source cards are permitted here.
Existing reader views retain their existing interaction contracts. The board
still inherits the viewer's security boundaries, theme, source/navigation
facilities, confidence/provenance rules, stale-index handling and accessibility
principles. Reuse these implementations rather than creating parallel versions.

## Reviewer goal

Build a small mental model of a feature whose classes are spread across several
folders. Start with a few useful components, see who calls whom, bring relevant
neighbours into focus and compare source without leaving the picture. This is
an exploratory review surface, not a diagram-authoring application or an AI chat.

The first version is generic and driven by the existing index. It must not
hard-code service names, a particular repository, dependency-injection framework
or language. It must not change extraction or fabricate missing connections to
make a diagram look complete.

## Confirmed product decisions

- Select starting points by searching for classes/functions or by choosing
  folders/namespaces. Selections may cross directory/project boundaries.
- Default to component/type-level nodes; expand individual components to methods
  and collapse them again without losing the rest of the board.
- Default arrows represent calls. Other dependency kinds must not silently
  masquerade as calls; richer relation filters can be added later.
- Show direct incoming/outgoing neighbours as muted context. Adding a neighbour
  to focus makes it part of the main selection and admits its own direct context.
- Automatically lay out the initial selection, then allow free dragging. Adding
  or expanding something must not rearrange the whole board. Tidy layout is an
  explicit action.
- Support pan, zoom, fit selection/board and a usable way back to readable code.
- Allow several movable, resizable, collapsible source cards on the board, so
  methods can be compared side by side.
- Save named boards locally under `.codegraph/ui/boards/`. Normal viewer mode
  permits saving/deleting that metadata. `--read-only` permits exploration and
  loading existing boards but refuses those filesystem writes.
- Support JSON export/import for moving a board. Save symbol identities and UI
  state, not copied source text, a stale graph snapshot or executable content.
- No Git-diff seeding or before/after graph comparison in version one.

## First-use experience

A new **Board** tab opens an empty canvas with an **Add components** action.
Search results identify type/function, namespace/project and file, so repeated
names are distinguishable. Folder/namespace selection previews the number of
components before adding them; a huge folder must not unexpectedly flood the
canvas. Existing Symbol/File views can offer **Add to board** as an alternative
to abandoning the current board for another full-screen reader.

An added class appears as a compact component card. Its direct callers are
initially placed to the left and callees to the right, with cycles explicitly
represented rather than forced into a false execution sequence. Main-focus
cards and muted context cards are visually distinct without relying on colour
alone. Edges are directional and have distinct method-call/call-site counts.
Neither count should ambiguously claim to be runtime execution frequency.

### Component interaction

- **Expand methods** exposes a source-ordered, bounded member list and attaches
  relevant call edges to methods. Collapse restores the component-level picture.
- **Add to focus** promotes a context component; merely selecting or reading one
  does not silently expand the focus set.
- **Explore callers/callees** grows only the chosen neighbourhood. No automatic
  recursive expansion or whole-repository rendering.
- **Hide** removes a component from the current view without erasing graph data.
  Hidden-connection indicators remain inspectable; a hidden node should not
  immediately reappear when the next neighbour query completes.
- Clicking an aggregate edge opens its supporting method pairs and call sites.
  Opening one can put the relevant source into a code card or navigate to the
  existing Symbol/File view. Keep a route back to the board.
- Drag a component by its header. Text selection, buttons and source scrolling
  must not start a canvas pan or node drag. Remember manually positioned nodes.

Expansion controls and source cards need a prototype before polishing. A list
of every member on a large class is not a useful default: prefer connected
members with an explicit, counted way to reveal the rest. Collapsing must not
lose individually selected methods or pinned code cards.

### Source cards

A code card identifies its symbol, owning component and current file:line.
Cards are independent canvas items, not extra call-graph nodes or code editors.
Move, resize, collapse, close and bring to front independently; scrolling a
card scrolls its source, not the board. Code links can open another card rather
than replacing the entire scene. Selecting a card highlights its owner/call
site on the diagram. A fit/read action makes a card readable after zooming out.

Fetch source on demand through the existing source API and reuse syntax
classification and highlighting. Show current disk source with the existing
drift treatment; do not keep obsolete line-anchored edges attached to changed
source. The viewer remains unable to edit source in either mode.

## Graph semantics and boundaries

The board needs a selected-subgraph projection, not the directory Map's
aggregation and not Flow's shortest connecting path.

1. Resolve explicit seed components and their contained callable members.
2. Read existing incoming/outgoing call edges in batches.
3. Project callable endpoints to their proven owning types/components and gather
   one hop of context around the explicit focus set, not around context again.
4. Return aggregate edges with access to original edges, method identities,
   call-site locations, confidence and synthesized-dispatch provenance.
5. Reveal those same member-level relationships on expansion without counting
   an expanded relationship again at both class and method levels.

Use containment/identity evidence, not suffixes such as `Service` or `Factory`,
to decide ownership. Handle nested types and overloads deliberately. Do not
merge same-named types across projects, or partial declarations across files,
without enough identity evidence. Free functions remain useful nodes in
languages without classes; file/module ownership is a labelled fallback rather
than an invented class.

An interface-typed call is not proof of a particular runtime implementation.
Preserve interface boundaries and all ambiguity. A uniquely supported
interface-to-implementation bridge may be presented compactly, but remains a
marked, inspectable path of existing edges, not a newly asserted direct call.
Multiple candidates must not be silently reduced to the nearest class name.

Call mode does not imply type references, construction (`instantiates`), field
reads, inheritance or data-flow. Where those relationships matter, identify the
boundary rather than generating a false call edge. Within-component calls can
fold into a counted self-relationship until methods are expanded.

Tests and generated code are hidden initially with explicit filters/counts.
Weak/name-only edges, unresolved calls and outside-index targets retain the
existing uncertainty/boundary treatment. Large hubs require bounded/paged
context and evidence lists, with totals and **Show more**, never silent drops.

## Layout, state and persistence

Separate **what is selected**, **what the index currently says** and **how the
reviewer arranged it**. Panning, dragging and reading source should not query
or rewrite the graph. Initial layout is deterministic, not a constantly running
physics simulation. Place newly revealed items near their owner while retaining
hand-positioned content; only explicit Tidy is allowed to re-layout it all.

A versioned board file records name, focus identities, explicitly added context,
hidden items, expansion/filter settings, node/card positions and sizes, card
identities/z-order and viewport. Source text and graph edges are not persisted.
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

## Implementation sequence

### 0. Interaction clickdummy (implemented; review before live integration)

`ui/board-prototype.html` is a separate entry that mounts neither the live App
nor its graph adapter. It uses ten synthetic classes, source snippets, a cycle
and an explicitly labelled interface bridge. Nothing is persisted. It reuses
Svelte Flow, kind glyphs, SourceBlock and the viewer theme, and is pruned from
the reusable UI library package.

Open `/board-prototype.html` on the source-built viewer server. For development
without any project index:

```bash
nix develop -c npm ci --ignore-scripts
nix develop -c bash -c 'cd ui && node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5176 --strictPort'
# Open http://127.0.0.1:5176/board-prototype.html
```

Review selection/promotion, context filtering, dragging, method expansion,
edge-evidence comparison and multiple movable/resizable source cards before
implementing the real data projection. Use the prototype to revise interactions;
do not treat its hard-coded positions, fixture graph or display counts as a
production graph/layout implementation. Its HTTP packaging and model tests do
not substitute for actual browser interaction checks.

### 1. Read-only component projection and evidence

Add a shared derivation under `src/graph/` (proposed `board-projection.ts`) with
bounded inputs and batched node/edge access. Define selection, focus/context
roles, member ownership, aggregation, uncertainty and evidence contracts before
rendering. Add read-only endpoints under `src/ui-server/api/` for selection,
projection and paged edge evidence. Keep projection usable without the browser.
Do not alter global extraction/resolution or existing Map/Flow answers.

Proof: synthetic fixtures for several classes in one file/directory, cross-folder
calls, free functions, cycles, self-calls, overloads, interfaces with one/many
implementations, repeated names, hidden tests/generated code and truncated hubs.
Every displayed edge must trace back to indexed evidence.

### 2. Basic board as a new viewer route

Add `ui/src/views/ReviewBoardView.svelte`, a board model/state store and component
nodes under `ui/src/components/board/`. Reuse `@xyflow/svelte`, theme tokens,
kind glyphs, search, navigation and live-index notifications. Add Board routing
and optional adapter capabilities so other hosts of the reusable components do
not break merely because they do not implement boards yet.

Deliver selection across folders/namespaces, focus/context rendering, directional
aggregate edges, pan/zoom, automatic initial placement, free dragging and explicit
Tidy/Fit. Validate this slice on a real review before expanding the feature.

### 3. Incremental exploration and method detail

Add promotion, hide/show, incoming/outgoing expansion, member expansion/collapse
and evidence inspection. Preserve layout and existing selections throughout.
Reuse existing traversal/cycle/identity helpers where contracts fit; do not force
the directory-specific Map layout to serve a different ownership model. Add
keyboard-accessible controls and sensible focus restoration.

### 4. Multiple source cards

Compose reusable source/highlight/drift facilities into canvas source cards.
Support move/resize/collapse/close, call-site navigation and readable fit. Ensure
code selection/scrolling and canvas dragging do not fight. Keep source requests
bounded and lazy, and verify multiple open cards under pan/zoom.

### 5. Named project-local boards

Add versioned board store/API and Save/Save as/Open/Delete/export/import. Extend
the adapter with optional persistence capabilities. Share low-level persistence
safeguards with trails where useful without coupling their different data models.
Cover read-only behaviour, malformed imports, path/symlink refusals, atomic saves,
name collisions, missing/renamed symbols and re-indexing with shifted line numbers.

### 6. Acceptance, documentation and local distribution

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

1. Add two related types and a third type from another folder to a new board.
2. See their calls together and muted direct neighbours without unrelated code.
3. Promote a useful neighbour and hide a noisy one; both choices survive refresh.
4. Expand one class, inspect a method edge and open two source cards side by side.
5. Drag/resize cards, collapse the class, pan and zoom without losing the scene.
6. Save a named board, close the viewer and reopen it with layout/cards restored.
7. Re-index after adding lines above a method: restore the same symbol, not an
   obsolete node ID. Mark deleted/ambiguous symbols rather than guessing.
8. Open read-only: exploration still works, but Save/Delete are visibly disabled
   and equivalent mutation requests are refused by the server.
9. Confirm Map, Symbol and Flow still behave as before, and neither board mode
   writes source files or runs Git/indexing operations.

## Deliberately deferred

Git-diff seeding/graph comparison; AI-authored explanations; framework-specific
runtime/data-flow reconstruction; collaborative editing; arbitrary drawn arrows,
notes or diagram shapes; browser-hosted remote services; source editing; and
automatic repository changes. Static exports beyond board JSON can follow the
core interaction work rather than delaying the reviewer workflow.
