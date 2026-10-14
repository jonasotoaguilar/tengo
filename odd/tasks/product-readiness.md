# Product readiness — phase 2 (U6–U11)

Phase 2 of `odd/tasks/product-v2.md`: the units that turn a finished, daily-usable app into something a household can
install, trust and hand to someone else. Phase 1 (U1–U4, schema v5, capture, scan, reminders) is delivered to `main`
(`80056ef`; issue #30 closed). U5 (home-screen widget) is **out of this phase**: its feasibility gate answered
"not feasible as it stands" and reopening it is a user scope decision. Delivery is one chain with a tracker, merged
into `main` once, exactly like phase 1.

## Specs

- **S1** (user, verbatim): "Hagamos todo, pero comieza con las de uso diaro. Con todas esas listas ya recien ahi vas
  con las de producto. Hazlo todo en auto con cadena feacture hasta que este todo mergeando. No te detengas hasta
  terminar todo mergeado"; "lo de foto no, pero lo de escaner si y lo demas igual"; "continua y no te detengas hasta
  terminar todas las fases y ternerlas mergeadas". Phase 1 is delivered; this document covers phase 2 and authorizes
  its push, PRs and merge exactly as phase 1's were.
- **S2** — Order, with one recorded amendment (L4): the code and packaging units land first (U6, U7, U8, U11), and the
  two **device-verification** units land last (U9 TalkBack, U10 the v4 native gate). Reason: a device proof must
  describe the shipped tip; running it before U11 changes the schema would make the proof describe a tree that no
  longer exists. `product-v2.md` S2's "a unit that needs the data model lands before the units that consume it" is
  honored by the same move.
- **S3** — Local-first is a hard constraint of every unit: no backend, no accounts, no network call in any product
  flow. Export is a file the user owns and import reads a file the user picks; nothing is uploaded anywhere.
- **S4** — Test-first, RED first, never weaken or delete an assertion. Units that change user-visible behavior also
  get their device flows re-observed where the flow exists, and a flow that fails is diagnosed from its artifacts
  before it is re-run. New persisted fields follow the phase-1 rule in `AGENTS.md`: a field is not done until the
  form carries it.
- **S5** (U6) — Export/import is one round trip the user controls: export writes a complete, self-describing file
  (locations, categories, items and their per-location stock) and hands it to the system share sheet; import reads a
  chosen file, validates it, and either applies it atomically or refuses with a typed, localized reason. Import must
  never half-apply, never fabricate rows, and never silently drop what the file contains. The file format is
  versioned so a future schema can reject what it cannot read.
- **S6** (U7) — Identity: the app ships an icon, an adaptive icon and a splash derived from the **approved** token
  palette (`src/theme/tokens.ts`, DESIGN.md section 5), produced deterministically in-repo (no AI generation, no
  downloaded binary assets). What the unit decides is written down; PRODUCT.md's "Brand Commitments" section is
  updated to say exactly what is now implemented and what remains unconfirmed — no marketing claim, no voice-and-tone
  guide, no claim that a designer approved it. The user's blanket order is the authorization for choosing an icon;
  nothing beyond that is claimed.
- **S7** (U8) — Distribution preparation only: `eas.json`, app config for releases, and the release process written
  down. ROADMAP section 8's three choices (Google Play internal track vs production, signing ownership, and whether
  review screenshots come from emulator or hardware) are **not decided by this unit**: it records them as the user's
  pending choices. Nothing is uploaded, submitted or signed with a real key; the upload stops at the boundary that
  needs the user's Expo/Play credentials, and that boundary is reported.
- **S8** (U11) — Address uniqueness, the one rule that was never adopted: a location's address is unique after the
  same trim/normalization discipline name uniqueness uses, enforced in the domain **and** by the database, with a
  typed domain error mapped to localized copy (en/es parity). Per this repository's migration policy, a database that
  already holds duplicate addresses fails loudly with a migration-required error instead of being silently rewritten.
- **S9** — Device claims come only from device observation, never from host tests. U10 re-runs the M1/M2 gate
  scripts (`scripts/verify-inventory-schema.py`, the Maestro flows) on a device against the v4/v5 schema the app now
  ships; U9 observes TalkBack speech on the screens the flows cover and fixes what it finds. Only isolated DEV
  fixture databases are created, opened or deleted; the production app is never uninstalled or cleared. The emulator
  is **not** kept running: it is booted (`scripts/boot-emulator.sh`) only for the run that needs it and killed right
  after it (`adb -s emulator-5554 emu kill`) — user instruction, L6.
- **S10** — Delivery: one chain with a tracker per phase, children merged in order into the tracker, the tracker the
  only merge into `main`, merge commits only, nothing merged on a non-passing check, no history rewritten.
