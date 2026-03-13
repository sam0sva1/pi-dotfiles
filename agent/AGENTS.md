# Pi compatibility notes for Claude workflow docs

`CLAUDE.md` is kept portable for Claude Code and is intentionally copied with minimal or no Pi-specific rewriting.

When `CLAUDE.md` references Claude-style slash commands, map them in Pi as follows:

- `/brainstorm` → `/skill:brainstorm`
- `/go-plan` → `/skill:go-plan`
- `/plan-check` → `/skill:plan-check`
- `/execute-plan` → `/skill:execute-plan`
- `/tdd` → `/skill:tdd`
- `/self-review` → `/skill:self-review`
- `/task-commit` → `/skill:task-commit`
- `/preflight` → `/skill:preflight`
- `/api-contract-first` → `/skill:api-contract-first`
- `/cross-service-changes` → `/skill:cross-service-changes`

Pi can load skills on demand based on descriptions, but for important workflow steps prefer explicit `/skill:name` invocation.

`CLAUDE.md` references to Claude-specific automation should be interpreted as process guidance unless the same automation is explicitly implemented in Pi.
