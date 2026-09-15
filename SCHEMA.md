# Workspace file contract

Status: Phase 0 contract
Schema version: 1

FieldWork stores its canonical record in YAML and Markdown files. This document
defines the version 1 file contract. An index, database, or application object
is derived state and must not contain the only copy of any field defined here.

## Conventions

### YAML and Markdown

YAML files contain one top-level mapping. Markdown files may start with a YAML
frontmatter mapping between `---` lines. Text after the frontmatter is the
human-authored body and is part of the canonical record.

Dates use `YYYY-MM-DD`. Timestamps use RFC 3339 with an offset, for example
`2026-09-02T14:30:00+09:00`. Lists may be empty. A field described as optional
may be omitted; a missing field is not the same as an empty string or empty
list.

### Stable IDs

Every project, chat, task, resource, summary, and explicit link has a
workspace-wide, stable `id`. IDs:

- match `[a-z][a-z0-9]*(?:_[a-z0-9]+)*`;
- are compared byte for byte and are case-sensitive;
- do not change when a title, path, provider, or remote URL changes;
- must never be reused for a different object, even after deletion.

Short type prefixes such as `project_`, `chat_`, `task_`, `resource_`,
`summary_`, and `link_` are recommended because they make references readable.
Importers should derive a deterministic ID from a source's stable remote
identity or generate an ID once and persist it. They must not regenerate IDs
from mutable titles or file paths.

Fields named `project`, `projects`, `resource`, `resources`, `sources`, `links`,
`from`, and `to` contain IDs unless their definition below says otherwise. A
missing reference is a validation error, but readers should still make the
containing file body available.

### Paths

Use `/` as the separator in stored paths, including Windows drive paths. A path
in `workspace.yml` is relative to the workspace root. Every other relative path
is relative to the directory containing the file that declares it. For example,
`../../repos/evon` in `projects/evon/project.yml` resolves to
`<workspace>/repos/evon`.

Resolve `.` and `..` segments before comparing paths. Do not expand `~`, shell
variables, or environment variables. Absolute paths are allowed only for local
repository and resource locations. A reader may report a missing or inaccessible
target, but it must not reject the manifest or discard its other fields.

Identity comes from `id`, not a resolved path. When a repository or file moves,
edit its `path` and keep its ID. Markdown links follow normal Markdown rules and
resolve relative to their Markdown file.

### Extensions and unknown fields

Unknown mapping keys are valid at every level, including objects inside lists.
A tool that reads and rewrites a file must preserve unknown keys and their
values. It must also preserve the Markdown body. A tool may normalize YAML
formatting and key order, but it should preserve comments when its YAML library
supports them.

Readers must reject invalid values for fields defined in this version. They must
not treat an unknown key as an error. Writers must not move an unknown key to a
different mapping or attach meaning to it without a later schema version.

## Workspace settings

`workspace.yml` registers the workspace layout. The file is optional. When it is
absent, readers use the default paths shown below.

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `version` | yes | integer | Schema major version. Version 1 readers accept `1`. |
| `title` | no | string | Display name for the workspace. |
| `paths` | no | mapping | Overrides for the standard directories. |
| `backends` | no | mapping | Chat backend configuration. See "Chat backends" below. |

`paths` may contain `projects`, `chats`, `topics`, `tasks`, `inbox`, and
`external`. Each value is a workspace-root-relative path. Omitted entries
default to the key name.

```yaml
version: 1
title: Optimizer research
paths:
  projects: projects
  chats: chats
  topics: topics
  tasks: tasks
  inbox: inbox
  external: external
```

### Chat backends

The optional `backends` mapping configures the execution backends that continue
chat transcripts. It is an additive extension to schema version 1: the field is
optional, and older `workspace.yml` files without it remain valid.

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `default` | no | string | Backend used when a chat send names none. Must exist in `entries`. |
| `entries` | no | mapping | Configured backends keyed by backend name. Names are free-form labels: non-empty, at most 100 characters, and without control characters. Leading and trailing whitespace is trimmed before storing. |

Each entry requires a `type`. Version 1 defines three types. Like every mapping,
entries may contain unknown keys, which readers preserve.

