# Local-first research workspace

> **Product design document**  
> Status: design direction  
> Audience: product and engineering  
> Date: 2 September 2026

A workspace where projects, notes, chats, code, papers, and external discussions become one inspectable body of research context without giving up ordinary files or Git.

> **Core position:** Build a local semantic project filesystem, not a new knowledge-base silo. The filesystem holds the canonical record. The application supplies project views, chat, retrieval, synchronization, and agent coordination around it.

## 1. Vision of the final product

The final product is a local-first research workspace that treats an entire line of work as one object. A project can include repositories, LaTeX, notes, model chats, papers, experiments, and selected conversations from remote services. The user sees one coherent project even when its material lives in several places.

### The product model

The filesystem is the source of truth. Notes and chats are Markdown files with YAML frontmatter. Projects are either Git repositories or semantic views that point to one or more repositories and related resources. The application may maintain caches and indexes, but it must be able to delete and rebuild them from the files.

The design follows six principles:

- **Local first.** Core work remains usable without a hosted account, a vector database, or a running integration service.
- **Files stay ordinary.** A note can be edited in any text editor. A project can be inspected with normal filesystem and Git tools.
- **Tree for ownership.** Directories and summaries express the main hierarchy. A resource has a clear home.
- **Links for overlap.** Frontmatter and Markdown links attach one chat or resource to several projects or topics without copying it.
- **Agents use stable tools.** Files, Git, lexical search, and a small CLI are the default agent interface. Protocol adapters stay at the edge.
- **Models are replaceable.** The chat and agent layer stores provider-neutral messages, tool calls, attachments, and provenance.

### Projects and resources

A project is a named view over resources. Some resources are local and mutable, such as a repository or experiment directory. Others are local snapshots of remote material, such as a Slack thread or Notion page. The project manifest records identities and links. It does not hide the files behind an application database.

```text
Git repositories ───────────────┐
Markdown notes and chats ───────┤
Papers, data, and results ──────┼──> Semantic project view
Remote Markdown snapshots ──────┘      ├── areas and summaries
                                      ├── links and provenance
                                      └── agent context and activity
```

A project binds resources through readable metadata. It does not require all content to move into one physical directory.

### Global and project-local chats

Global and project chats share one storage model. Every chat is global at rest. Its frontmatter can list zero, one, or several projects. The interface then exposes three useful views: all chats, unassigned chats, and chats attached to the current project.

This allows research to begin before its destination is clear. An exploratory chat can gather notes, references, and code. Later, the user can attach it to an existing project or promote it into a new project. Promotion creates the project manifest and optional Git repository, then links the original chat. It does not duplicate the conversation.

```markdown
---
id: chat_8f32
title: Learned posterior over weights
created: 2026-09-02
projects: [evon, test-time-scaling]
topics: [variational-learning, posterior]
provider: openai
model: gpt-5.6
---

The conversation remains a normal Markdown document.
```

### Remote services at the edge

Slack, Discord, Gmail, Notion, and similar services require authenticated APIs or service-specific protocols. Their connector should periodically write normalized Markdown snapshots into the workspace, including the source URL, remote identity, timestamps, authors, and synchronization state. Agents read the snapshot through the same file interface they use for local notes.

MCP or another live adapter is justified when the agent must query fresh remote state or write back to the service. It should not sit between the agent and local files. If the connector breaks, existing snapshots remain readable.

### Retrieval should resemble browsing a good notebook

The primary retrieval system is a shallow hierarchy of human-readable summaries. The root summary describes active projects and topics. Each project summary describes its areas. Area summaries point to the small set of files, chats, code paths, and external snapshots that carry the details.

> Tree for ownership, links for overlap.

Retrieval follows a visible cascade:

1. Start with the current chat, root summary, and current project summary.
2. Route through child summaries and follow explicit links.
3. Run lexical search over the selected branch.
4. Read a small number of full documents and record which files support the answer.
5. Use semantic search only as a scoped fallback for old or poorly organized material.
6. Ask the user when the evidence remains missing or ambiguous.

Confidence should be categorical, not a fabricated probability. `FOUND` requires direct support from a plausible branch. `AMBIGUOUS` means several branches fit or the match is only thematic. `NOT_FOUND` means the search produced no supporting source. After one bounded expansion, an ambiguous or missing result becomes a specific question to the user.

