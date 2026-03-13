---
name: preflight
description: Mechanical verification that the project builds, tests pass, and nothing is broken. Use before merge, PR, or declaring work complete.
---

Respond to the user in Russian.

**Announce**: "Использую /skill:preflight для механической проверки проекта."

Preflight — это проверка "можно ли лететь?" Не "туда ли летим?" (это `/skill:self-review`), а "всё ли работает, собирается, проходит."

## Phase 0 — Discover the Toolchain

Before running any checks, figure out HOW this project runs tests, linting, and builds. Do this ONCE per project, then reuse.

**Test runner discovery**:
- Look for `package.json` → check `scripts.test`, `scripts.lint`, `scripts.build`, `scripts.typecheck`
- Look for `Makefile` → check for `test`, `lint`, `build` targets
- Look for `pytest.ini`, `pyproject.toml`, `setup.cfg` → pytest configuration
- Look for `Cargo.toml` → `cargo test`, `cargo clippy`
- Look for `go.mod` → `go test ./...`, `golangci-lint`
- Look for `.github/workflows/` → CI config often reveals the canonical test/build commands
- Look for `docker-compose.yml` or `Dockerfile` → containerized test setup

**If discovery fails**: Ask the user. Don't guess — wrong commands waste time and produce misleading results.

**Save what you find**: State the discovered commands explicitly so the user can confirm and you don't need to rediscover next time:
```
Обнаружил toolchain:
- Тесты: npm test
- Линт: npm run lint
- Билд: npm run build
- Типы: npm run typecheck
```

## Phase 1 — Run the Checks

Execute each discovered command. For each:
- [ ] Run the command
- [ ] Capture the output
- [ ] Report: PASS / FAIL with details

### Checklist

**Build**:
- [ ] Project builds without errors

**Tests**:
- [ ] Full test suite passes — ALL tests, not just new ones
- [ ] No tests were disabled, skipped, or commented out during implementation
- [ ] No flaky test failures (if a test fails intermittently, flag it)

**Lint and Types**:
- [ ] No new linting errors or warnings introduced
- [ ] Type checking passes (if applicable)

**Wiring**:
- [ ] All new code is imported/registered where needed (no dead code introduced)
- [ ] All dependency injections, bindings, and configurations are in place
- [ ] No orphaned files or unused imports

**Documentation**:
- [ ] Documentation affected by changes is updated
- [ ] No stale comments or docstrings that contradict the current code

## Phase 2 — Report

**Output format**:
```
## Preflight Report

**Toolchain**: [discovered commands]

| Check        | Status | Details |
|---|---|---|
| Build        | PASS/FAIL | ... |
| Tests        | PASS/FAIL | ... |
| Lint         | PASS/FAIL | ... |
| Types        | PASS/FAIL | ... |
| Wiring       | PASS/FAIL | ... |
| Docs         | PASS/FAIL | ... |

**Verdict**: CLEAR FOR TAKEOFF / BLOCKED (list blockers)
```

## Red Flags — Stop and Follow the Process

- "Tests take too long, I'll skip them" → A failed test after merge is worse than a slow test now. Run them
- "The lint warnings are pre-existing" → Check. If they're new — fix them. If pre-existing — note it explicitly
- "Build works locally, that's enough" → Run the same commands CI would run. "Works on my machine" is not preflight clearance
- "I'll just check the files I changed" → No. Run the FULL suite. Your changes may break code you didn't touch