An `openai` backend calls an OpenAI-compatible `/chat/completions` endpoint
directly:

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `type` | yes | literal | Must be `openai`. |
| `base_url` | no | URL | Endpoint root. Defaults to `https://api.openai.com/v1`. Point it at any OpenAI-compatible server. |
| `model` | yes | string | Model identifier sent with every request. |
| `api_key_env` | no | string | Name of the environment variable that holds the API key. |
| `timeout_ms` | no | positive integer | Request timeout in milliseconds. Defaults to `120000`. |

An `opencode` backend runs the local OpenCode agent CLI non-interactively:

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `type` | yes | literal | Must be `opencode`. |
| `model` | no | string | Model in `provider/model` form passed with `-m`, such as `anthropic/claude-sonnet-4-5`. |
| `command` | no | string | Executable to run. Defaults to `opencode`. |
| `args` | no | list of strings | Extra arguments placed before the `run` subcommand. |

An OpenCode installation can also be driven through an `agent` backend with
`command: opencode` and `args: ['acp']`. The ACP path streams message and
reasoning chunks, while the CLI path above prints each reply part whole and
exposes no reasoning.

An `agent` backend drives any Agent Client Protocol (ACP) harness as a child
process, speaking JSON-RPC 2.0 over its stdin and stdout. The same entry shape
covers every ACP harness; OpenCode is reached with `command: opencode` and
`args: ['acp']`, and Codex with `command: codex-acp`. FieldWork runs the
`initialize` handshake, creates a session with `session/new` or resumes a
recorded session with `session/load`, sends the turn with `session/prompt`, and
normalizes `session/update` notifications into the provider-neutral exchange.
Unknown notifications are ignored.

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `type` | yes | literal | Must be `agent`. |
| `command` | yes | string | Executable that starts an ACP harness, such as `opencode` or `codex-acp`. |
| `args` | no | list of strings | Arguments passed to the command, such as `['acp']` for OpenCode. Defaults to `[]`. |
| `model` | no | string | Model id applied to the harness through the `session/set_model` request on every turn. A harness without that extension keeps its own default. `POST /api/backends/models` lists what a harness offers. |
| `timeout_ms` | no | positive integer | Exchange timeout in milliseconds, covering the whole conversation with the harness. Defaults to `120000`. |

The `command` values are separate installs resolved from `PATH`; FieldWork never installs them. OpenCode ships the `opencode` executable from `npm install -g opencode-ai`, and the Codex adapter ships `codex-acp` from `npm install -g @agentclientprotocol/codex-acp`, which bundles a compatible Codex engine. Authentication likewise belongs to the harness: the Codex adapter reuses login state under `~/.codex` and accepts `CODEX_API_KEY` or `OPENAI_API_KEY` from the environment of the running server. `fieldwork backend list` reports whether each `command` resolves.

API keys are never stored in files. `api_key_env` records only the environment
variable name; FieldWork reads the value at request time and never writes it to
a chat, the index, or diagnostics. When `api_key_env` is omitted, requests are
sent without an Authorization header, which suits local endpoints that need no
key.

```yaml
version: 1
title: Optimizer research
backends:
  default: research-model
  entries:
    research-model:
      type: openai
      base_url: https://api.openai.com/v1
      model: gpt-5.6
      api_key_env: OPENAI_API_KEY
      timeout_ms: 120000
    local-agent:
      type: opencode
      model: anthropic/claude-sonnet-4-5
    opencode-acp:
      type: agent
      command: opencode
      args: ['acp']
      model: anthropic/claude-sonnet-4-5
    codex-acp:
      type: agent
      command: codex-acp
```

When `fieldwork chat send` continues a chat, the assistant reply is appended to
the transcript with provider-neutral message metadata (`provider` from the
backend exchange, `model`, `backend` set to the configured backend name from
`backends.entries`, `session` when the backend reports one, `thought` when the
backend streamed reasoning, `tool_calls` and `usage` when present), as defined
under "Chat transcripts". Session resumption
matches `backend` against the configured name, so two backends of the same type
never share sessions. Nothing is written when the backend fails, so a retry
does not duplicate text.

## Project manifests

A project manifest is normally stored at `projects/<directory>/project.yml`.
The directory name is only a location and need not equal the project ID.

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `id` | yes | ID | Stable project identity. |
| `title` | yes | string | Human-readable project name. |
| `summary` | no | string | A short description used when routing among projects. |
| `repositories` | no | list of repository references | Local Git repositories used by the project. |
| `resources` | no | list of IDs | Resources attached to the project. |
| `topics` | no | list of strings | Search and cross-project topic labels. |
| `links` | no | list of IDs | Explicit link objects associated with the project. |

