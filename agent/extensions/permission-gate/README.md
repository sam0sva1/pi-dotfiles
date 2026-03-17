# Permission Gate

Workspace-first, ask-based permission gate for Pi.

## What this extension does

`permission-gate.ts` intercepts tool calls before they execute and applies a workspace-derived policy:

- trusted root defaults to the current `cwd`
- read-only tools inside trusted roots are auto-allowed
- access outside trusted roots is **ask**, not policy-level deny
- mutation tools are approved per file
- browse tools can get subtree-scoped session grants
- risky/sensitive targets ask once and are not cached
- decisions are audit-logged into the session JSONL via `pi.appendEntry("permission-gate", ...)`

This extension is intentionally split into a thin runtime adapter plus testable support modules.

---

## Activation / load model

### When is it active?

This extension is auto-discovered by Pi because the entrypoint lives at:

- `~/.pi/agent/extensions/permission-gate.ts`

Pi loads global extensions from `~/.pi/agent/extensions/*.ts` at process startup unless extension loading is disabled.

### Practical rule

- If the file was present when `pi` started, the extension is active in that process from the start.
- If the extension code is edited while Pi is already running, the **updated code is not active yet** until:
  - `/reload`, or
  - restarting `pi`

### Cases where it will NOT be active

- `pi --no-extensions`
- extension load failure at startup/reload
- explicit test runs that bypass discovery and do not pass `-e`

---

## User-visible policy model

### 1. Trusted root

By default:

- `trustedRoots = ["."]`
- `.` is resolved relative to the current session `cwd`

That means the current workspace is the default trust boundary.

### 2. No policy-level deny

The model is intentionally ask-based:

- safe/expected actions -> `allow`
- everything else -> `ask-session` or `ask-once`
- blocking in no-UI mode is a technical fallback, not a durable policy state

### 3. Auto-allow inside trusted root

Inside trusted roots, these tools are allowed silently:

- `read`
- `ls`
- `find`
- `grep`

### 4. Outside trusted root

Outside trusted roots:

- `read` -> ask-session per exact path
- `ls` / `find` / `grep` -> ask-session per canonical directory subtree
- `edit` / `write` -> ask-session per exact file

### 5. Sensitive paths

Sensitive paths always ask once and are never cached, even inside trusted roots.

Defaults include:

- `.env`
- `.git/`
- `~/.pi/agent/auth.json`
- `~/.pi/agent/sessions/`

### 6. Bash policy

Bash is classified into three buckets:

- `allow`
- `ask-session`
- `ask-once`

Initial safe allowlist:

- `pwd`
- `git status`
- `git diff *`
- `git log *`
- `git branch`
- `git branch --list *`
- `git remote -v`

Risky bash syntax/families escalate to `ask-once`, including things like:

- pipes / redirects / shell composition
- subshells
- package managers
- network tools
- destructive commands
- privilege escalation

### 7. Meta-tools

Meta-tools are always `ask-once` and never cached.

Defaults include:

- `mcp`
- `subagent`
- `subagent_status`
- `team_create`
- `spawn_teammate`
- `spawn_lead_window`
- `send_message`
- `broadcast_message`
- `read_inbox`
- `task_create`
- `task_submit_plan`
- `task_evaluate_plan`
- `task_list`
- `task_update`
- `team_shutdown`
- `task_read`
- `check_teammate`
- `process_shutdown_approved`

---

## Grant model

Active grants are **ephemeral** and live only in memory.

They are not persisted across restarts.

### Exact grants

These are exact-target capabilities:

- `read-path`
- `modify-file`
- `bash`

Examples:

- `read-path:/tmp/file.txt`
- `modify-file:/tmp/file.txt`
- `bash:git checkout main`

### Subtree grants

Browse grants are subtree-scoped capabilities:

- `browse-path:<canonical-directory-root>`

This covers the granted directory and its descendants, but not siblings.

### Important invariants

- browse grants are **subtree**, not exact lookup caches
- mutation grants are **per file**, not broad tool-wide grants
- UI and runtime rely on **structured grant fields** (`kind`, `scope`, `target`, etc.), not on parsing the string `key`

---

## Audit model

Audit entries are persisted into the session JSONL as custom entries:

- `customType = "permission-gate"`

Schema:

- `schemaVersion: 1`
- `timestamp`
- `toolName`
- `category`
- `target?`
- `scope`
- `decision`
- `reason`
- `grantKey?`

### Audit scopes currently used

- `policy` - silently allowed by policy
- `session-grant` - allowed because an existing session grant covered it
- `once` - user allowed once
- `session` - user allowed for session or blocked a session-ask action
- `ask-once` - user answered a one-shot approval prompt
- `grant-clear` - `/permissions clear`
- `blocked-no-ui` - approval required, but no UI was available

### Persistence rule

- grants are ephemeral
- audit is persistent

That is intentional.

---

## Session lifecycle and resets

Runtime listens to:

- `session_start`
- `session_switch`
- `session_fork`
- `session_tree`

On these lifecycle changes, ephemeral grants are reset and config/snapshot state is refreshed.

