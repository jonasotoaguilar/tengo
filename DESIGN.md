# Design — Tengo inventory by location

Proposed planning design, not implemented. The working tree contains only
the readiness foundation (`App.tsx`, `src/db/`, `src/i18n/`); no
inventory screen exists. This document plans the MVP UX so
implementation can follow it later. Product truth lives in
[PRODUCT.md](PRODUCT.md); build order and acceptance live in
[ROADMAP.md](ROADMAP.md) (M1–M5, gates, checklist).

## Source artifacts and wireframe boards

Editable boards are the spatial reference; the text sketches in
section 3 are supporting sketches. PRODUCT.md is the scope authority
and this document (DESIGN.md) is the behavior contract: if boards,
sketches, or prose contradict PRODUCT.md or each other, reconcile
explicitly — do not silently change product scope or behavior.

- Editable source: `design/tengo-wireframes.op`
  (page "Tengo wireframes", boards B1–B9; deferred to a later
  deliverable, not in this slice).
- Static map: [design/wireframes/overview.png](design/wireframes/overview.png)
  (all boards at a glance).
- Board notes: [design/wireframes/README.md](design/wireframes/README.md)
  (per-board OS idiom, numbered transitions ①–⑧, pending-approval rules).
- Per-board static exports: `design/wireframes/previews/01–09-*.png`
  (one PNG per board, exported after visual inspection).

| Board | Content | Maps to |
| ----- | ------- | ------- |
| B1 | Populated list, chips filter, search, FAB | Android variant of §3.1 |
| B2 | Same list content, large title, compose-style Add | iOS variant of §3.1 |
| B3 | Search filter + no-results (`quinoa`) | §3.2 |
| B4 | First-run empty, single CTA | §4 empty first-run |
| B5 | Add item form | §3.3 |
| B6 | Edit item form + destructive zone | §3.4 |
| B7 | Field-validation state | §4 field errors |
| B8 | Database error + Retry | §4 DB failure |
| B9 | Delete confirm + dirty-form discard dialogs | §4 destructive / §3.3–3.4 |

Main transitions (full numbered list ①–⑧ in the board notes):

- List B1/B2 → Add B5 via FAB (Android) / + Add (iOS); row tap → Edit B6.
- List search → B3 states; Clear returns to B1/B2; Add "quinoa" → B5 prefilled.
- First launch → B4; CTA → B5.
- B5/B6 Save → list with transient confirm; dirty Back → B9 discard dialog.
- B6 Delete → B9 confirm dialog; no separate read-only detail screen.
- B8 DB failure → Retry reloads from the on-device DB.

Reading notes:

- B1/B2 are OS variants of the same list, not a sequence; B3–B9 are
  states of that list and its form, not a linear flow.
- Arrows on the static map show reachability between boards; they are
  not a clickable prototype.
- Boards are low-fidelity grayscale with English example copy. They do
  not prove `es` parity, theme tokens, contrast, screen-reader behavior,
  or runtime behavior — §§5/7/9 specify requirements that still need
  implementation checks and a device pass.
- All recommended defaults shown on the boards (quantity range, free-text
  locations, optional category, irreversible delete) are proposed and
  unapproved; each needs its ROADMAP.md §9 gate before build (§10).


Mode: Operate. The visitor completes a task (find it, record it,
update it). Scanability, native expectations, and consistency outrank
expression. Brand lives in precise details, not decoration.

## 1. Visual direction and rationale

Quiet stockroom: a calm, legible tool that reads like a well-kept
storage shelf. Restrained color strategy (Operate default): neutral
surfaces tinted from the platform plus one accent reserved for
primary actions, selection, and state. No tabs-for-show, no
dashboard, no marketing ornaments.

- Rationale: the job is lookup and capture under real-world
  conditions (kitchen, garage, one-handed). Familiar platform
  controls beat custom chrome; density and clarity beat personality.
- World in one line: the visual language of labeled shelves and
  storage bins — grouped, scannable, honest about quantity.
- What it refuses: card-stack abundance, gamified counts, dark
  neon, serif display type in buttons and labels.

## 2. Information architecture

One primary list, one creation/edit path, search as a first-class
filter. No forced tab bar: the MVP is shallow enough for a single
stack.

```text
Inventory (list, grouped/filterable by location)
├── Search (filter on the list, not a separate destination)
├── Add item (name, quantity, location, optional category)
└── Item (edit fields; delete behind explicit confirm)
```

Location is the organizing principle: the list groups or filters by
place (e.g. Kitchen, Pantry, Garage), and every item shows its
location at a glance. Detail is justified only as the edit surface:
no separate read-only detail screen is proposed; tapping an item
opens it for editing.

## 3. Screens and flows (proposed)

Conventions below: `[ ]` input, `( )` button, `>` row/tap target,
`---` divider. All copy exists in `en` and `es` before build.