A repository reference is either the ID of a resource whose `kind` is
`repository`, or an inline repository object. An inline object requires `id` and
`path` and declares that resource at the point of use. It may also contain
`title`, `remote`, and `default_branch`. `remote` is a URL; `default_branch` is a
branch name. Use a standalone resource manifest and its ID when several projects
share one repository.

```yaml
id: project_evon
title: EVON
summary: Structured variational optimizer based on SOAP statistics.
repositories:
  - id: resource_repo_evon
    path: ../../repos/evon
    remote: https://github.com/example/evon.git
    default_branch: main
  - id: resource_evon_experiments
    title: EVON experiments
    path: D:/research/evon-experiments
resources:
  - resource_posterior_notes
  - resource_slack_c91a
topics:
  - variational-learning
  - distributed-training
links:
  - link_evon_baseline
```

## Chats

Chats are Markdown files, normally under `chats/`. The body holds the readable
transcript using the message encoding described under "Chat transcripts" below.
Tools must preserve body content when editing chat metadata.

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `id` | yes | ID | Stable chat identity. |
| `title` | yes | string | Human-readable chat title. |
| `created` | yes | date or timestamp | Creation time. |
| `updated` | no | date or timestamp | Time of the last content change. |
| `projects` | no | list of IDs | Attached projects. Missing or empty means unassigned. |
| `topics` | no | list of strings | Search and cross-project topic labels. |
| `provider` | no | string | Provider used for the recorded exchange. |
| `model` | no | string | Provider model identifier. |
| `links` | no | list of IDs | Explicit link objects associated with the chat. |

```markdown
---
id: chat_8f32
title: Learned posterior over weights
created: 2026-09-02T10:15:00+09:00
updated: 2026-09-02T11:02:00+09:00
projects:
  - project_evon
  - project_test_time_scaling
topics:
  - variational-learning
provider: openai
model: gpt-5.6
links:
  - link_chat_posterior_notes
---

## User

Can we learn the posterior over optimizer weights?

## Assistant

The experiment should separate posterior quality from optimizer stability.
```

The chat's `projects` list is authoritative for chat membership. Attaching or
detaching a chat changes only `projects`; a project manifest's `resources` list
does not mirror attached chats. Promoting a chat creates a project manifest and
adds that project's ID to `projects`; it does not copy or rename the chat.

## Chat transcripts

The chat body encodes a provider-neutral transcript as an additive extension to
schema version 1. A message starts with a level-2 heading `## <role>` where
`<role>` is `user`, `assistant`, `system`, or `tool`. Heading matching is
case-insensitive, so legacy bodies using `## User` parse as messages too. Only
these full-line role headings delimit messages. Any other level-2 heading,
such as `## Summary`, is ordinary message text, and parsing stops only at the
next message heading.

Immediately after the heading, the message may carry one fenced code block with
the info string `yaml` holding structured message metadata. Nothing except
blank lines may sit between the heading and the fence. After the heading, or
the metadata fence when one is present, free Markdown text is the message
text.

The encoding is total: every message text serializes to a body that parses
back to the same text. The writer resolves the two structural collisions.
First, when the text contains a line that would otherwise act as a message
delimiter — a full-line role heading preceded by any run of backslashes — the
writer prepends one backslash to every such line and marks the message with
`text_escaped: true` in its metadata fence, creating a fence with just that
key when the message has no metadata. Readers strip one leading backslash from
such lines only when the parsed metadata contains `text_escaped: true`;
unmarked messages parse verbatim, so existing version 1 transcripts read
unchanged. Second, when a message carries no metadata and its text begins
with a fenced code block whose info string is `yaml` — a line of exactly three
backticks, the lowercase info string `yaml`, and optional surrounding spaces or
tabs — the writer emits an explicit empty (`{}`) metadata fence before the
text so that fence is not mistaken for metadata; when the message already
carries metadata, its own fence precedes the text and no extra fence is
needed. Unclosed or invalid hand-written metadata fences still produce the
`transcript.fence` and `transcript.metadata` diagnostics without hiding the
message text.

