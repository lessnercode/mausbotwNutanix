# STATE: Nutanix desktops worktree

Updated 2026-11-21. Overwrite this file as things change. Delete it before the branch merges.

Worktree `/home/lowbrow/orca/workspaces/OpenMausBot/nutanix-desktops`, branch
`lessnercode/nutanix-desktops`. Orca repo id `23d9c03a-2704-406d-801e-f04078b4f02d`. The main
checkout is `~/Documents/claude/OpenMausBot`, with `origin` = `lessnercode/OpenMausBot`
(private) and `upstream` = `milind-soni/OpenMausBot`. The brief is
`handoff/brief-wilder-nutanix-desktops-2026-11-21.md`. The decisions are in open-brain
(search "Nutanix Desktops for OpenMausBot").

## In flight

Orca run `run_7adcd2dea1c1`. The owner set the models: Claude Opus 5.5 builds and Codex
`gpt-6.2-sol` at medium effort reviews.

- Build: done (`c6bde01`, 3 commits on top of `89b99b6`). Report:
  `handoff/report-wilder-nutanix-desktops-2026-11-21.md`. The full `pnpm test` was stopped
  after an hour, so the whole suite is unconfirmed.
- Review: done, verdict FAIL. Findings are in
  `handoff/review-codex-nutanix-desktops-2026-11-21.md` (uncommitted). The coordinator
  confirmed the deploy race, the always-false busy check, and the unvalidated `HostName`
  written to `~/.ssh/config`. Pane `term_34c1208e-2d75-4475-8e75-cefdb3241a86` is idle.
- Fix round: done on Opus 5.5 (`c84a543`..`d2820f0`, 5 commits). The coordinator re-ran the
  checks: typecheck, lint and i18n:check passed, and 454 of 454 scoped tests passed.
- Re-review: done on `d2820f0`, verdict FAIL. Fixed: 1, 4, 5, 6, 9, 11, 12. Partly fixed: 2, 3,
  7, 8, 10. Also 2 new High and 2 new Medium problems. The text is in
  `handoff/rereview-codex-nutanix-desktops-2026-11-22.md`. It was recovered from the Codex
  session log because the worker_done arrived with no body.
- Fix round 2: done on Gemini 4 Neon (`92f4522`, report `bd84694`). The coordinator re-ran the
  checks: typecheck, lint and i18n:check passed, and 472 of 472 scoped tests passed.
  `user.name` and `user.email` are now set in this repo's git config.
- Re-review 2: done on `bd84694`, verdict FAIL. 4 items are High: late-create recovery,
  Vault grant reuse, the shutdown/reconnect race, and the old password leaking into wake logs
  after a reconnect. The text is in `handoff/rereview2-codex-nutanix-desktops-2026-11-22.md`.
- Fix round 3: done (`9c48fc6`, report `d2082e6`). The coordinator ran the checks: 479 of 479
  scoped tests passed. Re-review 3: FAIL. Fixed: Vault grants and the old password in wake
  logs. Partly fixed: late create and the shutdown race. New High: DELETE takes its lock after
  awaiting the body. New Medium: "Check Prism Central again" deletes a VM it finds. The text is
  in `handoff/rereview3-codex-nutanix-desktops-2026-11-22.md`.
- Fix round 4 (owner approved 2026-11-22): one lock for every Nutanix action, SSH blocked until
  the VM is off, create reservation kept, check never deletes. Done: `e366ae0`, report `114d6d0`; coordinator checks passed (487 of 487 scoped tests). Was task `task_b5bb90262b26` on Neon,
  pane `term_9d6febe2-c53a-421a-90ea-8d5b689a6d0d`, dispatch `ctx_6f6161818135`. Review task
  `task_c3d9f76c010c` (Codex) done, verdict FAIL. Fixed: check never deletes; DELETE vs reconnect race. Still open (High): SSH gate drops on poll timeout, create reservation drops after empty lookups, an aborted queued request wedges the lock, a 404 on delete is treated as success. Text in `handoff/rereview4-codex-nutanix-desktops-2026-11-22.md`. Fix round 5: done (`e6c4618`, report `4eb3b39`) after a reboot killed the first worker. Coordinator checks passed: typecheck, lint, i18n:check, 500 of 500 scoped tests. No fifth review, by plan. Branch pushed to origin (2026-11-22). The owner will build and run the live 7.6 test from a different machine; test kit: https://claude.ai/artifact/WQ9QBfVLeCgzHTFgDD6sjm
- Antigravity panes: `--mode auto` still asks before each file edit and each new kind of
  command. Launch with `--mode accept-edits`. The command allow-list is in
  `~/.gemini/antigravity-cli/settings.json` (backup `.bak-2026-11-22`). `git push` is not on it.
  Commands starting with `export PATH=…` still ask.
- Owner rule (2026-11-22): every build and fix run after the current Opus fix round runs on
  Antigravity with Gemini 4 Neon. The pane command is
  `agy --model gemini-4-neon-high --mode auto` (`agy models` lists low, medium, high and
  xhigh). It has not been tried yet as an Orca `worker-start` pane. Reviews stay on Codex
  `gpt-6.2-sol` at medium effort.
- GitHub Actions is disabled on `lessnercode/OpenMausBot` (owner, 2026-11-22). Pushing
  upstream `main` had run CI and published `ghcr.io/lessnercode/openmausbot` and
  `openmausbot-cloud-home`. The owner may delete those images.
- The first review attempt was killed when the machine ran out of memory, because `tsc` takes
  about 4 GB on this 14 GB laptop. Run heavy checks one at a time.
- The coordinator ran the checks on `c6bde01`, one after another. Typecheck, lint and
  i18n:check passed. Vitest on `server/nutanix/`, `server/vps-*` and
  `src/components/settings/` passed 412 of 412 tests. The full suite was not run. pnpm is at
  `~/.npm/_npx/179a5fd3f63fede5/node_modules/.bin` and is not on PATH.
- The out-of-memory killer also killed the installed MausBot app and an Orca window process.
  Reopen them if needed. The reviewer's leftover copies are in `/tmp/omb-nutanix-review.OxZqgf/`
  and can be deleted.

## Waiting on the owner

- The 7.6 lab PC address and username. The password goes into the app's Vault, never into chat.
- Any PC older than 7.6 to test against. Without one, that path ships marked "untested".

## Unproven

- Nothing has run against a live PC.
- How to read the free addresses in a subnet's IPAM pool through v4.
- Whether template deploy works with project-level permissions.

## Machine state outside the repo

- The installed `/opt/OpenMausBot` 0.1.175 and `~/.openmausbot` were installed only for
  inspection. The owner does not need them protected.
- `LICENSING.md` says customer-specific work belongs in its own repo "never as a fork". This
  private fork is for the owner's own use, so that is not a concern unless it is shared.
