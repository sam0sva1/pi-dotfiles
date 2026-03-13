---
name: tdd
description: Test-Driven Development — RED-GREEN-REFACTOR cycle for every behavior change. Use during implementation.
---

Respond to the user in Russian.

**Announce**: "Использую /skill:tdd для реализации [фича/поведение] через RED-GREEN-REFACTOR."

## The Iron Law

**NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST.**

This is not a suggestion. This is not "best practice when time allows." This is the mandatory process for every behavior change. New features, bug fixes, refactoring that changes behavior — all of them go through RED-GREEN-REFACTOR.

## HARD GATE — Write Code Before Test? Delete It. Start Over.

If you find yourself having written production code before the test — delete the production code. Not "keep it and backfill the test." DELETE it. Write the test first. Then write fresh production code to pass it.

This feels wasteful. It is not. Code written without a test is code you don't understand yet. The test forces you to understand WHAT the code should do before deciding HOW.

## The Cycle

### RED — Write a failing test

1. Write ONE test that describes the next small piece of behavior
2. Run the test — it MUST fail
3. Verify it fails for the RIGHT reason (not a syntax error, not a missing import — the actual assertion must fail)
4. If the test passes immediately — either the behavior already exists (no code needed) or your test is wrong

### GREEN — Make it pass with minimal code

1. Write the MINIMUM production code to make the failing test pass
2. Do not optimize. Do not generalize. Do not clean up. Just make it green
3. Run ALL tests — the new one must pass AND no existing tests must break
4. If other tests break — fix the issue before proceeding

### REFACTOR — Clean up while staying green

1. Now improve the code: extract, rename, simplify, remove duplication
2. Run ALL tests after each change — stay green throughout
3. If a test breaks during refactor — undo the last change and try a smaller step
4. Refactoring changes structure, not behavior — no new tests needed here

## When TDD Applies

- New features — always
- Bug fixes — write a test that reproduces the bug FIRST, then fix it
- Behavior changes in existing code — always
- Refactoring that preserves behavior — existing tests cover it; add tests only if coverage is insufficient

## When TDD May Be Skipped (only with user approval)

- Throwaway prototypes (code that will be deleted)
- Generated/scaffolded code (boilerplate with no logic)
- Configuration files (no behavior to test)
- Pure UI layout changes (visual, no logic)

If in doubt — use TDD. The cost of an unnecessary test is low. The cost of a missed test is high.

## Anti-Patterns to Avoid

- **Test after code**: Tests written after implementation verify "what the code does", not "what the code should do." They encode bugs as features
- **Testing implementation details**: Test behavior (inputs → outputs), not internal methods. If you refactor and tests break but behavior is the same — your tests are testing the wrong thing
- **Mock everything**: Mocks are for external boundaries (APIs, databases, file systems). Mocking internal collaborators creates brittle tests that break on every refactor
- **One giant test**: Each test should verify ONE behavior. If a test name needs "and" — split it

## Red Flags — Stop and Follow the Process

- "Let me write the implementation first, then add tests" → DELETE the implementation. Start with the test. No exceptions
- "This function is too simple to test" → Simple functions with wrong behavior cause complex bugs. Test it
- "I'll write all the tests at the end" → That's not TDD. That's test-after. The test must DRIVE the implementation
- "The test is hard to write, I'll skip it" → Hard-to-test code is poorly designed code. The difficulty is the signal to redesign
- "TDD is slowing me down" → TDD slows the typing. It accelerates the shipping. Every skipped test is a future debugging session
- "Just this once, I'll skip the test" → That's rationalization. "Just this once" is how discipline dies
