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
- **Prefer the Maestro MCP over `adb` for device interaction.** This project
  enables it: `.pi/mcp.json` turns on the user-level `maestro` server
  (`/home/sv-home/.maestro/bin/maestro mcp --no-viewer`), whose `env` already
  carries `JAVA_HOME`, and the project is trusted. It is reachable through
  codemode (`exposure: codemode`, so its tools are not in the direct tool list):
  `mcp__maestro__list_devices`, `mcp__maestro__run`,
  `mcp__maestro__inspect_screen`, `mcp__maestro__take_screenshot`, plus the
  Maestro Cloud tools. `inspect_screen` returns the view hierarchy as compact
  JSON, which replaces `adb shell uiautomator dump` — the command that wrote
  `ui-*.xml` dumps into the home root. Verified working: `list_devices` reports
  `emulator-5554` connected.
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

## Worktree and delegation hygiene

These rules exist because they were broken -- most of them more than once.

- **A task's spec document must exist inside the worktree the worker reads.** A
  spec written only in another checkout is invisible to the worker: it happened
  with `odd/tasks/optimizations.md` and again with `odd/tasks/product-v2.md`, and
  both times the worker correctly said the document was missing and worked from
  the brief alone. Copy the spec into the worktree before delegating, and commit
  it with the unit it governs.
- **Format and commit per unit, with an explicit file list.** The pre-commit hook
  rejects unformatted or lint-failing files, so run `npx biome check --write` on
  exactly the files of the unit being committed — never across another writer's
  in-flight files — and stage those files by name. Never `git add .` in a shared
  worktree: it sweeps up other units and the `node_modules` symlink.
- **Parallel writers need disjoint surfaces.** Several workers may share one
  worktree only when their allowed edit surfaces do not overlap; a unit that
  changes a shared type or the data model lands before the units that consume it,
  not beside them.
- **Check that a unit can be finished inside the surfaces you grant.** A brief
  whose allowed files cannot reach the feature's goal produces a half-feature that
  reports itself as complete. The scanner unit could open the add form for an
  unknown barcode but could not carry the code into the created item, because the
  form plumbing sat outside its surfaces, so re-scanning reached nothing — the
  exact value the feature existed for. Trace the data path from entry to stored
  value before delegating, and grant every file it crosses.
- **A new persisted field is not done until the form carries it.** The repository
  writes the save draft verbatim, so a field the draft omits is a field an edit
  erases. Schema v5 added the low-stock threshold and the expiry, the reminders
  unit wired them to notifications, and neither owned the item form — so editing
  an item silently disarmed its own reminders, and no user could set either value
  in the first place. Wire the field, the form that carries it, and the way the
  user sets it in the same phase, and test that an untouched edit preserves it.
