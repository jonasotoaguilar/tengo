# Mobile foundation

## Objective
Bootstrap Tengo as a small local-first Expo React Native household inventory app. This feature delivers infrastructure only, not inventory screens or advanced capabilities.

## Scope and decisions
Use TypeScript and npm with a committed lockfile, Expo-compatible dependencies, local expo-sqlite, i18next/react-i18next with English and Spanish, Jest/jest-expo and React Native Testing Library, Maestro smoke flow, Biome and Lefthook pre-commit integration. Configure least-privilege GitHub CI, PR checks, manual/tag release automation and issue/PR templates. Install selected official Expo skills at project scope. No backend, ORM, barcode, shared inventory, publishing or global skill installations. Preserve existing Git history. User has not authorized commits; work-unit commits remain pending authorization.

## Tasks
- [x] T1 Bootstrap Expo TypeScript app and local database/i18n foundation with unit-test scaffolding. Status: done; writer checks passed; no commit authorized.
- [x] T2 Configure Biome quality hooks, Maestro E2E scaffolding, GitHub automation/templates and setup documentation. Status: done; writer checks passed after correction, independent review pending T3; no commit authorized.
- [x] T3 Install verified critical project-scoped skills and independently verify the complete setup. Status: done; local checks, isolated native build, Maestro readiness and SQLite schema/restart passed; no commit authorized.

## Acceptance and checks
App dependency versions must be resolved from the actual Expo template and expo install, not assumed SDK numbers. App starts with a minimal translated setup screen and SQLite initialization. Tests exercise meaningful initialization/i18n behavior with native boundaries clearly mocked; native persistence requires emulator evidence. Run typecheck, lint, unit tests, Expo compatibility checks, export/build smoke as applicable, actionlint and hook checks. Record actual unavailable E2E checks explicitly. Releases must not assume signing credentials or publish automatically. Skills must come from verified reputable sources and have reproducible installation instructions.

## Evidence
Repository initially contains README.md only plus Git metadata; main tracks origin/main and is clean. Parent observed Node v26.8.1, npm 11.19.0, Java, adb and actionlint available; Maestro not on PATH. npm registry reported expo 57.0.26 and create-expo-app 5.0.0. Official expo/skills candidates found with >1k installs: expo-dev-client, upgrading-expo, expo-deployment. Explorer cannot execute shell or fetch current docs; parent supplied environment evidence.

## Verification
T1 writer observed RED (missing implementations), then GREEN: 4 suites/17 tests, strict TypeScript, expo install --check and iOS/Android Hermes export all passed. Parent spot-read src/db/index.ts and package.json. Native SQLite/device locale and E2E remain unverified. Dependencies resolved: Expo 57.0.26, React 19.2.3, React Native 0.86.3. Global npm allow-scripts caused EALLOWSCRIPTS; worker used npm install --ignore-scripts. Independent whole-setup verification pending T3. Test-first applies to executable behavior; pure scaffolding/configuration has no meaningful RED and uses structural/tool checks.

## T2 evidence
Writer observed typecheck, lint (6 warnings in test mocks), format, 17 unit tests, Expo compatibility, Android export and actionlint pass. Fresh npm ci --ignore-scripts and rechecks passed. Repo-managed pre-commit hook installed and clean-index smoke passed; staged-failure enforcement not yet verified. Manual Android E2E workflow and source-only release workflow configured but not executed. Maestro unavailable locally. Workflows SHA-pinned; Maestro installer remains floating and must be investigated for reproducibility. No commits/tags/publishing.

## T3 progress
Installed four official project-scoped Expo skills: expo-dev-client 1.1.0, expo-upgrade 1.0.0, eas-app-stores 1.1.0 and expo-native-ui 1.1.1. Current names were verified via CLI --list because leaderboard aliases were stale. Canonical copies under .agents/skills with REGISTRY.md and skills-lock.json; README documents source d4f4840 and commands. Vendored skills excluded from Prettier; no globals or symlinks. Parent added !/skills-lock.json to project .gitignore to override machine-global ignore and preserve provenance. Independent verifier launched for full checks and isolated hook negative-case verification. Native E2E/release execution remain pending.

