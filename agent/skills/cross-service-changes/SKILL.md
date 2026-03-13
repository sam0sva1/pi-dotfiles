---
name: cross-service-changes
description: Context and checklist for changes spanning multiple services. Ensures contracts, compatibility, and deployment order are considered.
---

Respond to the user in Russian.

**Announce**: "Использую /skill:cross-service-changes для координации изменений между сервисами."

You are implementing a change that spans multiple services. This is inherently risky — a mistake in one service can break others. Follow this discipline throughout the implementation.

## HARD GATE — Contracts Before Implementation

Do NOT write implementation code in ANY service until:
1. All inter-service contracts are explicitly defined
2. Backward compatibility impact is assessed
3. Implementation and deployment order is established

"I'll figure out the contract as I implement" — this is the #1 cause of cross-service desync. Define contracts FIRST.

## Before writing any code

1. **Confirm the contract**: What is the API or message format between services? Is it explicitly defined (OpenAPI, protobuf, JSON schema) or implicit? If implicit — define it explicitly first.

2. **Check backward compatibility**: Will old versions of consumers handle the new format? If not — plan a migration strategy (versioned endpoints, feature flags, dual-format support during rollout).

3. **Establish the order**: Implement the provider (who produces data) before the consumer (who uses it). Never implement the consumer first — it creates a dependency on something that doesn't exist yet.

## During implementation

4. **One service at a time**: Complete and verify changes in one service before moving to the next. Do not scatter half-done changes across multiple services.

5. **Contract tests**: When changing a contract, write or update contract tests that verify both sides agree on the format. This catches desync early.

6. **Fallback behavior**: What happens if the upstream service is unavailable or returns the old format? The consumer must handle degraded scenarios gracefully — not crash, not corrupt data.

7. **Lambda-specific**: If a lambda is involved, consider:
   - Cold start impact from new dependencies
   - Timeout settings — does the new logic fit within limits?
   - Concurrency limits — does the change affect throughput?

## Before committing

8. **Cross-service checklist**:
   - [ ] Contracts between services are explicitly defined and compatible
   - [ ] Backward compatibility preserved (or migration plan exists)
   - [ ] Provider implemented and tested before consumer
   - [ ] Fallback behavior defined for service unavailability
   - [ ] Deployment order documented (which service deploys first)
   - [ ] Rollback possible at each deployment stage
   - [ ] No shared mutable state introduced between services

## Red Flags — Stop and Follow the Process

- "Both services are simple, I'll change them together" → One at a time. Verify each before moving to the next
- "The consumer can just adapt to whatever the provider sends" → That's implicit coupling. Define the contract explicitly
- "We'll deploy them simultaneously" → Simultaneous deployment is a myth. There's always a window where versions differ. Plan for it
