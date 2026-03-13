---
name: self-review
description: Semantic review of completed implementation — does the code solve the right problem the right way?
---

Respond to the user in Russian.

**Announce**: "Использую /skill:self-review для семантического ревью реализации [что именно]."

You are doing a fresh, unbiased self-review of your own implementation. Forget any prior context, assumptions, or decisions — approach the code as if you're seeing it for the first time.

This is NOT a mechanical check (tests pass, build works) — that's `/skill:preflight`'s job. This is a SEMANTIC review: does the code solve the right problem? Does the approach match the agreed design? Did the intent survive the journey from plan to code?

## HARD GATE — Fresh Eyes Required

Before starting the review, mentally reset. The fact that you wrote the code is IRRELEVANT. Your loyalty is to the system's health, not to your own work. If the code is bad — say it's bad.

"I just wrote this, so it's probably fine" — this is the single most dangerous thought during self-review. Fight it actively.

## Instructions

1. **Gather changes**: Run `git diff main...HEAD` (or `git diff --cached`, or `git diff` — whichever shows the relevant changes). If the user provided a specific scope or focus area, review that area extra carefully.

2. **Semantic analysis** — the core of this review:

   **Intent preservation**:
   - Re-read the original task description. Does the implementation actually solve THAT problem?
   - If there was an approved design/plan — does the code follow it? Or did the implementation silently drift?
   - Are there cases where the code does something technically correct but semantically wrong (solves a different problem than intended)?

   **Design coherence**:
   - Does the implementation respect the agreed architecture and approach?
   - Are SOLID/GRASP principles maintained, or were they compromised during implementation?
   - Would someone reading this code understand the INTENT, not just the mechanics?

   **Completeness**:
   - Is the logic fully implemented? Nothing left as TODO, stub, or half-done?
   - Are there missing edge cases, error paths, or boundary conditions?

   **Correctness**:
   - Bugs, logic errors, off-by-one mistakes, race conditions?
   - Security issues (injection, auth, data leaks)?
   - Consistency with existing codebase patterns and conventions?

   **Hidden problems**:
   - What will break if requirements change slightly?
   - What implicit assumptions does the code make that aren't documented?
   - Are there potential performance issues under realistic load?

3. **Output format**:
   - Start with: does the implementation match the original intent? (1-2 sentences)
   - List issues found, grouped by severity: Critical > Warning > Suggestion
   - For each issue: file:line, what's wrong, and how to fix it
   - End with a verdict: LGTM / Minor issues / Needs changes

## Red Flags — Stop and Follow the Process

- "Everything looks fine" after a 10-second scan → You haven't reviewed. Read EVERY changed line
- "I made this change intentionally" → Irrelevant. Intentional changes can still be wrong
- "It passed the tests" → Tests verify expected behavior. Self-review catches what tests don't: intent drift, design issues, missing semantics
- "Minor issue, I'll fix it later" → Fix it now. "Later" means "never" in 90% of cases
- "The code works, what else is there to check?" → Working code that solves the wrong problem is worse than broken code that solves the right one