### Boundary-sensitive reset

A workspace snapshot has a derived **workspace signature** based on the effective trust boundary.

Grants are cleared when the effective boundary changes, not merely when the raw `cwd` string changes.

That avoids both:

- stale grants leaking across workspaces
- unnecessary clears when the effective boundary stays the same

---

## Config file

Main config:

- `~/.pi/agent/permission-gate.jsonc`

The runtime creates the config file automatically if it does not exist.

Config fields:

- `trustedRoots`
- `sensitivePaths`
- `alwaysAskTools`
- `tools`
- `bash`

Legacy values like `deny` and `cwd` are migrated to the new ask-based model with notices.

---

## Architecture

### `permission-gate.ts`

Thin entrypoint / adapter shell.

Responsibilities:

- wire Pi events
- create runtime state
- register `/permissions`
- forward tool calls into adapter-core
- append audit entries
- show the minimal custom viewer for `/permissions`

### `adapter-core.ts`

Runtime wiring logic.

Responsibilities:

- classify a tool call through policy core
- handle allow / ask / block paths
- create and reuse grants
- emit audit entries for all important decisions
- implement `/permissions` command behavior
- deliver pending notices once a delivery-capable UI context exists

### `core.ts`

Pure policy logic.

Responsibilities:

- normalize config
- resolve trusted roots and sensitive paths
- classify path access
- classify bash commands
- classify meta/other tools
- build prompt models
- build audit payloads
- build workspace signatures

### `runtime-state.ts`

Config + snapshot coordinator.

Responsibilities:

- load config via injected I/O
- build immutable workspace snapshots
- refresh snapshots by `cwd`
- clear grants when the effective workspace boundary changes
- manage config-related notices

### `grant-store.ts`

Ephemeral grant storage.

Responsibilities:

- remember grants
- evaluate exact/subtree coverage
- list structured grant records for `/permissions`
- clear active grants

### `notice-store.ts`

Delivery-aware notice storage.

Responsibilities:

- keep notices pending until actually delivered
- replace stale pending notices by origin
- dedupe by `origin + key`
- allow a notice to appear again if the problem goes away and later returns

---

## `/permissions`

User command:

- `/permissions` - show active grants
- `/permissions clear` - clear active grants
- `/permissions reset` - alias for clear

Behavior:

- interactive mode -> minimal custom read-only viewer
- non-interactive mode -> plain text summary
- clear/reset -> clear in-memory grants and append a `grant-clear` audit entry

---

## Operational notes

### If you change the extension code

Run one of:

- `/reload`
- restart `pi`

Without that, the already-running Pi process keeps the previously loaded extension runtime.

### If behavior seems wrong

Check, in order:

1. Is Pi running with extensions enabled?
2. Was the current process started before or after the latest code change?
3. Has `/reload` been run since the change?
4. Does the current session JSONL contain `customType = "permission-gate"` audit entries?
5. Does `~/.pi/agent/permission-gate.jsonc` match expectations?

### Reading audit entries

Session JSONL custom entries can be searched for:

- `"customType":"permission-gate"`

Useful things to inspect:

- `scope`
- `decision`
- `reason`
- `target`
- `grantKey`

---

## Representative behavior examples

### Example A: read inside workspace

- tool: `read`
- target: inside current workspace
- result: allowed silently
- audit: `scope = "policy"`, `decision = "allowed"`

### Example B: read outside workspace in interactive mode

- tool: `read`
- target: outside trusted root
- result: ask
- if approved for session -> exact read grant remembered
- later same target -> allowed via `session-grant`

### Example C: browse outside workspace

- tool: `find`
- target: outside trusted root
- result: ask
- if approved for session -> subtree browse grant remembered for the canonical directory root

### Example D: sensitive file

- tool: `read`
- target: `.env`
- result: ask-once
- no session grant created

### Example E: no UI fallback

- tool requires approval
- process runs in non-interactive / print mode
- result: blocked with `blocked-no-ui` audit

---

## Current tests

Representative test suites live in:

- `core.test.ts`
- `grant-store.test.ts`
- `notice-store.test.ts`
- `runtime-state.test.ts`
- `adapter-core.test.ts`

Run all permission-gate tests with:

```bash
node --import /Users/k.novosad/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/node_modules/@mariozechner/jiti/lib/jiti-register.mjs --test /Users/k.novosad/.pi/agent/extensions/permission-gate/*.test.ts
```

---

## Non-negotiable invariants

These are the important design constraints to preserve in future edits:

1. `permission-gate.ts` stays thin
2. workspace policy is derived from an immutable snapshot
3. outside-root access asks instead of policy-denying
4. browse grants are subtree-scoped
5. mutation grants are per file
6. sensitive paths are ask-once and never cached
7. meta-tools are ask-once and never cached
8. grants remain ephemeral
9. audit remains persistent in session JSONL
10. grant semantics come from structured fields, not string parsing
11. notices are delivery-aware and deduped by `origin + key`
12. runtime-state and notice behavior remain testable without touching the real user config
