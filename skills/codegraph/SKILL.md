---
name: codegraph
description: Use CodeGraph to explore indexed code, trace symbol relationships and assess change impact, or create and edit CodeGraph Review Boards with roughly arranged components, source cards and plain-text comment cards. Use for CodeGraph queries and board JSON authoring; not for unrelated diagrams, task boards or project-management boards.
---

# CodeGraph

Use the index for code context; use Review Board JSON for an explicitly selected
visual workspace. Neither operation changes application source. This skill does
not authorize indexing, installation, source edits, server startup or publication
outside the user's request and applicable project/tool policy.

## Choose the project and available surface

1. Confirm the intended checkout and its applicable instructions. An index is
   project-local: check for `.codegraph/` by default at the project root or an
   appropriate ancestor. Preserve any configured `CODEGRAPH_DIR` or platform
   choice; do not change it to find/create a different index. A monorepo may index
   individual packages rather than its root.
2. When an index exists, use `codegraph_explore` **before** raw search/read for
   code discovery, flow questions and edit impact. Pass `projectPath` explicitly
   when working outside the current project or with a separately indexed package.
   An unindexed MCP server root does not prevent queries to another indexed root.
3. If MCP is unavailable but the CLI exists, use its equivalent:
   ```bash
   codegraph explore --path "$project" 'UserService.create UserRepository.save'
   ```
   Check `codegraph --help` and the relevant subcommand's `--help` when the
   installed interface differs. Do not assume optional MCP tools are exposed.
4. If no index exists, use ordinary file tools and report the limitation. Do not
   run `codegraph init` unless the user or applicable project policy authorizes
   it; honor any explicit new-worktree indexing rule. Do not create an index just
   to draft a diagram or validate JSON. If useful after substantial unindexed
   research, briefly recommend `codegraph init` for future work.

## Research and change context

- Lead with exact file/module/class/qualified-method names and distinctive terms.
  Avoid bare generic names such as `get`, `run` or `save`; narrow a noisy query
  rather than expanding it. For a flow, name both endpoints and known symbols
  between them in one query.
- Returned source is verbatim, current source for the sections shown: treat it as
  already read. Do not re-read the same bytes to confirm the tool. Query named
  elided symbols for more detail; use file tools for unindexed content, an omitted
  detail, or source whose freshness the response cannot establish.
- Follow freshness and truncation notes. When source is omitted because a file
  changed, read that file or use an authorized sync; do not trust old line ranges.
  If the graph is recovering or cannot verify freshness, state that limitation.
- Separate exact graph evidence from heuristic/synthesized relationships,
  ambiguity and unresolved boundaries. A missing edge is not proof of no runtime
  relationship; a static path is not proof that a path executes.
- Use blast radius to select checks, not as proof of coverage or correctness.
  Confirm important test leads and run the relevant tests/builds for actual code
  changes. CodeGraph does not replace a compiler, test runner or runtime evidence.
- Stop when the requested question is answered. If a response says the project
  is unindexed or access is refused, do not loop or change permissions to fix it.

## Create or edit a Review Board

Read [Review Board authoring](references/boards.md) before writing board JSON,
editing a saved board, choosing symbol identities or invoking board APIs.

For “put these components on a board, roughly,” the default is:

1. Find the requested indexed symbols; resolve ambiguous names before selection.
2. Include only those symbols, with simple spaced positions and no source panels
   or comment cards unless requested. Connections come from the live index, not invented arrows.
3. Produce a validated import document, or save project-local board metadata when
   that is the requested destination. Browser automation is not needed to write
   the file. Importing alone does not persist a named board.
4. Report the file, selected symbols, unresolved items and what was actually
   checked. Do not call an unvalidated file a working or visually verified board.

Preserve existing board content and layout outside the requested edit. Never
infer membership from all nodes returned as discovery/ancestor context. A board
combines single-project indexed evidence with reviewer-owned plain-text comments.
Comments are separate metadata, never graph symbols or relationships. Do not use
them to disguise unresolved symbols, invent graph evidence or imply cross-project
support. Preserve existing comments, text and geometry unless asked to change them.