Everything before the first message heading is the chat preamble. It is
preserved verbatim and is not a message. A body with no message headings is a
valid chat with zero messages, so every version 1 chat file remains valid.

Message metadata fields are:

| Field | Required | Type | Meaning |
|---|---|---:|---|
| `provider` | no | string | Provider used for the exchange, such as `openai`. |
| `model` | no | string | Model identifier. |
| `backend` | no | string | Configured backend name from `backends.entries` that produced the message, such as `research-model`. Older transcripts may record a backend type instead; such messages parse but do not resume sessions. |
| `session` | no | string | Backend session reference. |
| `at` | no | date or timestamp | When the message was recorded. |
| `thought` | no | string | Reasoning the backend streamed before the reply. The interface shows it collapsed under the assistant message; it never joins the message text. |
| `tool_calls` | no | list of tool call objects | Tool calls made while producing the message. |
| `attachments` | no | list of attachment objects | Files or resources attached to the message. |
| `usage` | no | loose record | Token counts when the provider reports them. |
| `cost` | no | loose record | Cost figures when the provider reports them. |
| `context` | no | list of IDs | Chats, files, or resources used as context for the message. |
| `text_escaped` | no | boolean | Writer marker set to `true` when the message text contains escaped full-line role headings; readers strip one leading backslash from such lines only when this is `true`. |

A tool call object requires `id`, `name`, and `arguments`. `arguments` is a
string or a mapping. It may include `result`. An attachment object requires
`id`, a stable object ID, or `path`; it may include `label`, `mime`, `kind`,
`title`, and `size`, as defined under "Message attachments" below. Like
every other mapping, metadata objects are loose: unknown keys are valid and a
tool that rewrites a chat must preserve them.

A message with invalid metadata produces a validation diagnostic, but the
message and its text remain available, following the rule that metadata errors
never hide the body.

Serialization is deterministic: `## <role>` followed by a blank line, then the
optional `yaml` fence (carrying `text_escaped: true` when the text needed
escaping, or `{}` when a metadata-less text begins with a `yaml` fence), then
the text, then one blank line. Parsing a serialized transcript yields the same
preamble and messages, and re-serializing unchanged messages does not alter
them.

````
```markdown
---
id: chat_lab_agenda
title: Lab meeting agenda
created: 2026-09-10
---

Planning thread for the weekly lab meeting.

## user

Please draft the agenda for Thursday's lab meeting.

## assistant

```yaml
provider: openai
model: gpt-5.6
at: 2026-09-10T09:30:00Z
tool_calls:
  - id: call_calendar_lookup
    name: calendar_lookup
    arguments: |
      week: 2026-09-07
    result: 2 open slots on Thursday
attachments:
  - id: resource_soap_scaling
    label: Scaling notes
```

Here is the draft agenda.
```
````

### Message attachments

A message may carry attachments, as an additive extension to schema version 1.
An attachment reference is an object with exactly one of `id`, a stable object
ID, or `path`, a canonical stored workspace path. A reference with both or
neither is invalid.

Resolution accepts the canonical kinds `task`, `resource`, `summary`, `chat`,
and `project` by stable ID, and any canonical stored workspace path that
resolves safely inside the workspace. Paths that escape the workspace, start
with `~`, or expand environment variables do not resolve.

For each resolved attachment, FieldWork stores one attachment object in the
message metadata:

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `id` | no | ID | Stable ID of the attached object when it has one. |
| `path` | yes | path | Canonical stored path of the attached file, kept for internal resolution. |
| `label` | yes | string | Display label. Never a path. |
| `mime` | yes | string | `text/markdown` for Markdown targets, `application/yaml` for YAML targets. |
| `kind` | yes | string | Canonical kind of the attached object. |
| `title` | yes | string | Title of the attached object. |
| `size` | yes | integer | Attachment size in bytes. |

The stored transcript text stays plain. When a message is sent to a backend,
each attachment is appended to the message text handed to the backend as one
block of the form:

```text
<attachment kind="<kind>" title="<title>">
<content>
</attachment>
```

Attribute values are escaped, so a title may contain quotes or angle brackets.

A message accepts at most 8 attachments, 256 KiB per attachment, and 1 MiB
combined. A send that carries an invalid reference or exceeds a limit is
rejected with a diagnostic and nothing is written. A missing, unreadable,
moved, or unsupported target is reported the same way.

