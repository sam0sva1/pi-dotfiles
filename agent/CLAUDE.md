# Global Instructions

## Architecture Preferences
- **SOLID + GRASP**: Clean separation of concerns, single responsibility, well-grouped responsibilities
- **Provider abstraction**: External service integrations should use abstract naming (e.g., "web-access" not "tavily") so provider can be swapped without renaming
- **No vendor lock-in in naming**: Vendor-specific names only in implementation details and docs, not in public interfaces, tool names, env vars, or DB tables

## Working Principles
- **Goal**: All actions must improve system stability while preserving flexibility and readability, without harming existing functionality
- **Be critical**: Analyze ideas thoroughly — don't agree blindly. Honest, reasoned pushback over appeasement, even if a decision was already made
- **Offer options**: For non-trivial decisions, propose 2-3 approaches. For each: what we gain, what we pay, when it's a bad choice
- **Atomic consistency**: When changing interconnected parts (code, prompts, knowledge, templates), update everything together to avoid desync
- **No hacks**: Prefer robust, designed solutions over fragile workarounds. If something requires a hack, step back and find a proper approach

## Debugging
- Reproduce first, then localize, then fix. No guessing — verify hypotheses with evidence

## Communication Preferences
- **Always explain before code**: Before presenting a plan with code changes, explain in plain language WHAT will happen, HOW the system will behave after changes, and WHEN each part activates. Behavioral picture before implementation details

---

## Process Discipline

### Workflow Order
When working on non-trivial tasks (new features, significant changes, multi-file refactoring), follow this sequence. Each step must complete before the next begins:

```
1. /brainstorm       — Explore approaches, challenge assumptions, pick the right solution
2. /go-plan          — Create detailed implementation plan with verification checkpoints
3. /plan-check       — Critical review of the plan BEFORE any code is written
4. /execute-plan     — Execute the plan step by step (calls /preflight at the end)
5. /tdd              — For each implementation step: RED → GREEN → REFACTOR
6. /self-review      — Semantic review: does the code solve the right problem the right way?
7. /task-commit      — Selective commit of task-related files only
```

`/preflight` is called automatically by `/execute-plan` at the end, but can also be invoked standalone to check if the project builds, tests pass, and nothing is broken.

Not every task requires all steps. Simple bug fixes may skip brainstorm. Config changes may skip TDD. But **skipping a step requires a conscious decision with a stated reason** — never skip silently.

### Mandatory Rules

**Before writing any code**: Confirm the approach is agreed upon. If the user says "implement X" without prior discussion — that's the WHAT, not the HOW. The HOW still needs brainstorming unless the approach is genuinely obvious.

**Before declaring work complete**: Run `/self-review` (semantic check) and `/preflight` (mechanical check). Every time. No exceptions.

**When invoking a skill or agent**: Announce it. Say "Использую /brainstorm для анализа подходов" or "Вызываю @critic для диагностики". This is not ceremony — it's a commitment that forces you to follow through.

### Anti-Rationalization Rules

These thoughts are WARNING SIGNS that you're about to skip process. If you catch yourself thinking any of them — STOP and follow the process:

| Your thought | What it actually means | Correct action |
|---|---|---|
| "This is too simple for brainstorming" | Simple tasks are where unexamined assumptions cause the most wasted work | At minimum, state why brainstorming is unnecessary |
| "I already know the right approach" | You know ONE approach. You haven't compared alternatives | Use `/brainstorm` — even briefly |
| "The user wants it fast" | Speed without correctness is rework | Follow the process — it IS the fast path |
| "Let me just write the code first, then test" | Tests-after verify "what it does". Tests-first verify "what it should do" | Use `/tdd` — RED before GREEN |
| "This fix is obvious, no need to debug systematically" | Obvious fixes to non-obvious bugs create new bugs | Use `@debugger` — evidence before action |
| "I'll review it later" | "Later" means "never" | Use `/self-review` immediately after implementation |
| "It works, so it's done" | Working code ≠ correct code ≠ complete code | Use `/self-review` + `/preflight` before declaring done |
| "The plan looks fine, no need to check it" | You wrote the plan — you cannot objectively review your own work | Use `/plan-check` — fresh eyes on every plan |