Example low-confidence response:

> "I found discussions of Newton-Schulz in EVON and SOAP-Bubbles, but neither records the rank-divergence result. Was this part of the Phase 1 validation work?"

### Agent and chat layer

The application owns conversation identity and storage, while execution backends handle model calls and tools. A provider-neutral transcript records roles, text, tool calls, attachments, model identity, costs when available, and links to files used as context. The user can start and continue a conversation in the interface, choose between local models and remote endpoints, and switch backends without moving the conversation.

Agents should operate through the same stable mechanisms a developer already trusts: read and write files, search text, inspect diffs, commit changes, and call a small workspace CLI. The UI exposes the daily user workflow, including chat and backend selection. Each UI action should have a file or CLI equivalent where practical.

### Final product experience

The interface centers on projects and conversations rather than connector configuration. Backend settings remain a secondary screen, but users must be able to configure a supported backend and its credentials without hand-editing YAML. A project page shows its summary, areas, linked resources, active chats, recent file changes, sync state, and agent activity. A global inbox holds unassigned chats and newly mirrored material. Every answer can show a compact context trail so the user can inspect which branch and files the model used.

## 2. MVP built on lightweight components

The MVP should prove one claim: a file-backed project model plus guided retrieval gives a research agent enough context without a global embedding system or a connector-heavy platform. It should be useful with local files alone.

### MVP architecture

The first version can be a desktop or local web application backed by one workspace directory. A thin local service watches files, parses frontmatter, rebuilds derived metadata, runs lexical search, and coordinates the selected chat or agent backend. SQLite is acceptable for caches, file state, and job queues, but no user-authored knowledge should exist only in SQLite.

```text
┌─────────────────────────────────────────────────────────────┐
│ Local interface                                             │
│ Projects, chats, search, and context trail                  │
├─────────────────────────────────────────────────────────────┤
│ Workspace service                                           │
│ File watcher, parser, routing, and sync jobs                │
├─────────────────────────────────────────────────────────────┤
│ Files and Git                                               │
│ Markdown, YAML, repositories, and snapshots                 │
├─────────────────────────────────────────────────────────────┤
│ Replaceable backends                                        │
│ OpenCode, Codex CLI, Claude Code, OpenAI-compatible APIs    │
└─────────────────────────────────────────────────────────────┘
```

The lower layers remain usable without the interface. Backends can change without changing project or chat identity.

| Part | MVP responsibility | Constraint |
|---|---|---|
| Workspace files | Canonical projects, summaries, chats, notes, links, and snapshots | Human-readable and versionable |
| Local service | Parse metadata, watch changes, run search, route context, expose CLI | Indexes can be deleted and rebuilt |
| Interface | Browse projects, start and continue chats globally or locally, select and configure backends, attach and promote chats, inspect context | Does not conceal file locations or store credentials in canonical workspace files |
| Agent adapter | Start sessions, stream events, pass selected context, persist neutral transcripts | No provider owns conversation storage |
| Connector adapter | Mirror one or two remote sources into Markdown | Optional and isolated from the core |

### Proposed data layout

The layout should keep shared objects at the workspace level and let project manifests link to them. A repository can sit inside the workspace or remain elsewhere and be referenced by a stable local path.

```text
workspace/
├── README.md                     # root routing summary
├── workspace.yml                 # settings and registered paths
├── projects/
│   └── evon/
│       ├── project.yml           # identity, repos, resources, topics
│       ├── README.md             # project routing summary
│       ├── context/
│       │   ├── posterior.md
│       │   ├── distributed-training.md
│       │   └── experiments.md
│       └── links/                # optional shortcuts or link manifests
├── chats/
│   └── 2026-09-02-learned-posterior.md
├── topics/
│   └── distributed-training.md
├── inbox/                        # unassigned notes and new snapshots
├── external/
│   ├── slack/
│   └── notion/
└── .workspace/
    ├── index.sqlite              # derived and disposable
    ├── logs/
    └── sync-state/
```

A project manifest records only stable identity and relationships:

