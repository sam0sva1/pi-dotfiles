---
name: go-plan
description: Create a detailed, verifiable implementation plan for an agreed-upon approach.
---

Respond to the user in Russian.

**Announce**: "Использую /skill:go-plan для создания плана реализации [фича/подход]."

You are creating a detailed implementation plan. The approach should already be decided (via `/skill:brainstorm` or direct instruction). If the approach is unclear or seems questionable, ask before planning.

**Important**: Present the full plan explicitly and wait for user approval before any implementation begins.

## HARD GATE — No Code Without Approved Plan

Do NOT write any implementation code until:
1. The plan is presented in full
2. The user has explicitly approved it
3. `/skill:plan-check` has been run (or the user explicitly waived it)

If you find yourself wanting to "just start coding" — that's the signal to slow down, not speed up.

## Instructions

1. **Study the codebase**:
   - Read all files that will be affected by the changes
   - Understand existing patterns, naming conventions, project structure
   - Identify dependencies and potential side effects

2. **Build the plan** with these requirements:

   **Granularity**: Each step should be completable in 2-5 minutes. If a step takes longer — break it down further. Each step must describe WHAT to change, WHERE (specific files, classes, methods), and WHY this change is needed.

   **Order matters**: Steps must be in the correct execution order. Mark dependencies explicitly — if step 3 depends on step 1, say so.

   **TDD integration**: For each step that changes behavior, include:
   - What test to write FIRST (RED phase)
   - What production code to write to pass it (GREEN phase)
   - What cleanup to do after (REFACTOR phase)

   **SOLID/GRASP alignment**: For each significant design decision in the plan, briefly note which principle it follows and why. Don't lecture — just anchor decisions.

   **Self-verification checkpoints**: After each logical group of steps, include a "how to verify" block:
   - What to check to confirm the step is done correctly
   - What could go wrong and how to spot it
   - Commands to run (tests, linting, type checks) if applicable

3. **Include a final checklist** at the end of the plan:
   - All new files are imported/registered where needed
   - All modified interfaces are updated across consumers
   - Documentation affected by changes is listed
   - No dead code or orphaned artifacts left behind
   - Tests cover the new/changed behavior

4. **Be honest about risks**:
   - If something in the plan is fragile or might need revisiting, flag it
   - If the plan reveals the chosen approach has issues, say so — don't force a bad plan

5. **Output format**:
   - Brief summary of what we're implementing and the chosen approach
   - Numbered steps grouped into logical phases
   - Verification checkpoints after each phase
   - Final checklist
   - Estimated scope: which files are created, modified, deleted

## Red Flags — Stop and Follow the Process

- "I'll figure out the details as I code" → No. The plan must be detailed enough to execute without guessing
- "This step is self-explanatory" → If you can't describe the verification check, the step isn't clear enough
- "Tests can be added later" → Tests are part of the plan, not an afterthought. Include TDD steps
- "The plan is too long, let me simplify" → A long plan for a complex task is correct. A short plan for a complex task is incomplete