- **S11** — A unit that cannot finish inside this environment stops at its own boundary and reports exactly what is
  blocked and what remains, while the rest of the plan continues. Blocked is a result, not a failure.
- **S12** — Reported evidence is what was observed: commands, exit codes, counts, PR numbers and merge SHAs. A
  skipped or unavailable check is reported as skipped, never as passed.

## Tasks

| ID | Unit | Specs | Route | State |
|----|------|-------|-------|-------|
| U6 | Export / import: a file the user owns, through the system share sheet | S3, S4, S5 | worker (worktree) | pending |
| U7 | Identity: icon, adaptive icon, splash, and the brand decisions written down | S4, S6 | worker (worktree) | pending |
| U8 | Distribution prep: `eas.json`, app config, listing metadata, release process | S4, S7, S11 | worker (worktree) | pending |
| U11 | Address uniqueness: domain + database rule, typed error, localized copy | S4, S8 | worker (worktree) | pending |
| U9 | TalkBack verification on the device, plus the fixes it finds | S4, S9 | worker + device | pending |
| U10 | The M1/M2 gate scripts re-run on a device against the shipped schema | S9, S12 | worker + device | pending |
| D | Deliver phase 2: chain with a tracker, one merge into `main` | S10, S12 | parent | pending |

## Log

- **L1** (user, verbatim, carried from `product-v2.md`): "Hagamos todo, pero comieza con las de uso diaro. Con todas
  esas listas ya recien ahi vas con las de producto. Hazlo todo en auto con cadena feacture hasta que este todo
  mergeando. No te detengas hasta terminar todo mergeado".
- **L2** (user, verbatim, carried from `product-v2.md` L4): "lo de foto no, pero lo de escaner si y lo demas igual".
- **L3** (user, verbatim, previous session): "continua y no te detengas hasta terminar todas las fases y ternerlas
  mergeadas".
- **L4** (recorded amendment): phase 1 is delivered — children #31–#34 merged into the tracker, tracker #35 merged
  into `main` as `80056ef` at 2026-10-14T03:31:37Z, `e2d1b6f` an ancestor of `origin/main` with an identical tree,
  issue #30 closed (`odd/tasks/product-daily-use-delivery.md` holds the evidence). Phase 2 branches from `80056ef` in
  the worktree `/home/sv-home/dev/projects/tengo-worktrees/product-readiness`. The unit order is amended as S2 says:
  the two device-verification units run last, on the frozen tip.
- **L5** (measured, before any edit): `herdr worktree create` branched from the principal checkout's HEAD
  (`a2da940`, `feat/inventory-model-v2`) instead of `main`; corrected with `git switch -C feat/product-readiness
  origin/main` and `rm -rf node_modules && npm ci`, because the hook's install came from the wrong lockfile and
  lacked `expo-camera`, `expo-notifications` and `@react-native-community/datetimepicker`.
- **L6** (user, verbatim): "recuerda tras terminar bajar el emulator o subirlo/bajarlo solo cuando lo uses, que no
  este levantado siempre que consume mucho". Read as a standing rule for every device step in this phase, recorded in
  S9. Measured at the time of the instruction: no emulator was running (`adb devices` empty, no `qemu-system`
  process), so nothing had to be stopped. The same rule belongs in `AGENTS.md`, and the device units carry it there.
- **L7** (baseline, measured): on `main` at `80056ef` the suite is 38 suites / 649 tests. A full run while the host was
  busy failed 2 tests in `__tests__/inventory-container.test.tsx` (call-count assertions behind real timers); the suite
  alone passed 49/49 and a rerun on an idle host passed everything in 34s (the failing run took 67s). Known host-load
  flake, not a product defect — rerun before treating those two assertions as a regression.
- **L8** (device units attempted, blocked, stopped): U9/U10 were attempted on 2026-10-14 from
  `feat/product-readiness-05-device-verification` at the tracker tip `9918c02`. The emulator could not start: `sv-home` is
  not in the `kvm` group (`/etc/group` reads `kvm:x:993:` with no members) and `/dev/kvm` is `crw-rw---- root kvm`, so the
  x86_64 AVD reports `x86_64 emulation currently requires hardware acceleration!`; `sudo` needs a password. A root
  container with `--device /dev/kvm` was measured to open the node and the emulator binary needs only `libX11.so.6`, but
  the required native rebuild (`expo prebuild` + `assembleDebug`) saturated the host CPU and was stopped on the
  maintainer's instruction. Per S11 the two units stop at that boundary and are recorded as blocked with the exact
  unblocking steps in `docs/testing.md`; no device claim is made anywhere.