```yaml
id: evon
title: EVON
summary: Structured variational optimizer based on SOAP statistics.
repositories:
  - path: ../../repos/evon
  - path: D:/research/evon-experiments
resources:
  - chat: chat_8f32
  - external: slack_thread_c91a
topics:
  - variational-learning
  - distributed-training
```

### MVP retrieval contract

The MVP does not need embeddings. It needs predictable routing and evidence. A request starts inside the current project when one is active. The router compares the query with a small list of node titles, summaries, and keywords. It selects at most two branches, runs lexical search within them, and reads a bounded number of files. The answer records the files used.

If the router cannot identify a plausible branch, or the opened files do not support the requested claim, it asks a focused question. This behavior is part of the product contract, not an error state to hide.

### Components worth reusing

| Component | Use | Do not inherit |
|---|---|---|
| OpenCode or a similar coding-agent backend | Agent execution, terminal tools, streaming events, provider adapters | Its isolated project model or conversation ownership |
| Codex CLI, Claude Code, or other local agents | Optional replaceable execution backends through an adapter | Backend-specific transcript format as the canonical record |
| ripgrep and filesystem traversal | Fast lexical search and deterministic discovery | A custom search service before scale requires it |
| Git | History, diff, synchronization, and recoverability for project material | Automatic commits that obscure user intent |
| Onyx or oikb-style connector logic | Source-specific pagination, incremental sync, identity mapping, and normalization | Their knowledge-base abstraction, global vector index, or full deployment stack |
| SQLite with full-text search | Disposable metadata cache, file inventory, and optional FTS acceleration | Canonical notes, chats, or relationships |

License review must happen before copying connector or agent code. Reuse can mean adopting a backend through its public interface, extracting a small compatible module, or learning from its data model. A large fork would pull the product toward someone else's abstraction.

### What the MVP includes

- Create and register projects, including external repository paths.
- Start and continue global or project chats in the interface using one Markdown format.
- Attach a chat to several projects and promote an unassigned chat into a new project through the interface or CLI.
- Edit root, project, and area summaries in the interface or any text editor.
- Retrieve context through summaries, links, and lexical search, then display the context trail.
- Configure and run at least one agent backend and one direct model API through the interface using provider-neutral chat storage.
- Rebuild the complete derived index from the workspace.
- Mirror one high-value remote source into Markdown only after the local workflow works.

### What not to build initially

- No global vector database, automatic chunking pipeline, or always-on embedding job.
- No graph database. Frontmatter references and Markdown links cover early overlap.
- No broad connector catalog. Start with local files, then add the one service used most often.
- No multi-user permissions, hosted collaboration, or enterprise administration.
- No custom model-serving layer. Use existing local and remote endpoints.
- No autonomous reorganization of the workspace. Agents may propose moves or summary edits, but the user approves structural changes.
- No attempt to replace the editor, terminal, Git client, paper manager, or messaging services.
- No complex ontology. Projects, topics, resources, chats, summaries, and links are enough.

### MVP success criteria

A researcher should be able to point the application at two active repositories, create an unassigned discussion, attach it to both projects, and later ask a project-specific question. The agent should find the supporting summaries and files, cite its context trail, and ask for direction when it cannot find the referenced result. Deleting `.workspace/index.sqlite` must not lose knowledge or relationships.

## 3. Roadmap to the MVP and final vision

Build the file model and retrieval behavior before investing in connectors or a polished agent shell. Each phase should leave a usable local tool, not a hidden platform component waiting for the rest of the system.

### Milestones

#### Phase 0: validate the file contract

**Indicative duration:** one week

Create a sample workspace from real research material. Define project, chat, resource, and summary schemas. Test attach, detach, promote, rename, and repository relocation by editing files directly. The output is a versioned example workspace and a short schema specification.

#### Phase 1: ship the headless core

**Indicative duration:** two to three weeks

Phase 1 will produce an installable `fieldwork` command and a reusable core library. It will not run a graphical interface or call a model. A user or agent should be able to inspect and change a workspace, rebuild its derived state, and retrieve a bounded context bundle using terminal commands and JSON output.

##### Implementation stack

Use one Node.js package rather than a monorepo. Target Node.js 24 LTS and write the application in strict TypeScript using ECMAScript modules. Use npm and commit `package-lock.json` so local development and CI install the same dependency versions.