### 3.1 Inventory list (default screen)

```text
[Top app bar: Tengo]
[Search field: Search name, place…    ]
[Location filter chips: All | Kitchen | Pantry | Garage | …]
------------------------------------------
KITCHEN                          12 items
> Rice · x2 · Kitchen                44pt
> Olive oil · x1 · Kitchen           44pt
------------------------------------------
PANTRY                            8 items
> Lentils · x4 · Pantry              44pt
------------------------------------------
( + Add item )  one primary action (FAB on Android, system
                compose button on iOS — never stacked)
```

- Behavior: list opens focused on browse; search filters in place;
  chips filter by location; counts are honest (they reflect the
  current filter).
- Search has exactly one affordance: the inline search field. No
  separate search icon or second entry point.
- Group headers show item counts. Locations derive from item rows,
  so there are no persisted empty groups: a location filter with
  zero matches shows the contextual zero-match state in section 4,
  not an empty header.
- Primary action only: one Add action opening the form (FAB on
  Android, system compose-style button on iOS). Never stacked.

### 3.2 Search

- Typing filters the visible list; scope is name plus location and
  category once the gate decision adopts the recommended default
  (ROADMAP.md section 9).
- Matching is case- and accent-insensitive (`cafe` finds `café`).
- No-match state: names the query ("No results for 'quinoa'"),
  offers clearing the search or adding it as a new item.
- Search state survives rotation; clearing restores the full list.

### 3.3 Add item

```text
[Top bar: < Back | New item | (Save)]
(OS idiom: Save sits in the top bar on iOS per B2/B6;
Android uses a bottom/sticky Save per B5 — position follows §6.)
Name        [ Rice             ]
Quantity    [ (–)  2  (+)      ]
Location    [ Pantry         v ]
Category    [ Grains (optional)]
[Inline error under the field when invalid]
```

- Save stays enabled except while submitting; validation runs on
  submit and on blur, with inline errors in the current language.
  On a submit with invalid fields, focus moves to the first error.
- Quantity defaults to 1; stepper plus direct numeric entry.
- Location is free text with recency suggestions (recommended
  default); category is optional free text with suggested values.
- Cancel/Back with unsaved changes asks to discard (no silent loss).

### 3.4 Edit item (the "detail" surface)

Same layout as Add with title "Edit item". Adds a destructive zone
at the bottom: `( Delete item )` in the error role, requiring the
confirm in section 4. Save confirms with transient feedback
(Snackbar on Android, equivalent transient confirmation on iOS).

### 3.5 Location handling

- Recommended default: free-text places with recency/frequency
  suggestions drawn from existing rows. No managed-list admin UI in
  the MVP (avoids overengineering); suggestions keep entry fast and
  mostly consistent.
- Normalization is limited to trim; matching for suggestions is
  case- and accent-insensitive so "pantry" and "Pantry" converge in
  search even if stored as typed.
- Because locations derive from items, a place with no items has no
  persisted group; selecting its filter yields the contextual
  zero-match state in section 4, never an empty header.
- If the user later approves managed locations, the suggestion row
  becomes the seed of that list without layout changes.

## 4. Interaction, loading, empty, error, destructive states

- Loading: skeleton rows for the list; Save disabled only while
  submitting, input preserved. No bare centered spinner as content.
