# Maestro CLI and project MCP

## Scope
Configure the existing Maestro 2.11.0 CLI as a project-local Pi stdio MCP server. Preserve shell settings, existing MCP servers and devices; no reinstall, commits or publication.

## Evidence
Installer already added ~/.maestro/bin to bash/zsh PATH. Absolute CLI --version returned 2.11.0. `maestro mcp --help` rejects --help but renders usage: mcp supports --no-viewer and --working-dir, exposing tools over STDIO. Default system Java prints reflective-mutation warnings; use verified existing JDK21 scoped to server if needed. Pi reads .pi/mcp.json, expands ~/ commands and needs /reload for this session.

## Tasks
- [x] T1 Configure project-local Maestro MCP and concise README usage. Status: done; worker observed connected10 tools; no commit authorized.
- [ ] T2 Install and configure official Maestro Studio AppImage locally for Tengo. Status: pending; installation passed, workspace UI selection remains.
- [x] T3 Verify CLI, stdio tool discovery and Studio launch. Status: done; actual launcher and MCP passed; original no-device-alteration scope failed during cleanup, incident recorded below, not erased by subsequent pass.
- [x] T4 Diagnose accidental emulator termination and restrict Studio backend to localhost. Status: done; localhost bind verified, exact-PID cleanup completed safely; AVD consistency remains unproven.

## Independent findings
Actual launcher boots from repo and HOME; MCP connected10 tools. .pi/mcp.json globally ignored by ~/.config/git/.gitignore .pi/ rule, intentionally leave local. Workspace remains UI-only pending. Studio backend defaults0.0.0.0:5050 with permissive CORS; HOST env controls bind, planned localhost default. No top-level --no-sandbox flag but renderer showed --no-sandbox/--no-zygote; sandbox is partial, not verified fully preserved. Verification cleanup killed qemu Medium_Phone_API_36.1 and netsimd sharing Studio session; no emulator restart attempted, no wipe performed. Incident must remain visible.

## Installation evidence and correction
Worker downloaded official583050233byte x86_64 AppImage, local SHA256 b38c2190b658ffd725e8d8cfea90a1dd3f2cb8134f8fc5046696d84a206d0c51 (no published upstream checksum). User-local install ~/.local/share/maestro-studio, desktop entry and launcher created. FUSE2 absent; extraction booted GUI with sandbox preserved, backend bound0.0.0.0:5050. Parent found launcher still targeted failing direct AppImage and corrected it to extracted/squashfs-root/AppRun; independent actual launcher verification pending. Workspace not persisted; no completion claimed. ASSESS unassessable due undeclared untracked files, high-risk independent verifier required. No review authority changes.

## Studio authorization and source
User explicitly requested local Studio AppImage installation/configuration. Official guide https://docs.maestro.dev/maestro-studio/run-tests-with-maestro-studio links Linux download https://studio.maestro.dev/MaestroStudio.AppImage. It instructs chmod +x, launch, New workspace selecting test directory, then select running device. No cloud submission or account creation authorized.

## Final localhost verification and incident limits
Final verifier muvw0jzx-a-llf0 passed sh/bash syntax and actual launcher: backend listens only [::ffff:127.0.0.1]:5050, logs confirm127.0.0.1. Cleanup signaled only revalidated Studio/main/backend/crashpad PID whitelist; no qemu/netsimd/adb signals, own Studio processes stopped and port closed.
Incident diagnosis confirms earlier session-wide cleanup terminated emulator/netsimd. Studio logged devices/connect API, caller unknown. AVD files remain; read-only qemu-img check without repair exited3 with1 leaked cluster (reported wasted space/no harm to data). This does NOT prove guest filesystem/app consistency. No repair, lock removal, wipe or restart performed.
Workspace selection remains blocked on manual UI: launch maestro-studio, New workspace, select /home/jona/projects/tengo/.maestro. Pi session needs /reload then /mcp. No additional tests or cloud execution performed.

## Checks and delivery
No meaningful test-first RED for passive configuration; validate JSON, real MCP handshake and tool enumeration instead. No device test required: foundation smoke passed previously. Work-unit commits pending explicit user authorization.