## Tasks

A task is an independent workspace object stored as ordinary Markdown with
YAML frontmatter, normally under `tasks/`. The body is the task description.
Tasks are an additive extension to schema version 1: a workspace without task
files remains valid.

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `id` | yes | ID | Stable task identity. |
| `title` | yes | string | Human-readable task title. |
| `status` | yes | enum | `active` or `done`. |
| `created` | yes | date or timestamp | Creation time. |
| `updated` | yes | date or timestamp | Time of the last change. |
| `deadline` | no | date or timestamp | Due time used for overdue and upcoming grouping. |
| `projects` | no | list of IDs | Projects that include the task. |
| `completed` | conditional | date or timestamp | Completion time. Valid only when `status` is `done`; a validator reports `completed` on an active task as an error. |

```markdown
---
id: task_rank_divergence
title: Check rank divergence after the preconditioner update
status: active
created: 2026-09-02
updated: 2026-09-02
deadline: 2026-09-15
projects:
  - project_evon
---

Reproduce the eight-rank run and compare it with the baseline log.
```

A task does not require a chat link, and no task field records a chat. Opening
a chat from a task stages the task as a message attachment in a draft, as
described under "Drafts" below; the staged reference uses the task's stable
ID, so the agent can resolve it and read the task body and allowed metadata.

Task files participate in workspace discovery, validation, indexing, watching,
counts, and search like every other canonical kind. Safe editing keeps `id`
and `created` immutable and leaves the Markdown body editable.

The lifecycle is: quick-add text creates a task whose first line is the title
and whose remaining text is the description; marking a task done sets
`status: done` and records `completed`; reopening clears both; snoozing sets
or moves `deadline`. Every task write uses a content-hash precondition.

## Drafts

A draft is a durable record of a chat being composed before its first message
is submitted. Drafts are YAML files stored at
`.workspace/drafts/draft_<suffix>.yml`, where `<suffix>` is 12 lowercase
letters or digits. Drafts are an additive extension to schema version 1:
workspaces without drafts remain valid.

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `id` | yes | ID | Stable draft identity, `draft_` plus 12 lowercase letters or digits. |
| `message` | yes | string | Current message text. May be empty while editing. |
| `projects` | yes | list of IDs | Projects selected for the future chat. May be empty. |
| `backend` | no | string | Backend name selected for the first turn. |
| `attachments` | yes | list of attachment references | Staged attachments. May be empty. |
| `created` | yes | timestamp | Creation time. |
| `updated` | yes | timestamp | Time of the last change. |
| `consumed` | no | boolean | Set to `true` when the draft was submitted but could not be deleted. |

```yaml
id: draft_7c4a8f2b90d1
message: Summarize the rank divergence task.
projects: []
attachments:
  - id: task_rank_divergence
created: 2026-09-02T09:12:00Z
updated: 2026-09-02T09:12:00Z
```

Drafts sit outside workspace discovery. They never count as chats, never enter
chat search results, and never create chat Markdown before submission. The
content hash of a draft is the hash of its raw file bytes, and draft writes use
it as a precondition like every other write. Draft listings order by `updated`
with the most recent first, ties broken by ID, so the first listed draft is the
active draft a client should resume.

Submitting a draft validates the message, projects, backend, and attachments,
derives the chat title, stable chat ID, and file name from the first message
line, runs the selected backend, and then writes the canonical chat file with
the user message, its attachment metadata, and the assistant reply in one
atomic write. The draft is deleted only after the chat file is committed. When
the backend fails, nothing is written and the draft keeps its text and staged
attachments. When the draft cannot be deleted after a successful submission, it
is marked `consumed: true`; consumed drafts are excluded from listings and
deleted lazily on later loads.

## Resources

A resource represents a local file or directory, repository, remote object, or
local snapshot. Resource manifests use YAML frontmatter in Markdown so a human
description or mirrored content can follow it. They normally live beside the
content they describe or under `external/` for remote snapshots.

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `id` | yes | ID | Stable resource identity. |
| `title` | yes | string | Human-readable name. |
| `kind` | yes | string | Resource type, such as `note`, `paper`, `repository`, `dataset`, or `external`. |
| `projects` | no | list of IDs | Projects that include the resource. |
| `topics` | no | list of strings | Search and cross-project topic labels. |
| `path` | no | path | Local file or directory represented by this resource. |
| `url` | no | URL | Canonical remote or source URL. |
| `source` | no | source object | Provenance for imported or mirrored content. |
| `snapshot` | no | snapshot object | Synchronization state for a local snapshot. |
| `links` | no | list of IDs | Explicit link objects associated with the resource. |

