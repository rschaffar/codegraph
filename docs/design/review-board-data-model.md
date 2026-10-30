# Review Board: graph model and complete kind coverage

Status: the sample-data clickdummy and implemented single-project V1 Board
support this kind inventory and explicit Connections workflow. Companion to
[the Review Board plan](review-board-plan.md), which records validation evidence
and platform/size limits. All-kind presentation does not guarantee that every
language extractor discovers every real relationship.

## Engine model versus board presentation

CodeGraph is a directed, typed symbol graph, not just a class/call graph.
`src/types.ts` is the authoritative catalogue (`NODE_KINDS`, `EDGE_KINDS`). At the
current local revision there are 23 node kinds and 13 edge kinds.

- A **Node** identifies a code entity: opaque ID, kind, name, qualified name,
  source file/language/range, and optional signature, documentation, visibility
  and other attributes. A node need not be a class or have a callable body.
- An **Edge** connects a source node to a target node with an exact relationship
  kind, optional source location, metadata and provenance. Different kinds and
  multiple evidence locations must not be collapsed into a fictitious call.
- A **FileRecord** tracks a file's index/hash/timestamps, language, generation
  status and extraction errors. It is not a second kind of diagram node; a
  `file` Node is the graph entity for a file.
- A **Subgraph** is a selection of nodes, edges and roots. The Board adds
  reviewer-owned selection, folding, filters, geometry, source cards and viewport;
  those presentation choices are not changes to the indexed graph.

Version one is single-project: the viewer process's indexed root scopes every
symbol and saved board. Folders/namespaces are selection or layout conveniences,
not new engine node kinds. Imported identities cannot select another project;
only the current index is queried. Cross-project boards are deferred, and
connections between indexes must never be inferred just because names match.

## All node kinds, with a small set of card families

Every indexed node kind must be searchable, addable, inspectable and usable as a
Connections endpoint. These families share renderer behaviour; they are not a
new taxonomy replacing `NodeKind`. Every card keeps its exact kind badge.

| Card family | Engine node kinds | Presentation |
| --- | --- | --- |
| Containers | `file`, `module`, `namespace` | Compact scope card; bounded, source-ordered contents and member expansion. |
| Types | `class`, `struct`, `interface`, `trait`, `protocol`, `enum`, `union`, `type_alias` | Type-specific label; expandable contained members where indexed, with inheritance/type connections. |
| Callables | `function`, `method` | Signature, source location, incoming/outgoing connections and source action; standalone or within a proven owner. |
| Values and members | `property`, `field`, `variable`, `constant`, `parameter`, `enum_member` | Name, declaration/signature/type when available, source action and connections; compact rows by default, independently pinnable. |
| Framework entities | `route`, `component` | Exact kind and indexed registration/declaration; show handler/member connections when present, without inventing a callable body. |
| Bindings | `import`, `export` | Binding/declaration card with module/symbol connections and source location; standalone or in a container outline. |

An indexed `component` is not a synonym for every class-shaped card. Likewise,
a screen, database operation, queue or runtime object is not an additional
`NodeKind` just because an existing viewer can derive a useful picture of it.
Use the indexed node and evidence; do not manufacture entities for this Board.

Folding by ownership is optional presentation. A nested method, property, enum
member or parameter can be independently pinned; do not force the entire owner
onto the board. A root function remains a function, not a fabricated class.
Containment determines expansion, not a class-only list of eligible members.
A generic symbol card must render future/unknown kind strings with their raw
kind label and available attributes instead of silently dropping them.

## All relationship kinds

All rows below are in scope, individually filterable and browsable in both
directions. Group names are UI conveniences, not replacement edge kinds.

| Filter group | Engine edge kinds | Meaning and presentation |
| --- | --- | --- |
| Behaviour | `calls`, `instantiates` | Invokes a callable; creates a class instance. Keep these meanings distinct. |
| Types and inheritance | `extends`, `implements`, `overrides`, `type_of`, `returns` | Extends/implements a type, overrides a member, uses a declared type or returns a type. A return-type edge is not runtime value flow. |
| Usage | `references`, `decorates` | Other symbol usage, or an applied decorator/annotation. A generic reference is not proof of a call, read or write. |
| Modules | `imports`, `exports` | Module/file/symbol dependencies as actually indexed. |
| Navigation | `navigates` | Navigation to an indexed screen/route target. |
| Structure | `contains` | Parent/child ownership, usually shown by the outline; also inspectable in Connections and drawable explicitly. |

The Connections browser defaults to an **All relationship kinds** option; presets
must not make any kind permanently inaccessible. Canvas filters may declutter the
selected subgraph, with visible filter state. Structure is normally expressed by
folding/expansion rather than extra arrows, but must not be discarded from the
model. Mixed relation kinds need separate labelled edges or an explicit mixed
summary with per-kind counts, never an undifferentiated "calls" arrow. Preserve
future/unknown edge kinds with their raw label, filtering and evidence instead
of dropping them through an exhaustive-looking renderer switch.

Provenance is independent of kind. A callback, event bridge or interface dispatch
can be represented by heuristic edges plus metadata rather than a special edge
kind. Reuse the existing confidence, synthesized-mechanism and wiring-site
presentation; preserve ambiguity instead of claiming a runtime target is known.

## Connections: explicit inclusion, not automatic expansion