## Accepted correction
User explicitly prefers Biome instead of ESLint/Prettier and rejected poor request templates plus missing pr-check. User additionally rejected README quality: rewrite using documentation and cognitive-doc-design skills, reader-task hierarchy and accurate scope/check evidence; do not append implementation diaries. Parent confirmed PR template is generic and .github/workflows/pr-check.yml absent. ci-cd-and-automation skill requires adapted matching assets and CODEOWNERS. Replace the old quality toolchain entirely, update hooks/CI/docs, adapt issue and PR templates to local-first Expo app with concise actionable prompts and observed verification, add skill-based dedicated PR metadata checks without duplicating CI. Prior T2 checks do not prove revised setup. Latest explicit hook choice is Lefthook, overriding the briefly selected Husky and the original custom scripts. Use official Lefthook configuration with Biome, remove obsolete custom management/dependencies, verify staged-file behavior and document reproducible install respecting npm script policy.

## Preliminary verifier evidence
Verifier stopped when requirements changed; actionlint and shell syntax passed, revised quality/tests were not run. Found release archive used HEAD rather than selected tag; hook install overwrote existing hooks; Android build lacked explicit compileSdk36 installation before assemble and Maestro installer was unpinned. Parent forwarded bounded fixes to current T2 writer. API34 emulator is not inherently incompatible with compileSdk36; explicit platform installation avoids reliance on runner preinstallation. Device list empty, Maestro unavailable locally. Skill lock now trackable confirmed.

## Corrected T2 evidence
Writer replaced old tools with Biome 2.5.15 and Lefthook 2.1.17, removed custom scripts/lint-staged, adapted exact CI skill assets for templates and pr-check, added CODEOWNERS and reader-focused README. Explicit SDK36 installation added before Android build, Maestro pinned/checksummed, release now fetches/checks out existing tag and archives its revision. Writer observed check, 17 tests, compatibility, export, actionlint all pass; isolated hook bad-file block, good-file pass and partial-stage preservation observed. No live commits. Parent read README; independent verifier must check Expo Go claim and native smoke proof boundary and unjustified PR budget change.

## Independent verification and remaining corrections
Verifier observed check/typecheck/Biome, 17 unit tests, compatibility, Android export and actionlint all pass. Isolated Lefthook tests proved invalid staged blobs block, valid ones pass and partial stages remain intact; live index untouched. Deterministic pending corrections: README falsely excludes Expo Go for default SQLite and overstates Maestro persistence/locale coverage; Maestro comment links missing heading; pr-check budget tightened from asset800 to400 without approval and counts generated/vendor lines; Android license pipe can fail with SIGPIPE under pipefail; release installs triggering-ref dependencies before checking out selected tag and input handling needs strict validation. Keep T3 open while a bounded writer corrects these files and checks. Native E2E and publishing remain unexecuted.

## Final correction evidence
Writer corrected all six authorized surfaces: README Expo Go and smoke boundaries, PR800 authored-line budget with paginated lock/vendor exclusions and separate reporting, SDK license producer SIGPIPE handling preserving consumer status, strict env-fed semver validation and exact existing-tag checkout before install. Writer fixture checks passed under/over/boundary/pagination/exclusions/exception size cases, license success/failure, valid/missing/injection-shaped tags. check,17tests,actionlint passed. Targeted independent recheck launched; no commits/releases/native runtime verification.

## Native review status
Native lineage review-3d871349ebd9d038 created for setup slice (excluding task doc and globally ignored vendored skills), high tier. Four reviewers and refuter completed; severe duplicated finding R3-smoke-db-oracle/R4-smoke-false-ready confirmed smoke selector could match English title instead of DB state. Accepted12 diff-line plan; parent mechanically scoped both wait/assert to readiness-db-state plus ^ready$ in .maestro/smoke.yaml. Native validator attempted one model run but admission rejected missing JSON object; mutation_performed:false, slot not consumed. Fresh bound STATUS reoffers targeted_validation_required. No approval/acknowledgement/authority burn. Prior functional checks passed; native E2E remains pending. No user-authorized commits or publication.