| Concern | Choice | Use in Phase 1 |
|---|---|---|
| CLI | `commander` | Parse commands and options, generate help, and return consistent exit codes. |
| YAML | `yaml` with `parseDocument` | Parse manifests and frontmatter as editable documents so writers retain unknown keys and comments. |
| Runtime validation | `zod` | Define the version 1 schemas and produce errors with file paths and field paths. Keep these schemas separate from the TypeScript types used inside the core. |
| File watching | `chokidar` | Watch canonical workspace files, coalesce editor save events, and update only the affected index rows. Do not recursively watch entire external repositories. |
| Derived database | SQLite through `better-sqlite3` | Store the file inventory, objects, references, content hashes, and an FTS5 index in `.workspace/index.sqlite`. Use transactions for rebuilds and event batches. |
| Repository search | the `rg` executable | Search current repository contents on demand while respecting ignore files. Check for `rg` at startup and report a direct installation error if it is absent. |
| Safe file writes | `write-file-atomic` | Replace a manifest or Markdown file only after the proposed content passes validation. |
| Tests | `vitest` | Run unit and integration tests on temporary copies of the Phase 0 sample workspace. |
| Build checks | `tsc`, ESLint, and Prettier | Compile the CLI, reject type errors, enforce a small set of correctness rules, and keep generated diffs stable. |

`better-sqlite3` is preferable to Node's built-in SQLite module for this phase because the built-in module is still marked as a release candidate. Keep all database calls behind a small adapter so it can be replaced later without changing workspace behavior.

##### Code layout

Keep the core independent of terminal formatting. Phase 2 should import the same operations rather than invoke the CLI as a subprocess.

```text
src/
|-- domain/          # IDs, object types, Zod schemas, and diagnostics
|-- files/           # discovery, frontmatter parsing, paths, and safe writes
|-- index/           # SQLite schema, migrations, incremental updates, rebuild
|-- search/          # branch routing, ripgrep calls, ranking, context trails
|-- operations/      # register, attach, detach, promote, validate
|-- commands/        # CLI argument handling and human or JSON rendering
`-- cli.ts           # fieldwork executable entry point
tests/
|-- unit/
`-- integration/
```

Functions in `domain`, `files`, `index`, `search`, and `operations` return typed results and diagnostics. They do not print or terminate the process. Only `commands` writes to stdout or stderr and maps failures to exit codes. This separation gives the Phase 2 interface a stable application API.

##### Parsing and validation

The scanner starts at `workspace.yml`, applies its directory overrides, then discovers project manifests, chats, summaries, resources, and explicit links. It also resolves registered repository paths outside the workspace. Stored paths use `/`; filesystem calls convert them to the current operating system's format.

Each parsed file produces its body even when its metadata is invalid. One validation run collects all syntax errors, schema errors, duplicate IDs, broken references, and inaccessible paths instead of stopping at the first failure. Diagnostics contain a code, severity, file, field path, and message. Human output includes the source location. `--json` emits the same data as a stable object.

Write operations follow a read, check, write sequence:

1. Read the current file and record its content hash.
2. Change only the required YAML nodes.
3. Preserve unknown fields, comments where the YAML parser retains them, and the complete Markdown body.
4. Validate the proposed document and its references.
5. Refuse the write if the on-disk hash changed after step 1.
6. Write a sibling temporary file and replace the target atomically.

##### Derived index

The first database migration creates these logical tables:

- `files` records the canonical path, owning root, modification time, size, and content hash;
- `objects` records the stable ID, type, title, summary, canonical path, and normalized metadata needed for routing;
- `references` records project membership, sources, resources, and explicit links as source, target, and relation rows;
- `repositories` records stable repository IDs and resolved local paths; and
- `documents_fts` is an FTS5 table for titles, summaries, keywords, and Markdown bodies that belong to the workspace.

Database migrations live in source control and update a `schema_version` row. A rebuild writes a new database beside the current one, validates row counts and references, then replaces the old database. An interrupted rebuild must leave either the previous valid index or the new valid index, never a partially rebuilt database.

