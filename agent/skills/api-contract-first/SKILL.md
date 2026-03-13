---
name: api-contract-first
description: API-first approach for client-server development. Define the contract before implementing either side.
---

Respond to the user in Russian.

**Announce**: "Использую /skill:api-contract-first для разработки контракта [фича]."

You are implementing a feature that spans client and server. Follow the contract-first approach: define the interface before building either side.

## HARD GATE — Contract Before Code

Do NOT write any server or client implementation code until the contract is:
1. Fully defined (endpoints, schemas, errors, auth)
2. Presented to the user
3. Explicitly approved

"I'll define the contract as I go" — this is how client-server desync happens. Contract first. Always.

## Step 1 — Define the contract

Before any implementation:
- Define endpoints (or message types for non-REST)
- Define request and response schemas with concrete field names and types
- Define error responses and status codes
- Define authentication/authorization requirements
- Consider pagination, filtering, sorting if the endpoint returns collections

Present the contract to the user for approval before proceeding.

## Step 2 — Implement the server

- Implement the API according to the contract exactly
- Return proper error responses, not just 500
- Validate input at the boundary — never trust client data
- Write tests that verify the contract (request → expected response)
- Consider: what happens when this endpoint is called with unexpected data?

## Step 3 — Implement the client

- Implement the client according to the contract exactly
- Handle all defined error cases — not just the happy path
- Handle network failures (timeout, no connection, partial response)
- Never assume the server response format is correct — validate or use typed deserialization
- Consider offline/degraded scenarios if applicable

## Step 4 — Integration

- Verify client and server work together end-to-end
- Test with realistic data volumes, not just single-item responses
- Test error paths: what happens when the server returns 400, 401, 403, 404, 500?
- Test edge cases: empty responses, maximum payload sizes, special characters

## Principles throughout

- **Client knows nothing about server internals**: No SQL queries, no internal IDs, no implementation-specific fields in the API
- **Server knows nothing about UI**: No formatting, no display logic, no client-specific field names
- **Version from day one**: Include API version in the URL or headers. It costs nothing now and saves migration pain later
- **Document as you go**: The contract IS the documentation. Keep it updated with every change

## Red Flags — Stop and Follow the Process

- "The contract is obvious, I'll just start coding the server" → Define it explicitly. "Obvious" contracts have implicit assumptions that break clients
- "I'll add this field to the response, the client might need it" → If it's not in the contract, don't add it. Expand the contract first
- "The client and server are in the same repo, so contract doesn't matter" → Same repo ≠ same codebase boundaries. Contract discipline applies regardless
