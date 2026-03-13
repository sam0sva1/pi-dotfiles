---
name: task-commit
description: Selective commit of only the files changed in the current task. Use after self-review.
---

Respond to the user in Russian. Commit message must be in English.

**Announce**: "Использую /skill:task-commit для селективного коммита файлов текущей задачи."

## HARD GATE — Review Before Commit

Before committing, confirm that `/skill:self-review` has been run on the changes. If not — run it first. Committing unreviewed code is shipping bugs intentionally.

## Instructions

1. **Identify task-related files**:
   - If the user lists specific files or describes the scope — use that as guidance
   - Run `git status` to see all modified/untracked files
   - Run `git diff` to understand what each change does
   - Ask the user to confirm which files belong to the current task if it's ambiguous

2. **Stage only task-related files**: Add only the files that were created or modified as part of the current task. Do NOT stage unrelated changes from other features in progress.

3. **Generate a commit message** (in English):
   - Follow Conventional Commits format: `type(scope): description`
   - Types: feat, fix, refactor, docs, test, chore, style, perf
   - Keep the first line under 72 characters
   - Add a body if the changes need more explanation
   - Focus on WHY, not WHAT

4. **Show the user**:
   - List of files to be committed
   - The proposed commit message
   - Ask for confirmation before committing

5. **Commit** only after user approval.

## Red Flags — Stop and Follow the Process

- "Let me just commit everything" → No. Only task-related files. Unrelated changes go in separate commits
- "The commit message can be generic" → A vague message is a message that helps nobody. Be specific about WHY
- "I'll skip the review, the changes are small" → Small changes break big systems. Review first