`fieldwork watch` runs the scanner once, then keeps a foreground process open. It groups rapid add, change, and delete events into one short batch and applies that batch in a SQLite transaction. Changes inside registered repositories do not enter SQLite. The search command reads those files directly through `rg`, so results do not depend on a repository watcher being current.

The watcher is an optimization, not a requirement. Before a one-shot read command uses the index, it compares the recorded size and modification time of canonical files with the filesystem, hashes changed candidates, and updates stale rows. Closing the watcher therefore cannot make `validate`, `search`, or `context` return old workspace metadata.

##### CLI contract

The first CLI exposes these commands:

```text
fieldwork validate [--json]
fieldwork rebuild [--json]
fieldwork watch
fieldwork project list [--json]
fieldwork project show <project-id> [--json]
fieldwork project register <directory> --id <id> --title <title> [--repository <path>]
fieldwork chat attach <chat-id> --project <project-id>
fieldwork chat detach <chat-id> --project <project-id>
fieldwork chat promote <chat-id> --id <project-id> --title <title> [--directory <name>]
fieldwork search <query> [--project <project-id>] [--json]
fieldwork context <query> [--project <project-id>] [--chat <chat-id>] [--json]
```

Every command accepts `--workspace <path>`. Without that option, the CLI searches upward from the current directory for `workspace.yml`; if it finds none, it treats the current directory as the workspace root and uses the default paths. Read commands continue when unrelated files have validation errors and include those errors as diagnostics. Write commands fail before changing a file if the target object is invalid or the requested change would create a broken reference. Exit code `0` means the requested operation completed, `1` means validation or an operational lookup failed, and `2` means invalid CLI usage.

##### Retrieval behavior

`search` returns matching files. `context` applies the retrieval policy and explains how it selected them. For a project-scoped request, `context` loads the project summary and scores its area summaries using exact ID matches, titles, keywords, and SQLite FTS5 ranking. It selects no more than two branches, follows their explicit references, and runs `rg` only within the selected workspace directories and registered repositories. A global request performs the same first step over project and topic summaries. A context bundle contains at most ten files. Each file includes its UTF-8 content in full when it is no larger than 64 KiB. For a larger file, `content` is the longest UTF-8 prefix whose encoded size does not exceed 64 KiB and `contentTruncated` is `true`.

The command returns at most ten documents, subject to the per-file content bound above. Each result records its canonical path, object ID when present, matching line ranges, score components, and the summary or link that led to it. JSON output contains the query, scope, selected branches, files, diagnostics, and timings. Phase 1 exposes the evidence but does not label the result `FOUND`, `AMBIGUOUS`, or `NOT_FOUND`; Phase 3 adds those product-level outcomes and evaluates their reliability.

##### Tests and completion gate

Unit tests cover path normalization, frontmatter boundaries, every version 1 schema, diagnostic aggregation, YAML-node edits, branch scoring, and context limits. Integration tests copy `examples/sample-workspace` to a temporary directory and run the real operations against it. They cover attach, detach, promote, rename, repository relocation, conflicting edits, watcher add/change/delete events, malformed files, duplicate IDs, and broken references.

The recovery test records the objects, references, and fixed-query search results, deletes all derived state, runs `fieldwork rebuild`, and compares the rebuilt output with the recorded output. CI runs the build, lint checks, unit tests, and integration tests on Windows, macOS, and Linux with Node.js 24.

Phase 1 is complete when a clean checkout can install and build the CLI, all commands above work against the sample workspace, JSON output is documented with fixtures, and deleting `.workspace/index.sqlite` loses no project, chat attachment, link, or search result. The local interface, transcript storage, model calls, and agent-backend adapters remain in Phase 2.

#### Phase 2: add the local interface and chat

**Indicative duration:** three to four weeks