At least one of `path`, `url`, or a Markdown body must be present. A source
object requires `service` and `remote_id`; it may include `url`, `author`, and
`created`. A snapshot object requires `fetched`; it may include `remote_updated`,
`etag`, and `status`. `status` is one of `current`, `stale`, or `error`.

```markdown
---
id: resource_slack_c91a
title: Rank divergence discussion
kind: external
projects:
  - project_evon
topics:
  - distributed-training
url: https://example.slack.com/archives/C123/p1725206400000000
source:
  service: slack
  remote_id: C123:1725206400.000000
  author: ada
  created: 2026-09-01T16:00:00Z
snapshot:
  fetched: 2026-09-02T09:00:00+09:00
  remote_updated: 2026-09-01T16:22:00Z
  etag: W/"a1b2c3"
  status: current
links:
  - link_slack_experiment
---

The rank divergence appeared after the preconditioner update.
```

## Summaries

Summaries are routing documents written as Markdown. The body contains the
summary and links to detailed evidence. Root summaries are normally the
workspace `README.md`; project summaries are normally
`projects/<directory>/README.md`; area and topic summaries can live in project
`context/` or `topics/`.

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `id` | yes | ID | Stable summary identity. |
| `title` | yes | string | Human-readable summary title. |
| `kind` | yes | enum | `root`, `project`, `area`, or `topic`. |
| `project` | conditional | ID | Owning project. Required for `project` and `area`; omitted otherwise. |
| `summary` | no | string | Short routing description used before opening the body. |
| `keywords` | no | list of strings | Terms used for deterministic branch selection. |
| `sources` | no | list of IDs | Resources, chats, or child summaries that support the body. |
| `links` | no | list of IDs | Explicit link objects associated with the summary. |
| `reviewed` | no | date or timestamp | Last human review of the summary. |

```markdown
---
id: summary_evon_distributed
title: Distributed training
kind: area
project: project_evon
summary: Failure modes and scaling results for distributed EVON runs.
keywords:
  - all-reduce
  - rank divergence
  - preconditioner
sources:
  - resource_slack_c91a
  - resource_evon_experiments
links:
  - link_slack_experiment
reviewed: 2026-09-02
---

# Distributed training

The eight-rank run diverged after the preconditioner update. See the
[experiment log](../../repos/evon/runs/eight-rank.md).
```

## Explicit links

Use ordinary Markdown links when a relationship only matters inside prose. Use
an explicit link object when tools must traverse the relationship in either
direction. Store link objects as YAML files under a project's `links/` directory
or another registered location.

| Field | Required | Type | Meaning |
|---|---:|---|---|
| `id` | yes | ID | Stable link identity. |
| `from` | yes | ID | Source object. |
| `to` | yes | ID | Target object. |
| `relation` | yes | string | Directional relationship, such as `supports`, `discusses`, `derived-from`, or `related`. |
| `label` | no | string | Human-readable explanation of the relationship. |
| `created` | no | date or timestamp | When the relationship was recorded. |

```yaml
id: link_slack_experiment
from: resource_slack_c91a
to: resource_evon_experiments
relation: discusses
label: Discussion that identified the failing experiment stage
created: 2026-09-02
```

The ordered `from` and `to` fields define direction. For a symmetric
relationship, use `relation: related` and treat both directions equally. Do not
create a second reversed link.

## Minimum validation behavior

A version 1 validator should report, without modifying files:

- malformed YAML or an unclosed Markdown frontmatter block;
- missing required fields and invalid field types;
- duplicate IDs and references to IDs that do not exist;
- invalid dates, timestamps, IDs, and enum values;
- path fields that use `\\`, `~`, or environment-variable expansion;
- missing or inaccessible path targets as warnings rather than schema errors.

Readers should return all errors they can find in one pass. A metadata error must
not make the Markdown body unavailable. Writers should validate the result
before replacing a canonical file.
