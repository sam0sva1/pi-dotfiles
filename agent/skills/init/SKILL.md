---
name: init
description: Initialize or update CLAUDE.md (compatible with Claude Code). Guides the agent to autonomously analyze the codebase and generate a high-quality context file for future AI sessions.
---

# Init Skill

Create or update a `CLAUDE.md` file — a "readme for robots" that accelerates understanding for future AI sessions. This file is automatically loaded by both Claude Code and pi.

## Workflow

### 1. Check Existing Context

Before anything else, look for existing context files in order of priority:
- `CLAUDE.md` — primary target, update if exists
- `AGENTS.md` — if found and no `CLAUDE.md`, use as basis for `CLAUDE.md`
- `.cursorrules`, `.cursor/rules/` — extract relevant conventions
- `.github/copilot-instructions.md` — extract relevant conventions
- `README.md` — extract project-specific details

If `CLAUDE.md` already exists, read it first and merge new insights without overwriting human-authored sections.

### 2. Autonomous Discovery

Explore the repository to build a mental model. You decide which files to read.

- **Identify Stack**: Languages, frameworks, build tools, and their versions.
- **Extract Workflows**: Commands for installing dependencies, running tests (including a single test), building, linting, and starting the project.
- **Map Structure**: Source roots, test directories, config files, entry points.
- **Infer Conventions**: Read sample source files to identify coding styles, architectural patterns (e.g., "functional components", "repository pattern"), naming conventions, and error handling approaches.
- **Find Gotchas**: Non-obvious things that would trip up an AI — monorepo quirks, custom build steps, environment requirements, tricky test setup.

### 3. Generate CLAUDE.md

Write the file using this structure as a baseline. Adapt sections to the project's actual needs — skip irrelevant sections, add project-specific ones.

```markdown
# CLAUDE.md

This file provides guidance to Claude Code (and other AI agents) when working with this repository.

## Overview

{What this project is and does, in 1-3 sentences}

## Stack

{Languages, frameworks, key dependencies with versions if important}

## Project Structure

{Only non-obvious structure. Skip if it's a standard layout for the framework.}
- `{dir}/` — {what's in it and why it matters}

## Development

{Commands for common workflows. Only include what's non-obvious or project-specific.}

- Install: `{cmd}`
- Build: `{cmd}`
- Test all: `{cmd}`
- Test single: `{cmd}`
- Lint: `{cmd}`
- Run: `{cmd}`

## Architecture

{High-level patterns that require reading multiple files to understand. Data flow, key abstractions, how modules connect. This is the most valuable section — focus here.}

## Conventions

{Coding standards actually enforced in this project — not generic best practices. Include formatter/linter config, naming patterns, file organization rules.}

## Gotchas

{Things that are surprising or non-obvious. Environment requirements, workarounds, known issues, "don't touch this because..." notes.}
```

### 4. Quality Rules

- **No fluff**: Don't include generic advice like "write clean code" or "handle errors properly."
- **No obvious info**: Don't list every file or describe standard framework structure.
- **No fabrication**: Only document what you actually found in the codebase. Never invent "Common Tasks" or "Tips" sections.
- **Be specific**: Instead of "follow the existing style," say "use camelCase for functions, PascalCase for components, 2-space indent."
- **Focus on architecture**: The "Architecture" section is the highest-value content — it captures knowledge that takes the longest to rediscover.
- **Mention other context files**: If `.cursorrules` or similar files exist, note their presence so future sessions know to check them.