## Authorized retry
User chose no report and explicitly authorized retry. Fresh STATUS reoffered same targeted validator. One new model run again refused at admission: no complete JSON object (126 bytes), mutation_performed:false, slot unconsumed. Fresh reconciliation STATUS still reoffers targeted_validation_required. Stop automatic retries; no report per user, no approval/acknowledgement/burn.

## Authorized next step
User said to leave the failed review alone and authorized recommended Android emulator verification. Do not retry review, report it, or change its authority state. T3 now includes native verification of existing foundation: existing emulator/JDK inspection, debug build and corrected Maestro smoke if feasible, read-only schema/restart inspection. No source changes, global OS installs, device wipes, commits or publishing. Only generated ignored native/build output and temporary checksum-verified Maestro tools are allowed. Verifier muvsy795-b-copi launched. Prior native review remains unapproved.

## Android environment evidence
Verifier inspected only; no build/emulator/Maestro/native checks ran. Existing AVD Medium_Phone_API_36.1, SDK36/build-tools36, adb empty, Maestro unavailable. Installed JDK21/22/25/26 but no17; node_modules currently absent. Verifier initially treated missing17 as hard blocker; parent requested bounded read-only diagnostic because Java sourceCompatibility17 is not proof Gradle cannot run JDK21. Recheck actual Gradle/AGP runtime compatibility before proposing OS installation. Dependency directory absence differs from earlier successful checks; no deletion cause inferred.

## Corrected environment diagnosis
node_modules is present (467 entries); prior missing claim came from flawed && inspection. No deletion occurred. Installed Expo57/RN0.86 uses Gradle9.3.1 and AGP8.12; Gradle runtime supports Java17..25 and existing Temurin21.0.11 is usable. Java26 unsupported. Source/bytecode target17 is not daemon-only17; compile jvmToolchain17 may still need actual17 later, unverified until build. Parent forwarded corrected evidence and resumed isolated native build with existing JDK21; no global installs/source edits.

## Android build attempt
Isolated prebuild passed; Gradle9.3.1 ran with JDK21 and executed28tasks, then assembleDebug failed exit1 (85seconds) because NDK is not configured. Observed AGP preferred NDK27.0.12077973; RN catalog also lists27.1.12297006. Host SDK has neither NDK nor cmdline-tools. No SDK packages installed. No APK, emulator/Metro/Maestro/schema/restart checks ran. Original manifest/lock/app config hashes and Git state unchanged; original android directory absent. Scratch copy/log at /home/jona/projects/tengo-android-verify-muvt2/assembleDebug.log; no verifier-started processes left running.

## Authorized SDK installation
User explicitly authorized Android Command-line Tools and NDK27.0.12077973 installation in existing user SDK, no sudo or system Java changes. Delegated verified official downloads/install, preserve existing SDK, only required packages, then one isolated build attempt and emulator/Maestro/schema verification if build succeeds. No speculative second NDK, source edits, device wipes, commits, publication or review retries. Active verifier muvtytfp-1-46ze.

## SDK installation result
Authorized Command-line Tools revision23 and NDK27.0.12077973 installed from official Google archives; sizes/SHA1 matched published repository metadata. Existing SDK preserved; no second NDK. JDK21 subprocess-only. Isolated build failed first missing sdk.dir; scratch-only local.properties added, then still NDK-not-configured. Expo root explicitly prints27.1.12297006 though AGP message recommends default27.0. Original source hashes unchanged; no APK/emulator/Maestro/schema checks. Logs in /home/jona/projects/tengo-android-verify-muvt2/assembleDebug-{ndk,sdkdir}.log. Parent requested read-only causal diagnostic to distinguish actual configured NDK pin from generic AGP fallback before further installations.

