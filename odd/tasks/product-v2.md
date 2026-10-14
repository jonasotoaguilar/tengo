# Product v2 — daily-use features first, then product readiness

Ten units that take Tengo from a finished MVP to something a household can install, trust and use daily. The order is
binding: the daily-use units (U1–U4) land before the product units (U5–U10). Every unit is its own work unit with its own
tests, and the delivery is a feature-branch chain that merges into `main`.

## Specs

- **S1** (user, verbatim): "Hagamos todo, pero comieza con las de uso diaro. Con todas esas listas ya recien ahi vas con
  las de producto. Hazlo todo en auto con cadena feacture hasta que este todo mergeando. No te detengas hasta terminar
  todo mergeado".
- **S2** — Order is binding: U1–U4 (daily use) before U5–U10 (product readiness). Within a phase, a unit that needs the
  data model lands before the units that consume it.
- **S3** — The product's own scope rules apply, with the user's explicit amendments. `PRODUCT.md` lists explicit non-goals —
  backend/accounts/cloud sync, barcode scanning, photos, units conversion, stock analytics, web/marketing/dashboards —
  and the user's order **reopens one of them**: **barcode scanning is in scope**, and **photos stay out**. Low-stock
  reminders and an expiry date are in scope by the same order. Those three additions need a schema version, because
  none of them is derivable from today's data, so they land in one additive migration rather than two.
- **S4** — Local-first is a hard constraint of every unit: no backend, no accounts, no network call in any product flow.
  Notifications are local, export is a file the user owns, and nothing is uploaded anywhere.
- **S5** — Test-first, RED first, never weaken or delete an assertion. Units that change user-visible behavior also get
  their device flows re-observed, and a flow that fails is diagnosed from its artifacts before it is re-run.
- **S6** — Delivery: a feature-branch chain with a tracker, merged into `main`, nothing merged on a non-passing check,
  and no history rewritten.
- **S7** — A unit that cannot finish in this environment stops at its own boundary and reports exactly what is blocked
  and what remains, while the rest of the plan continues. Blocked is a result, not a failure.

## Tasks

| ID | Unit | Specs | Notes |
|----|------|-------|-------|
| U1 | Quick capture: prefill the last location, fewer taps to add | S2, S5 | Small; no model change |
| U2 | **The model (schema v5)**: low-stock threshold per item, expiry date per stock row, barcode per item with a unique index — one additive migration, plus repository and validation | S2, S3, S5 | Medium; lands before every unit that consumes it |
| U3 | Barcode scanning: camera plus permissions, and "scan to find or create" (a re-scan of the same code reaches the same item) | S2, S3, S4, S5 | Large; new dependency (`expo-camera`) |
| U4 | Reminder scheduling: local notifications, Android 13+ permission flow, and the UI to set them | S2, S4, S5 | Large |
| U5 | Home-screen widget: **feasibility gate first**, then the native surface | S2, S7 | Large; may be infeasible here |
| U6 | Export / import: a file the user owns, through the system share sheet | S4, S5 | Medium |
| U7 | Identity: icon, adaptive icon, splash, and the brand decisions written down | S5 | Medium |
| U8 | Distribution prep: `eas.json`, app config, listing metadata, release process | S7 | Medium; the actual upload needs the user's Expo/Play credentials |
| U9 | TalkBack verification on the device, plus the fixes it finds | S5 | Medium |
| U10 | The v4 native gate (M1/M2 gate scripts) re-run on a device | S5 | Small |
| U11 | Address uniqueness, the one rule that was never adopted | S5 | Small |

Delivery is **one chain per phase**: the daily-use units (U1–U5) merge first, then the product units (U6–U11). Each
phase gets its own tracker and its own single merge into `main`, so the household-visible improvements land before the
packaging work starts.

## Log

- **L1** (user, verbatim): "Hagamos todo, pero comieza con las de uso diaro. Con todas esas listas ya recien ahi vas con
  las de producto. Hazlo todo en auto con cadena feacture hasta que este todo mergeando. No te detengas hasta terminar
  todo mergeado".
- **L2** (what this answers): the proposal I made after reading `PRODUCT.md` — that what separates the MVP from a product
  is distribution, data trust and identity, plus daily-use features ranked by value. The user took everything and set the
  order: daily use first.
- **L3** (baseline, measured before any edit): `main` = `bb3d3e3` (the optimizations delivery), branch `feat/product-v2`
  cut from it in its own worktree. Scope notes recorded while reading the docs: `PRODUCT.md` confirms Android-only, one
  household, one on-device database, and states that OS-level backup behaviour outside the app "must not be promised" —
  which is exactly why U5 is an explicit export the user owns rather than a promise. Distribution today is source-only
  GitHub releases (ROADMAP §8): no signing, no EAS, no store upload.
- **L4** (user, verbatim): "lo de foto no, pero lo de escaner si y lo demas igual". Read as: barcode scanning joins the scope,
  photos stay out, everything else in the proposal stands. Consequence recorded in S3: the barcode becomes the item's
  identity (one code, one item, unique index), so it rides in the same additive v5 migration as the threshold and the
  expiry date instead of a second migration. The scanner's value is "scan to find or create": without a product catalog the
  code cannot supply a name, but a re-scan of the same code must reach the same item.
