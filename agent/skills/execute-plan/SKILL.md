---
name: execute-plan
description: Execute an approved implementation plan step by step with verification checkpoints.
---

Respond to the user in Russian.

**Announce**: "Использую /skill:execute-plan для выполнения плана реализации."

## HARD GATE — Approved Plan Required

Do NOT start execution unless:
1. A plan exists (created via `/skill:go-plan`)
2. The plan has been reviewed (via `/skill:plan-check` or explicit user waiver)
3. The user has approved the plan

"I know what to do without a plan" — that's not execution, that's improvisation. Improvisation is how bugs are born.

## Execution Process

### Before starting
- Re-read the full plan to refresh context
- Identify the first step (or the specific step/range requested by the user)
- Track progress visibly using `plan_tracker` (or another equivalent visible task tracker) for each plan step

### For each step

1. **Read the step** — understand WHAT to do, WHERE, and WHY
2. **Apply TDD** — if the step changes behavior:
   - Write the failing test first (RED)
   - Implement the change to pass it (GREEN)
   - Clean up (REFACTOR)
   - If TDD doesn't apply to this step (config change, documentation), note why
3. **Verify the checkpoint** — run the verification described in the plan:
   - Tests pass? Build succeeds? Behavior correct?
   - If verification fails — fix before moving to the next step
4. **Mark the step complete** — update `plan_tracker` (or another equivalent visible task tracker)

### Between steps
- Check: did the previous step introduce any unexpected changes?
- Check: is the next step still correct given what we've done so far?
- If the plan needs adjustment — discuss with the user before deviating

### After all steps
- Run the plan's final checklist
- Invoke `/skill:preflight` for mechanical verification (tests, build, lint, wiring)
- Report results to the user

## Execution Rules

- **One step at a time**: Complete and verify each step before starting the next. No parallel shortcuts
- **Plan is the source of truth**: If you disagree with a step during execution — discuss with the user, don't silently deviate
- **No scope creep**: Implement what the plan says. "While I'm here, let me also..." is how focused work becomes unfocused
- **Track progress visibly**: Use `plan_tracker` so the user can see which steps are done, in progress, and remaining

## Red Flags — Stop and Follow the Process

- "I'll combine these three steps into one" → No. Each step has its own verification. Combining steps means skipping verification
- "This step seems unnecessary, I'll skip it" → The step was planned for a reason. If you think it's wrong — ask the user
- "Let me deviate from the plan here, it's better this way" → Stop. Discuss with the user. Unilateral plan changes undermine the planning process
- "I'll verify at the end instead of after each step" → Catching issues after 10 steps is 10x harder than catching them after 1 step