## Confirmed NDK root cause
Gradle help --info confirmed sdkFolder=/home/jona/Android/Sdk, requested module ndkVersion27.1.12297006, searched only ndk/27.1.12297006 and ndk-bundle. Installed27.0 is valid but unused. AGP8.12 failure hardcodes preferred27.0 in generic error; it is not the searched version. Parent's initial installation recommendation was wrong: should have established configured pin before installation. Required correction is install only ndk;27.1.12297006 with explicit user consent; no source change. Existing27.0 not removed without authorization.

## Authorized required NDK
User explicitly authorized NDK27.1.12297006 installation and resumed native build verification. Verifier muvuqr2v-3-phk9 installs only confirmed revision in existing user SDK, preserves prior27.0 and all source files, then constrained isolated build and runtime checks if successful. No extra installs/sudo/review retries/publication.

## Required NDK result and next blocker
NDK27.1.12297006 (official r27b archive, SHA1/size verified) installed; previous27.0 preserved. Source identities unchanged. Isolated x86_64 assembleDebug advanced past NDK then failed after35seconds: :expo:generateDebugRFile requires missing Build Tools35.0.0, though root chooses36 and SDK has36/36.1. No APK/emulator/Maestro/SQLite native checks. No processes left running. Log: /home/jona/projects/tengo-android-verify-muvt2/assembleDebug-ndk271.log.

## Broader build-environment authorization
User explicitly authorized completing required build tooling without asking per package ('si, deja de pregunta y dejalo todo listo'). Install BuildTools35.0.0 and only further demonstrably required official SDK components in existing user SDK; portable scoped JDK17 only if actual compile toolchain error requires it. No sudo/system Java defaults/global OS installs/data wipes/source edits/commits/publication/review retries. Preserve existing components. Native verifier muvuyd4y-4-s2js tasked to finish actual build/emulator/Maestro/read-only schema/restart verification or report genuine code/network/resource boundary, not stop for routine authorized SDK packages.

## Native build success and device capacity
Installed official verified BuildTools35.0.0 and CMake3.22.1; both NDKs preserved. Isolated JDK21 x86_64 assembleDebug PASSED, APK49,102,464bytes produced (no JS bundle; Metro needed). Existing AVD booted but install failed internal-only insufficient /data space (325MB free); no wipe/deletion. Metro and pinned/checksummed Maestro prepared; smoke/SQLite not executed because no app install. Source hashes unchanged; own processes stopped. Under broad finish-setup authorization, parent delegated separate temporary AVD using existing installed image and isolated ANDROID_AVD_HOME, ample data, no changes to user AVDs or image downloads.

## Final native runtime evidence
Verifier muvv71sl-5-x1sh created Tengo_verify_api36_1 under isolated verify-avd using existing API36.1 Play x86_64 image, 10GB data/2GB RAM; existing user AVD unchanged. APK installed successfully. Initial Metro --localhost bound IPv6::1 only and caused Unable to load script; restarting with --host lan plus adb reverse resolved bundle access. Corrected Maestro2.11.0 smoke PASSED twice, including readiness-db-state exact ^ready$. Log: /home/jona/projects/tengo-android-verify-muvt2/verify-avd/maestro-smoke2.log.
Read-only device database files/SQLite/tengo.db had user_version=1, expected items(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT(datetime('now'))) schema and zero rows. Bytes identical before/after force-stop/relaunch/ready. This proves schema/version survives restart, not CRUD persistence. English screen observed on en-US device; Spanish/device-locale switching not tested. Original source identities unchanged; no original android directory; started emulator/Metro stopped, temporary AVD and evidence retained. No commits or publication by explicit user constraint.

## Next step
Foundation verification complete; inventory screens/CRUD remain outside this scope. Spanish runtime validation and CI/release execution remain unexecuted. Preserve paused review per explicit user instruction; no retry or invented approval. Work-unit commits remain pending user authorization.
