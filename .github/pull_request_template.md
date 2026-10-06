<!-- ⚠️ READ BEFORE SUBMITTING
  - Size is enforced: keep the PR within 800 authored lines
    (package-lock.json and vendored .agents/skills/** are excluded from the
    budget but reported separately), or request the maintainer-applied
    `size:exception` label with a documented rationale.
  - Issue linkage and the type:* label are advisory reminders, not merge
    blockers — but filling them keeps review fast.
-->

## 🔗 Linked Issue

<!-- Add `Closes #NNN` (or `Fixes`/`Resolves`) when this PR resolves an
     issue, `Related to #NNN` when it is only connected to one.
     Not every small PR on this repo needs an issue. -->

Closes #

## 🏷️ PR Type

<!-- Check the one kind that best describes this change, and apply the
     matching `type:*` label to the PR. Exactly one. -->

- [ ] `type:bug` — Bug fix (non-breaking change that fixes an issue)
- [ ] `type:feature` — New feature (non-breaking change that adds functionality)
- [ ] `type:docs` — Documentation only
- [ ] `type:refactor` — Code refactoring (no functional changes)
- [ ] `type:chore` — Build, CI, or tooling changes
- [ ] `type:breaking-change` — Breaking change (fix or feature that changes existing behavior)

---

## 📝 Summary

<!-- One to three sentences: what changes and why. No backend, ORM, or
     shared-inventory assumptions: this app is local-first. -->

---

## 📂 Changes

| File / Area | What Changed |
|-------------|-------------|
| `path/to/file` | Brief description |

---

## 🧪 Test Plan

<!-- Paste the observed results of what you actually ran. Mark
     inapplicable checks as such; do not invent successful runs. -->

- [ ] `npm run check` (typecheck + Biome lint + format)
- [ ] `npm run test:ci`
- [ ] `npm run compat` (`expo install --check`)
- [ ] `npm run export:smoke` (if the change touches native config or deps)
- [ ] `actionlint` (if workflows changed)

```bash
# commands you actually ran and their outcome
```

---

## Native persistence / i18n impact

<!-- Does this touch `src/db/` migrations, stored data, or `src/i18n/`
     resources? Unit tests use mocked SQLite and never prove real
     persistence: state what emulator/device evidence exists, or mark
     it pending. Note required migration or translation follow-ups. -->

---

## Risk and review focus

<!-- What should the reviewer check first? Known risks, and what is
     intentionally out of scope. Small PRs preferred: changes much above
     ~800 authored lines should be split unless there is a reason they
     cannot be (`package-lock.json` and vendored `.agents/skills/**` do
     not count toward the budget but are reported separately). -->

---

## 🤖 Automated Checks

The following checks run automatically on this PR (`pr-check.yml`;
review hygiene only, never a rebuild):

| Check | Enforcing | Description |
|-------|-----------|-------------|
| Check PR review size | ✅ Fails | At most 800 authored lines (`additions + deletions`, excluding `package-lock.json` and `.agents/skills/**`), or maintainer-applied `size:exception` |
| Check issue linkage | ⚠️ Advisory | `Closes/Fixes/Resolves #N` (or `Related to #N`) in the visible body |
| Check PR type label | ⚠️ Advisory | Exactly one `type:*` label on the PR |

---

## ✅ Contributor Checklist

- [ ] PR stays within 800 authored lines, or I have requested maintainer-applied `size:exception` with rationale documented
- [ ] Linked issue added above when one exists (`Closes #N`, otherwise `Related to #N`)
- [ ] I have applied exactly one `type:*` label to this PR
- [ ] Lint, format, and type checks pass (`npm run check`)
- [ ] Tests pass (`npm run test:ci`)
- [ ] I have updated documentation if behavior changed
- [ ] My commits follow [Conventional Commits](https://www.conventionalcommits.org/) format
- [ ] My commits do not include `Co-Authored-By` trailers

---

## 💬 Notes for Reviewers

<!-- Optional: anything you want reviewers to pay special attention to. -->
