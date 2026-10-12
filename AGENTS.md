# Tengo — Agent Skills Index

When working on this project, load the relevant skill(s) BEFORE doing the work they govern.

## How to Use

1. Check the trigger column to find skills that match the current task.
2. Load the skill by reading the `SKILL.md` file at the listed path.
3. Follow the loaded skill's rules and workflow.
4. Multiple skills may apply simultaneously.

## Relevant Documentation

| Document | Use when | Path |
| --- | --- | --- |
| Product | Product intent, local-only household inventory scope, MVP requirements, non-goals, or unresolved product decisions matter. Proposed defaults are not approved requirements. | [`PRODUCT.md`](PRODUCT.md) |
| Design | Proposed native Android UX, board mapping B1–B9, states, validation, transitions, or design tokens matter. Wireframes describe planned behavior, not implemented screens. B2 is a historical alternative, not the active target. | [`DESIGN.md`](DESIGN.md) |
| Roadmap | Selecting implementation milestones, dependencies, acceptance criteria, or verification gates. Resolve pending decisions before implementing the behavior they govern. | [`ROADMAP.md`](ROADMAP.md) |
| Wireframe guide | Board descriptions, platform variants, artifact navigation, or proposed interaction rules are needed. | [`design/wireframes/README.md`](design/wireframes/README.md) |
| Editable wireframes | Inspecting or editing the OpenPencil source for the Tengo wireframes page and boards B1–B9. Preserve editable source alongside derived previews. | [`design/tengo-wireframes.op`](design/tengo-wireframes.op) |
| Flow overview | Reviewing the static whole-canvas board and transition map. This is not a clickable prototype. | [`design/wireframes/overview.png`](design/wireframes/overview.png) |
| Board previews | Inspecting individual static board exports and comparing them with the editable source and design document. | [`design/wireframes/previews/`](design/wireframes/previews/) |
| README | Setup, actual commands, current implementation boundaries, repository layout, and verification limitations are needed. | [`README.md`](README.md) |

## Device, Maestro and scratch hygiene

These rules exist because they were broken and the user reported the damage.

- **Never write into the home root.** No agent, worker or subagent may create a
  file or directory directly in `$HOME`. Metro logs, UI dumps, extracted
  archives and scratch work go under `$HOME/.cache/tengo-scratch/` or `/tmp`.
  Maestro's own artifacts already belong to `.maestro/runs/` (gitignored) via
  `scripts/run-maestro.sh`. "Scratch under `$HOME`" means a subdirectory, never
  `$HOME` itself.
- **Maestro needs `JAVA_HOME`.** There is no `java` on `PATH`, so the CLI exits
  with `ERROR: JAVA_HOME is not set and no 'java' command could be found in your
  PATH`. Use `JAVA_HOME=$HOME/.local/jdk-17.0.20.1+1`. Maestro itself is
  `$HOME/.maestro/bin/maestro` (2.11.0) and is not on `PATH` either.
- **Run device flows through the wrapper:** `scripts/run-maestro.sh <flow>` keeps
  artifacts in `.maestro/runs/`, emits a JUnit report, and fails closed outside a
  repository. `MAESTRO_REVERSE=1` is NOT a default. It adds
  `adb reverse tcp:8082 tcp:8083`, which is only correct when the bundle is
  served on host 8083 (the CRUD fixture bundle). The QUERY bundle is served on
  host 8082, which is what the app's `debug_http_host` already points at, so the
  reverse that works there is the pre-existing `tcp:8082 tcp:8082`. Adding the
  flag replaces that rule, aims the device at an empty port and makes the flow
  fail at its fixture gate with zero bundle requests — measured on device, not
  guessed.
- **Never touch production data on a device.** Only isolated DEV fixture
  databases may be created, opened or deleted. Never uninstall the app and
  never `pm clear` it.
- **Never serve a bundle from a dirty `src/`.** A device run on a worktree with
  uncommitted source edits is an inconsistent snapshot and proves nothing; one
  such run already produced a misleading native crash in this project.
