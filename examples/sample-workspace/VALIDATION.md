# Lifecycle validation

Run the replay from the repository root:

```powershell
pwsh -NoProfile -File scripts/validate-sample-workspace.ps1
```

The script copies `validation/initial/` to a temporary directory, applies direct
file and directory edits, and compares every resulting content path and SHA-256
hash with the checked-in sample workspace. It excludes this document and the
`validation/` input fixture from that comparison, then removes the temporary copy.

## Operations

| Operation | Direct edit | Invariant checked |
|---|---|---|
| Attach | Add `project_evon` to the rank chat | `chat.projects` records membership in one place |
| Detach | Remove `project_soap_bubbles` from the shared chat | No second file needs a matching edit |
| Promote | Create `project_posterior_diagnostics` and attach the original chat by ID | The chat stays in `chats/`; no copy is created |
| Rename | Move `projects/evon/` and update the project and summary titles | `project_evon` and unknown fields do not change |
| Repository relocation | Move the repository stand-in and edit its relative path | The inline repository ID stays stable |

## Failures and contract changes

The replay exposed three points that the schema must state explicitly:

1. A directory name and a display title cannot identify a project. Renaming either
   would otherwise break chat attachments, so references use the stable project ID.
2. A repository path cannot identify a repository. Relocation changes the path but
   retains the inline repository ID. Paths use `/` and resolve relative to the
   manifest that contains them.
3. Bidirectional project and chat references would drift if attach and detach
   required two edits. The contract treats the chat's `projects` list as
   authoritative, so each operation changes one file. A project's `resources`
   list contains resource IDs and does not mirror attached chats.

The first two requirements are represented in `SCHEMA.md`. The third is a contract
clarification found by this fixture and should remain covered by parser tests in
Phase 1. Exact text replacement also retains `x-sample-note`, demonstrating the
forward-compatibility rule that read-modify-write tools preserve unknown keys.