- Every graph card and expanded member exposes **Connections…**. A class/type
  scope includes its own relationships and those of its contained members,
  clearly labelled; an individual member scope uses that member's identity.
  Broader file/module/namespace contents are an explicit, bounded scope choice.
- The panel offers **Outgoing / Incoming**, text search, exact-kind filters and
  grouped target rows. Show target kind, owner/project/file, relationship kinds,
  supporting member pairs and evidence counts. Counts are indexed facts, not
  runtime execution frequency. Paging must retain scope and filters. Following a
  target's Connections preserves a panel-local Back path including scroll and
  selection; compact fixed controls must leave visible room for results.
- Rows distinguish **Not on board**, **Hidden**, **Folded in …**, and **Pinned on
  board**. Offer **Add to
  board**, **Restore**, or **Locate** respectively, plus multi-select **Add
  selected**. The selectable object is a target symbol, not a persisted edge.
- Add only selected symbols. Grouping method targets by class does not silently
  select the class or siblings; the owner may be shown as a compact visual
  wrapper, but is not a separately included graph node unless chosen. Adding a
  class does not add its callers/callees or other connected types. With no
  automatic context enabled, its unselected members remain folded details.
- Browse/read/preview operations never change board membership. An optional
  context preview must be explicitly enabled, visually distinct, bounded and
  non-recursive; it must not turn an Add/Restore action into neighbour admission.
- Restoring recovers previous visibility, expansion and geometry without changing
  inclusion: a hidden inline member remains unpinned, while an independently
  pinned member returns to its card. Restore All Hidden admits no neighbours. Hiding leaves the
  target in Connections and a named Hidden items list and offers **Undo hide**.
  Hidden pinned members also appear marked Hidden with Restore in their owner's
  outline, not as ordinary rows whose edges inexplicably disappeared.
- Connections Back restores completed criteria and their matching result page,
  not pending controls alongside older results; unsubmitted text remains a draft.
  A history entry without completed results is re-fetched. Evidence/paging always
  use that completed context rather than current unsubmitted controls.
- Locate highlights/fits the existing representative and can reveal a folded
  member without adding a duplicate. Adding/locating a symbol does not silently
  remove active relation filters; explain filtered/hidden edges.

## Eligibility, cached facts and restoration

The selection projection distinguishes `included` (explicit graph identities),
`scopeIds` (eligible contains scope) and `symbols` (identity/ancestor facts, which
can be broader). Direct member pages similarly separate eligible `items` IDs
and exact totals from their `symbols` context. Never infer membership from the
presence of a fact in a discovery cache. Filtered snapshots must not resurrect
cached test/generated/uncertain descendants or inflate eligible member totals.

Tests/non-production and generated code use the engine's existing indexed-path
classifiers and generated-file records. Uncertain means confidence below 0.6 or
name-only resolution; synthesis alone does not make evidence uncertain. Filters
start excluded and expose exact disjoint counts, classified as tests, then
generated, then uncertain. Explicit graph cards survive exclusions; their
relationships still obey active filters. Retained hidden/pinned/requested rows
outside a filtered page are displayed and counted separately, with no edge
handles on hidden rows.

Saved `included: false` identities may own a source card, expansion or hidden
inline preference. Loading resolves all identities and their bounded proven
ancestry, but queries projection edges only from included seeds. It must not
re-seed an excluded branch merely because a child was expanded before saving.
Member reveal limits are persisted and capped consistently at 2,048; paged
Connections remains available beyond that outline bound. Preserve start columns
as well as lines for same-line declaration ordering.

Inline source-token links require explicitly proven complete, uncapped evidence;
a loaded prefix cannot establish a unique target, and unknown filtered candidates
must not become guessed links. Explicit target/evidence browsing remains available
while inline precision is withheld. Signature whitespace is exact identity: bounded
tabs/CR/LF are preserved, not normalized to make a match.

Source-card selection is presentation decoration, derived from original endpoint
IDs and their proven representatives. It does not select additional indexed nodes
or turn an incoming/outgoing reference into execution-frequency information.
Geometry/selection changes must not restart source verification or graph queries;
identity/index, requested line/page, collapse and visibility changes may do so.

## What complete support does and does not promise

Complete means that **no authorized indexed kind is excluded by Board design**:
node lookup/selection, connection browsing, ownership/folding, evidence, source
where available, restoration and persistence all work for every listed kind.
It does not mean loading the whole repository onto the canvas or inventing
relationships the extractor has not found. Language/framework extraction varies;
unresolved references and outside-index targets remain labelled boundaries,
not invented resolved nodes or arrows. Missing/ambiguous saved identities are
presentation placeholders, not new engine kinds.

The existing Symbol API is a reader projection, not an exhaustive Connections
contract: it separates containment and type uses, curates member outlines,
groups counterparts and caps evidence. Do not build completeness by simply
concatenating its current rails/chips. Reuse batching, security and serialization,
but expose all edge kinds through a bounded Board-specific query contract with
truthful totals and continuation, including hidden/not-on-board endpoints.
Keep existing reader contracts unchanged.

Acceptance must compare the Board's supported-kind inventory to `NODE_KINDS` and
`EDGE_KINDS`, exercise all 23/13 kinds with generic fixtures, and test unknown-kind
fallbacks. Test each relation in both directions, folded and independently pinned
endpoints, parallel kinds between a pair, member/type scope, paging, filters and
hide/restore with automatic context off. The mixed-kind clickdummy validates
presentation and fixture semantics, not production extraction or live API completeness.