**Status:** complete. Read-only browser views, file editing, provider-neutral transcripts, backend execution, and the interactive browser chat and backend settings tracked in [issue #39](https://github.com/adrianrob1/LookHere/issues/39) have shipped.

Build project, chat, inbox, and search views. Add editing for Markdown and frontmatter without hiding the underlying path. Store provider-neutral transcripts and support one direct model endpoint plus one local agent backend.

The Phase 2 interface must let a user:

- start global or project chats and attach, detach, or promote them;
- send messages, select a configured backend for a turn, and see pending, success, failure, and conflict states;
- add, edit, remove, test, and select the default supported backend without hand-editing `workspace.yml`; and
- supply credentials through a local secret flow that never writes them to canonical workspace files, transcripts, indexes, logs, diagnostics, URLs, or rendered HTML.

#### Phase 3: harden retrieval and low-confidence behavior

**Indicative duration:** two weeks

Instrument and evaluate the routing implemented in Phase 1. Verify that linked summaries cannot bypass the two-branch and ten-document limits, refine the context trail when it does not explain a selection clearly, and add explicit `FOUND`, `AMBIGUOUS`, and `NOT_FOUND` outcomes. Evaluate against a small set of real questions where the answer is present, absent, or spread across projects.

#### MVP gate: use it for active research

Run the product on real work for at least two weeks. Track retrieval failures, manual context additions, structural edits, and backend switching. Do not add semantic search until the failures show that summaries and lexical search are insufficient.

The pilot tracked in [issue #9](https://github.com/adrianrob1/FieldWork/issues/9) (moved from the LookHere archive's issue #12) is blocked by the Phase 2 browser completion work in [issue #39](https://github.com/adrianrob1/LookHere/issues/39).

#### Post-MVP: add remote snapshots and stronger lifecycle tools

Mirror the highest-value remote source into Markdown. Add sync status, provenance, conflict handling, and snapshot retention. Add Git-aware activity, summary refresh proposals, and importers for existing chat exports.

#### Toward the final vision: expand without weakening the core

Add more agent backends, optional branch-scoped semantic search, more connectors, topic views across projects, richer resource previews, and controlled write-back to remote services. Every addition must preserve file access, rebuildability, provenance, and explicit uncertainty.

### Evaluation plan

Use a small, stable set of questions drawn from actual research work. Include direct fact lookup, a conclusion hidden in an old chat, a concept shared by two projects, a deliberately missing fact, and an ambiguous phrase that requires clarification. Record the selected branch, files opened, answer support, time to useful context, and whether the system asked the right question.

| Measure | MVP target |
|---|---|
| Recovery | Derived state rebuilds from files with no lost relationships |
| Traceability | Every context-assisted answer exposes the summaries and files used |
| Uncertainty | Missing and ambiguous test cases do not produce unsupported answers |
| Portability | Workspace remains readable and searchable without the application |
| Backend independence | One chat can continue across two model or agent backends |
| Daily usefulness | User can start globally, attach later, and retrieve project context without copying material |

### Risks and controls

- **Summary drift.** Summaries can become stale. Record their source links and last review time. Let agents propose updates as visible diffs instead of silently rewriting them.
- **Path instability.** Repositories move. Use stable resource IDs plus resolved paths, and provide a repair flow when a registered path disappears.
- **Frontmatter conflicts.** Manual edits can produce invalid metadata. Keep the schema small, preserve unknown fields, and report errors without blocking access to the document body.
- **Retrieval overconfidence.** A plausible branch can still be wrong. Require direct supporting text before the system marks a result `FOUND` and make the context trail inspectable.
- **Connector fragility.** Remote APIs change and credentials expire. Isolate each connector, keep snapshots readable, and make sync failure non-blocking for local work.
- **Backend lock-in.** Agent tools emit incompatible events. Normalize only the stable common record and retain raw backend events as optional attachments for debugging.
- **Scope expansion.** Search, chat, IDE, knowledge graph, and collaboration features can consume the project. Hold the MVP to the daily flow and reject features that do not improve it.
- **License mismatch.** Promising open-source components may have branding or source-available restrictions. Review licenses before copying code and prefer narrow adapters over large forks.

### Sequence after the MVP

1. Improve summary maintenance and import existing chat histories.
2. Add one-way Slack or Notion snapshots based on observed value.
3. Add cross-project topic pages and resource previews.
4. Introduce branch-scoped embeddings only for collections where measured retrieval failures justify them.
5. Add controlled live actions through service APIs or MCP when read-only snapshots cannot complete the task.
6. Explore shared workspaces and hosted synchronization only after the single-user local model is stable.

> **Decision rule:** When choosing between a clever new subsystem and a readable file, choose the file until real usage proves it cannot carry the required behavior.