- Empty first-run: teaches the job ("Nothing here yet — add what
  you keep and where you keep it") with a single `( Add your first
  item )` action. Not a bare "nothing here".
- Empty search or zero-match location filter: names the query or
  place ("No results for 'quinoa'" / "No items in 'Garage'");
  offers `( Clear search )` and, for a name query, `( Add "<query>" )`.
- Errors: field errors inline (name required, quantity invalid);
  DB failure shows a full-state message with `( Retry )`; raw
  SQLite text never reaches the screen.
- Destructive: delete opens a confirm dialog naming the item
  ("Delete 'Rice'? This cannot be undone.") with `( Cancel )` /
  `( Delete )`; success is announced transiently; there is no
  trash/undo in the MVP by recommended default.
- Feedback motion: 150–250 ms state transitions only; no
  orchestrated load sequences; reduced-motion settings replace
  slides/parallax with crossfade or instant.

## 5. Tokens, typography, spacing, touch (proposed)

Semantic role tokens only — raw hex never drives UI, so light/dark
resolve per OS:

- Roles mapped per platform (proposed values, subject to approval):

  | App role | Android M3 role | iOS semantic | Light (proposed) | Dark (proposed) |
  | -------- | --------------- | ------------ | ---------------- | --------------- |
  | background | background | systemBackground | #FFFFFF | #121212 |
  | surface | surface | secondarySystemBackground | #F4F2EC | #1C1C1E |
  | primary action | primary / onPrimary | tint | #2F6B3A / #FFFFFF | #7BC79A / #0B2E18 |
  | secondary container | secondaryContainer | systemFill | #E5E1D5 | #2C2C2E |
  | outline / separator | outline / outlineVariant | separator | #C9C5B8 | #38383A |
  | error | error / onError | systemRed | #B3261E / #FFFFFF | #FFB4AB / #410002 |
  | label | onBackground | label | #1A1C19 | #F2F1ED |
  | secondary label | onSurfaceVariant | secondaryLabel | #5C5F58 | #AEB0AD |
- Contrast floor (proposed, unmeasured until a device pass): text
  at least 4.5:1 against its background; interactive controls and
  focus indicators at least 3:1 against adjacent colors.
- Light: paper-neutral background, one tonal step for grouped
  headers/filter chips; dark: true dark scheme (not an invert),
  tonal elevation per Material, translucency/materials per HIG.
- One accent carries primary actions, selection, and focus; never
  decoration or inactive states.
- Type: system faces only in the MVP (SF Pro/Compact on iOS via
  Dynamic Type styles; Material type scale Body/Title/Label on
  Android in `sp`). One family across the app; tighter scale
  (1.125–1.2). Prose measure 65–75ch where prose appears.
- Spacing: 8dp/pt base grid; 16 screen margins; 8 between related
  rows, 16+ between groups; more space above a header than below it.
- Touch: 44x44 pt minimum on iOS, 48x48 dp on Android, 8dp/pt
  gaps between adjacent targets.

## 6. Native adaptive navigation and system behavior

- Android: top app bar for screen context plus single FAB for Add;
  system Back and predictive Back always work; bottom sheets and
  Material dialogs/snackbars per Material 3.
- iOS: large titles on the top-level list collapsing to inline;
  navigation-stack push for Add/Edit; sheet presentation only for
  self-contained quick add if adopted; edge-swipe back stays alive;
  action sheets/alerts, SF Symbols iconography, no ported Material
  widgets.
- Shared guarantees on both OSes: edge-to-edge layout inside safe
  area and window insets (notch, home indicator, status/navigation
  bars); keyboard (IME) insets keep Save and focused fields
  visible; no control hides behind system bars or the keyboard.

## 7. Accessibility, reduced motion, i18n

- Every interactive element has a localized screen-reader name;
  quantity steppers expose value and increment/decrement actions;
  errors are announced, not color-only.
- Type follows system size settings (Dynamic Type / font scale);
  layout is verified at a large size without truncation.
- Reduced motion (iOS Reduce Motion, Android Remove animations):
  crossfade or instant cuts; content visible by default.
- All strings live in `src/i18n/resources.ts` with `es` parity
  enforced by the existing `typeof en` lock; Spanish is verified on
  a real `es` locale pass, not assumed from English.

## 8. Component contracts (proposed)

- `InventoryList`: props `items`, `state: loading|empty|error|
  ready`, `onSearch`, `onFilterLocation`, `onOpenItem`; never
  fetches directly.
- `SearchField`: controlled query, clear action, accessible label;
  stateless filtering owned by the list.
- `LocationChips`: `locations`, `selected`, `onSelect`; horizontal
  scroll, 44/48 minimum targets.
- `ItemForm`: fields name/quantity/location/category,
  `errors`, `onSubmit`, `submitting`; validation messages inline.
- `QuantityStepper`: integer value, min 0, plus/minus plus direct
  entry; exposes a11y value.
- `DeleteConfirm`: item name, `( Cancel )`, `( Delete )`; returns
  an explicit choice, never deletes on dismiss.
- `EmptyState` / `ErrorState` / `ListSkeleton`: content, action,
  and retry slots; no hardcoded copy.

## 9. UI acceptance criteria

- List, search, add, edit, and delete all work offline with both
  languages; no screen shows untranslated or hardcoded text.
- Empty, loading, error, no-match, and delete-confirm states match
  sections 3–4 on both platforms.
- Touch targets, type scaling, screen reader, dark scheme, keyboard
  behavior, and safe-area handling meet sections 5–7.
- Search is accent-insensitive (folded NFD comparison, stored text
  verbatim); delete always confirms; dismissing a dirty form never
  silently loses input.
- Text contrast meets the 4.5:1 floor and controls the 3:1 floor
  (proposed); ROADMAP.md section 7 performance budgets observed on
  a device pass.

## 10. Roadmap cross-links and unknowns

- Milestones: list/search states → ROADMAP.md M3; add/edit/delete
  → M4; strings/a11y/performance/matrix → M5; schema/validation
  gates → M1–M2.
- Unknowns use recommended defaults (approval still required):
  quantity as non-negative integer 0–999999 without units, zero
  allowed, v1 backfill 1; free-text locations with suggestions and
  an `Unassigned` backfill for v1 rows; optional free-text
  categories searched as a filter; confirmed irreversible delete
  with no trash in the MVP. Each maps to a ROADMAP.md section 9
  gate that must be recorded before build.
