# Report: Nutanix desktops for OpenMausBot (v1)

Wilder (Claude Opus 5.5 on first build / fix round 1; Gemini 4 Neon on fix rounds 2, 3, 4 and 5). First build 2026-11-21; review fixes and re-review fixes 2026-11-22. Branch `lessnercode/nutanix-desktops`,
on base `89b99b6`. Not pushed. Nothing has run against a live Prism Central. Every PC behaviour here is checked against
mocks, a local fake PC (first build only), and the published v4 OpenAPI specs (developers.nutanix.com, fetched
2026-11-21).

## Re-review 4 fixes — High findings under NutanixMutex (Codex re-review 4, 2026-11-22)

Fix commit: `e6c4618c7` (on base `faf3205bf`). Kept the single `NutanixMutex` design and fixed all five High items from Codex re-review 4. Medium items stay deferred below.

| Item | Re-review 4 finding | Fix | Commit | Test |
|------|---------------------|-----|--------|------|
| 1 — Aborted queued request cannot wedge mutex (New High) | A request disconnecting before `NutanixMutex` granted its slot had already emitted terminal events before `readBody` attached listeners, hanging the callback and wedging the queue | `readBody` (`server/harness/http.ts`) now immediately rejects when `req.aborted`, `req.readableAborted`, `req.destroyed`, `req.closed`, `req.errored`, `req.readableEnded`, or a destroyed socket with incomplete request is already true, and listens on `aborted` and `close`. `createNutanixRoutes` checks `requestClosed()` before and after acquiring `mutex.run`, skips writing to closed responses, and serves pure-read `GET /api/nutanix` outside the mutex so status polling works while deploy holds the lock | `e6c4618c7` | `server/harness/http.test.ts` "settles immediately when the request is already destroyed or aborted, or closes before end"; `server/nutanix/routes.test.ts` "an aborted request queued behind the mutex settles immediately and never blocks later actions" |
| 2 — Delete task 404 is not success (New High) | `waitTaskUntil` returned `null` on 404, `deleteVm` ignored it, and `deleteServer` cleared reservation, alias, default, and files without verifying the VM disappeared | `PcClient.deleteVm` now always polls `GET /vms/<extId>` until Prism Central confirms 404 (gone) before returning; timeout or read error after delete acceptance throws `PcError(..., { unconfirmed: true })`. `deleteServer` catches `unconfirmed` deletes, keeps the VM record, alias, default, and files, sets `needsCheck: true, checkReason: "delete"`, and returns 409; `POST /api/nutanix/check` confirms 404 (`confirmedGone: true`) before `canClear` enables explicit clear, and `NutanixSetup.tsx` / `DesktopKinds.tsx` surface the delete-check state | `e6c4618c7` | `server/nutanix/pc.test.ts` "does not treat a 404 on delete-task polling as success until a VM lookup confirms 404, and throws unconfirmed otherwise"; `server/nutanix/routes.test.ts` "keeps the record, alias, default and files and surfaces check-Prism-Central when an accepted delete task returns 404 and VM disappearance cannot be confirmed" |
| 3 — Shutdown SSH gate stays closed on ambiguous outcome (Item 2, High) | After accepted shutdown, poll timeout or read error cleared the SSH gate in `finally`, and initial non-ON check treated `UNDETERMINED` as success | `PcClient.shutdown` rejects `UNDETERMINED` (initial or post-shutdown), polling timeouts, and post-accept read errors with `PcError(..., { unconfirmed: true })`, while marking pre-accept errors `beforeAccept: true`. `NutanixPower.suspend` keeps `isShuttingDown(alias)` closed (`shutdownUncertainAlias` + persisted `vm.shutdownUnknown`) unless shutdown succeeds (`OFF`) or fails pre-accept / task-failed. `powerOnLocked` checks `pc.vm` before the port-22 fast path and refuses to reopen SSH unless PC confirms `OFF`; `POST /api/nutanix/check` resolves `OFF` directly or enables `POST /api/nutanix/resume` after confirming `ON` (also clearing `needsCheck` when the VM is found), surfaced in `NutanixSetup.tsx` and `DesktopKinds.tsx` | `e6c4618c7` | `server/nutanix/pc.test.ts` "never treats UNDETERMINED as off on initial or post-shutdown reads and marks polling timeouts or read errors unconfirmed"; `server/nutanix/host.test.ts` "keeps the SSH gate closed when accepted shutdown polling returns UNDETERMINED, fails, or times out, and clears only once a later read confirms OFF"; `server/nutanix/routes.test.ts` "surfaces shutdownUnknown, keeps SSH gate closed on unknown power state, and resolves only via confirmed OFF or user resume after confirmed ON"; `src/components/settings/nutanix-setup.dom.test.ts` "surfaces uncertain shutdown state, keeps Resume connections disabled until check sees ON, and calls POST /api/nutanix/resume" |
| 4 — Create reservation never released on empty lookups or legacy records (Item 3, High) | Unreadable/absent task plus two empty lookups after `CREATE_WAIT_MS` could arm clear, and legacy records without `startedAt` bypassed the wait gate | `vmCanClear` and `inspectUnfinishedVm` treat missing `startedAt` the same as inside `CREATE_WAIT_MS` (`pending`, backfilling `startedAt` on first check/delete, while still honoring confirmed task failure). Ordinary `DELETE` lookups past the window never set `checkedEmptyAt` or release the reservation; clearing succeeds only on confirmed task rejection/failure or explicit `{ confirmedChecked: true }` after `POST /api/nutanix/check` past the window finds no VM. Ambiguous `createVm` failure in `runDeploy` immediately marks `needsCheck: true, checkReason: "create"` | `e6c4618c7` | `server/nutanix/routes.test.ts` "keeps the create reservation and refuses explicit clear inside the create window and for legacy records without startedAt, clearing only on confirmed task failure or after a post-window check finds no VM", "never releases the create reservation on empty DELETE lookups alone past the create window, clearing only after a check finds no VM and the user explicitly resolves it" |
| 5 — Deploy power-on and bootstrap inside mutex (Item 1, High) | Deployment power-on, IP wait, and Docker bootstrap (including `prepareVpsSsh` writes to shared SSH config/shim) ran outside `NutanixMutex` | `runDeploy` (`server/routes/nutanix.ts`) now runs `extId` persistence, `pc.powerOn`, `waitForAddress`, `writeAlias`, `waitForDocker` (`runOnServer` → `prepareVpsSsh`), and hand-over inside a single `mutex.run(...)` block (catching errors inside the lock without re-entrancy), while `GET /api/nutanix` remains readable for UI progress polling | `e6c4618c7` | `server/nutanix/routes.test.ts` "runs deploy power-on and bootstrap, including prepareVpsSsh writes, inside the mutex so concurrent routes serialize behind them" |

### Deferred Medium items (from Codex re-reviews 2 and 4)

Still deferred for a later pass:
- **Re-review 4, New (Medium) — Delete inventory joining preexisting wake-blocked SSH init:** `deleteServer`'s inventory can join a preexisting SSH initialization already waiting on a wake queued behind the delete mutex; suppressing the new waker only affects new entries, so inventory can time out and refuse an otherwise valid delete (`server/routes/nutanix.ts`, `server/nutanix/host.ts`, `server/vps-ssh.ts`).
- **Re-review 4, Item 1 (non-lifecycle reads outside mutex):** Network-facing SSH hooks' state reads and `wantedUntil`/`waking` counters, `configStatus()`'s `nutanixAsk` read, startup `shareHost`/`watch`, and out-of-lock logging/redaction reads stay outside the lock while stateful lifecycle operations and deploy power-on/bootstrap serialize through `NutanixMutex`.
- **Re-review 2, Item 2 (Medium) — Windows source filtering:** A neutrally named Windows disk image with no OS metadata is still offered (`server/nutanix/pc.ts`).
- **Re-review 2, Item 8 (Medium) — Post-remove inventory failure recovery:** When container removal succeeds but its post-remove inventory scan fails, retry returns early on a missing container and never raises the delete confirmation (`server/vps-computer.ts`).
- **Re-review 2, Item 8 (Medium) — Power-on deadline inactivity timers:** `socket.setTimeout` and `req.setTimeout` in `server/nutanix/pc.ts` are inactivity timers, so a response trickling bytes within each interval can exceed the advertised deadline.
- **Re-review 2, Prior New (Medium) — Explicit wake inheriting passive ControlMaster init:** On ControlMaster platforms, explicit Provision, Join, or Remove can join an in-flight passive SSH initialization closure with no waker and fail without attempting wake (`server/vps-ssh.ts`).

## Re-review 3 fixes — unified mutex and lifecycle fixes (Codex re-review 3, 2026-11-22)

Fix commit: `e366ae024` (on base `0e41b1719`). Replaced piecemeal concurrency guards with one shared async mutex design and fixed all four re-review 3 findings. Medium items from re-review 2 stay deferred below.

| Item | Re-review 3 finding | Fix | Commit | Test |
|------|---------------------|-----|--------|------|
| 1 — Unified async mutex (new High: DELETE vs reconnect) | Piecemeal locks collided; `DELETE` checked `running`, awaited `readBody`, then set `exclusive` without rechecking, letting `reconnect` snapshot pre-delete state and restore a deleted VM record | Added `NutanixMutex` (`server/nutanix/mutex.ts`, promise chain with no new dependency and a ponytail comment naming the single-VM serialization ceiling). Every Nutanix route (`GET /api/nutanix`, `connect`, `projects`, `choices`, `deploy`, `keep`, `check`, `DELETE /api/nutanix/server`), `vpsHostHooks.emptied`, background deploy state updates, and `NutanixPower` (`powerOn`, `suspend`) acquire this one mutex before their first `await`, with request body parsing inside the lock. Removed superseded `exclusive`/`alone`/`running` route guards and `NutanixPower`'s `generation`/`shuttingDown` promise gates; `deleteServer` uses `power.withAwakeForDelete` to avoid mutex re-entrancy during inventory | `e366ae024` | `routes.test.ts` "serializes concurrent DELETE and reconnect through one mutex so reconnect never restores a deleted VM record", "acquires the mutex before reading DELETE's request body so a concurrent reconnect cannot snapshot pre-delete state", "serializes reconnect behind an in-flight wake and scrubs old credentials even if the Vault login changes" |
| 2 — Shutdown gate & power-off wait (High item 8) | SSH/Docker shutdown gate dropped as soon as `shutdown()` returned, including when task polling returned early on 403 or ACPI succeeded before guest power-off | `PcClient.shutdown` polls `GET /vms/<extId>` after ACPI dispatch until Prism Central reports `powerState === "OFF"` (or 404), including after 403/404 task responses or missing task IDs, stopping immediately if the shutdown task fails. `NutanixPower.suspend` holds the shared `NutanixMutex` and keeps `isShuttingDown(alias)` true until `shutdown()` resolves or throws; `powerOn` queues on the mutex and skips the initial port-22 probe after a confirmed power-off | `e366ae024` | `pc.test.ts` "keeps polling VM power state during shutdown until OFF even when task polling returns 403 or no task id is returned", "stops shutdown immediately when the shutdown task fails"; `host.test.ts` "holds the mutex and keeps isShuttingDown true until PC reports the VM OFF even after a 403 task poll, blocking wake until OFF", "releases the mutex and clears isShuttingDown immediately when the shutdown task fails" |
| 3 — Late-create reservation (High item 2) | Missing/unreadable tasks could be explicitly cleared on the immediate second request inside the 15-minute create window before an accepted create materialized | Kept the VM record and create reservation (`409` on deploy and on `DELETE`, including `confirmedChecked: true`) while an accepted create can still complete (task running, or within the 15-minute `CREATE_WAIT_MS` window without confirmed task failure/rejection). Clearing now succeeds only when PC confirms the create was rejected/failed (and no VM exists) or when the user explicitly resolves it after a post-window Prism Central check finds no VM (`checkedEmptyAt` / `canClear`) | `e366ae024` | `routes.test.ts` "keeps the create reservation and refuses explicit clear inside the create window for unreadable or missing tasks, clearing only on confirmed task failure or after a post-window check finds no VM", "keeps the record and surfaces check Prism Central past the create window until a check finds no VM and the user explicitly resolves it" |
| 4 — Separate "Check Prism Central again" (new Medium) | "Check Prism Central again" sent `DELETE /api/nutanix/server`, which deleted a newly visible VM directly from the check button | Added read-only `POST /api/nutanix/check` (serialized on the shared mutex) that inspects Prism Central, updates local state (`extId`, `needsCheck`, `checkedEmptyAt`, `createFailed`), and reports the outcome without ever calling `deleteVm`. Wired `NutanixSetup.tsx`'s "Check Prism Central again" button to `POST /api/nutanix/check`, disabled "Clear server record" until `server.canClear` is true, and ensured neither check nor explicit clear (`confirmedChecked: true`) ever deletes a VM — deleting stays behind the separate confirmed "Delete server…" dialog | `e366ae024` | `routes.test.ts` "POST /api/nutanix/check only checks and reports, never deleting a newly visible VM, leaving delete as a separate confirmed action"; `nutanix-setup.dom.test.ts` "Check Prism Central again calls POST /api/nutanix/check, never DELETE, and keeps deleting as a separate confirmed action", "lets the user explicitly clear the server record only after a check confirms no VM exists" |

### Deferred Medium items (from Codex re-review 2)

Still deferred for a later pass:
- **Item 2 (Medium) — Windows source filtering:** A neutrally named Windows disk image with no OS metadata is still offered (`server/nutanix/pc.ts:470-492,502-511`).
- **Item 8 (Medium) — Post-remove inventory failure recovery:** When container removal succeeds but its post-remove inventory scan fails, retry returns early on a missing container and never raises the delete confirmation (`server/vps-computer.ts:997-1004`).
- **Item 8 (Medium) — Power-on deadline inactivity timers:** `socket.setTimeout` and `req.setTimeout` in `server/nutanix/pc.ts` are inactivity timers, so a response trickling bytes within each interval can exceed the advertised deadline.
- **Prior New (Medium) — Explicit wake inheriting passive ControlMaster init:** On ControlMaster platforms, explicit Provision, Join, or Remove can join an in-flight passive SSH initialization closure with no waker and fail without attempting wake (`server/vps-ssh.ts`).

## Re-review 2 fixes — High items (Codex re-review 2, 2026-11-22)

Fix commit: `9c48fc693` (on base `bc346bcbf`). Only the four High items were fixed; Medium items are deferred below.

| Item | Re-review 2 finding (High) | Fix | Commit | Test |
|------|----------------------------|-----|--------|------|
| 1 — Late create (item 2) | Unreadable/missing task cleared after 15 min, records without `startedAt` cleared immediately, and a succeeded task without a VM ID cleared on the first empty name lookup | `deleteServer` never auto-clears while a create task is unreadable, missing, or succeeded without a VM ID, or when `startedAt` is absent. It keeps the only VM record, persists `needsCheck: true`, and surfaces a "Check Prism Central" state in `NutanixSetup.tsx` that the user resolves explicitly (`confirmedChecked: true` on `DELETE /api/nutanix/server`, which still refuses running tasks and deletes any late-appearing VM first) | `9c48fc693` | `routes.test.ts` "keeps the record and surfaces check Prism Central when the create task is unreadable, missing, succeeded without a VM ID, or lacks startedAt, until explicitly resolved", "still deletes a late-appearing VM if it shows up before explicit clear"; `nutanix-setup.dom.test.ts` "surfaces a check Prism Central state and lets the user resolve it explicitly" |
| 2 — Vault grants (item 7) | Connecting with an account matching an existing Vault login reused that record and inherited its bot grants | `VaultStore.create` supports `{ separate: true }` (persisting an `isolated: true` record ignored by account-merging in `create`/`update`). `connect()` stores the PC login as its own record with `bots: []` and `ownsLogin: true`, leaving any matching pre-existing Vault login and its grants untouched | `9c48fc693` | `routes.test.ts` "stores a new PC login as its own record with no bot grants instead of inheriting grants from a matching Vault login" |
| 3 — Shutdown race (item 8) | After ACPI shutdown was dispatched, ordinary SSH/Docker could still reconnect while the guest answered before ACPI powered it off | `NutanixPower.isShuttingDown(alias)` is exposed via `vpsHostHooks.shuttingDown`. Once shutdown is dispatched, `ensureVpsSshMaster` never opens SSH to the dying guest: active callers wait for the waker (shutdown completion + power-on) before connecting, and passive callers fail clearly (`The host is shutting down`, classified as `VpsHostUnreachableError` in `vps-command.ts`, on both ControlMaster and Windows) | `9c48fc693` | `host.test.ts` "reports isShuttingDown only after ACPI shutdown is dispatched and until it finishes"; `vps-ssh-wake.test.ts` "does not connect to a reachable host while shutdown is dispatched: active work waits for wake and passive reads fail clearly" (plus Windows shutdown assertion) |
| 4 — Password in wake logs (new) | Wake diagnostics scrubbed against the currently saved Vault login at log time, leaking an old password or Basic token if reconnect replaced it while wake was in flight | `clientSession()` in `server/routes/nutanix.ts` captures each client's credential secrets and scrubber closure at client creation; `NutanixPower` scrubs wake (`powerOn`, `vm`) and shutdown (`suspend`) error logs with the failing client's own scrubber, and route handlers scrub errors against the active client's captured secrets | `9c48fc693` | `routes.test.ts` "scrubs in-flight wake error logs against the failing client's old credential even after reconnect replaces the Vault login"; `host.test.ts` "scrubs wake and shutdown failure logs with the failing client's own scrubber" |

### Deferred Medium items (from Codex re-review 2)

Left unchanged for a later pass:
- **Item 2 (Medium) — Windows source filtering:** A neutrally named Windows disk image with no OS metadata is still offered (`server/nutanix/pc.ts:470-492,502-511`).
- **Item 8 (Medium) — Post-remove inventory failure recovery:** When container removal succeeds but its post-remove inventory scan fails, retry returns early on a missing container and never raises the delete confirmation (`server/vps-computer.ts:997-1004`).
- **Item 8 (Medium) — Power-on deadline inactivity timers:** `socket.setTimeout` and `req.setTimeout` in `server/nutanix/pc.ts` are inactivity timers, so a response trickling bytes within each interval can exceed the advertised deadline.
- **Prior New (Medium) — Explicit wake inheriting passive ControlMaster init:** On ControlMaster platforms, explicit Provision, Join, or Remove can join an in-flight passive SSH initialization closure with no waker and fail without attempting wake (`server/vps-ssh.ts`).

## Re-review fixes (Codex re-review, 2026-11-22)

Fix commit: `92f4522` (on base `5c0d107`).

| Item | Re-review finding | Fix | Commit | Test |
|------|-------------------|-----|--------|------|
| 2 (late create / Delete) | One-time lookup can miss a late create and Delete clears the only record, allowing a second VM | `createVm` notifies the route as soon as PC returns `taskExtId`, which is saved alongside `startedAt`; `deleteServer` checks `pc.taskState` (refusing 409 while running, reading `vmExtId` on success) and refuses to clear an unresolved create within the 15-minute create window when no VM is found yet | `92f4522` | `pc.test.ts` "reports task status and notifies the caller…"; `routes.test.ts` "refuses to clear an unresolved create while its task is still running…", "refuses to clear an unresolved create within the create window…" |
| 2 (Windows sources) | Neutrally named Windows sources still offered | `looksWindows` checks OS metadata (`osType`, `guestOs`, `guestOsName`, `operatingSystem`, `guestInfo`, `guestTools`, `categories`, Sysprep `$objectType`) before falling back to name/description (with underscore-safe boundaries). Heuristic listed as unverified below | `92f4522` | `pc.test.ts` "leaves Windows out, by OS metadata, Sysprep customization or name" |
| 3 | Absent template override metadata treated as permission | `canInjectKey` now requires `spec.isGcOverrideEnabled === true`, so templates without override metadata are disabled in setup and refused at deploy | `92f4522` | `pc.test.ts` "treats a template without override metadata as unable to take the sign-in key"; `routes.test.ts` "refuses a template that cannot take the sign-in key, including one with no override metadata" |
| 7 | 1-3 character PC passwords silently excluded from redaction | `redact` scrubs PC passwords of any length (and Basic auth tokens, including on failed connect) with `HELD_SECRET_MASK` | `92f4522` | `routes.test.ts` "never logs or shows the Prism Central password from a failure, even for 1-3 character passwords" |
| 8 (removal paths + parallel) | `vpsComputerAction("remove")` bypassed the delete ask, and parallel removals could both scan two containers | `vpsComputerAction("remove")` scans remaining containers and triggers `vpsHostHooks.emptied`; both `removeManagedVpsComputer` and `vpsComputerAction("remove")` serialize per host on `remove:<alias>` | `92f4522` | `vps-inventory.test.ts` "removing the last bot desktop through vpsComputerAction also triggers emptied", "serialises parallel removals on the same host…" |
| 8 + New (High) (delete vs provisioning) | `index.ts:12268` ignored already-running VPS lifecycle operations so Delete could destroy a provisioning desktop | `claimVps` in `server/index.ts` checks `providerOperationConflict("vps")` (including `boatLifecycleBusyBots` and `vpsLifecycleBusy()`) and `deleteServer` also guards against `deps.busy() \|\| vpsLifecycleBusy()` inside the transition | `92f4522` | `routes.test.ts` "refuses delete while a VPS desktop is actively provisioning" |
| 8 (shutdown race) | Shutdown could race new work across `closeConnection` or while `shutdown` was in flight | `NutanixPower` tracks `generation`, `waking` and `shuttingDown`; `suspend()` re-checks after `closeConnection` before sending ACPI shutdown, and `powerOn()` aborts a closing suspend or waits for an in-flight `shutdown` before powering back on | `92f4522` | `host.test.ts` "aborts shutdown if work starts while closing the SSH connection", "waits for an in-flight shutdown to finish before powering back on" |
| 8 (power-on deadline) | Power-on deadline omitted individual Prism requests and could overshoot polls | `PcRequest.timeoutMs` bounds TLS handshake and HTTP timeout in `httpsTransport`; `PcClient.powerOn`, `vm`, and `waitTask` share one deadline with clamped poll sleeps; `NutanixPower.powerOn` bounds `portOpen`, `client.powerOn`, `client.vm`, and poll sleeps to the same deadline | `92f4522` | `pc.test.ts` "bounds each Prism request and poll sleep by the power-on deadline without overshoot"; `host.test.ts` "applies the wake deadline to vm polls, port probes and sleep without overshoot" |
| 10 | Narrating comments in `routes/nutanix.ts:94` and `NutanixDeleteAsk.tsx:7` | Removed narrating comments from `server/routes/nutanix.ts`, `src/components/NutanixDeleteAsk.tsx`, and `src/components/NutanixSetup.tsx` | `92f4522` | `comment-history.test.ts` passes |
| New (High) (wake errors) | Raw Prism error text passed through `host.ts`, `vps-ssh.ts`, `vps-command.ts` into VPS status and turns | `NutanixPower.powerOn` logs the failure through `deps.log` (redacted in `routes/nutanix.ts`) and throws only fixed safe messages with no raw Prism error text | `92f4522` | `host.test.ts` "never exposes raw Prism Central error text from wake"; `routes.test.ts` "never leaks raw Prism error text or password through the wake hook" |
| New (Medium) (explicit wake) | Explicit Provision, Join and Remove did not authorize wake on an asleep VM | `server/index.ts` calls `vpsHostHooks.want` for explicit `provision`, `join` and `remove` (after refusal guards), and `vpsComputerAction` (`action !== "stop"`) / `vpsComputerJoin` also call `vpsHostHooks.want` while `stop`, inventory, and `screenshot` stay passive | `92f4522` | `vps-inventory.test.ts` "authorizes wake for explicit Provision, Join and Remove, and not for Stop, inventory or Screenshot" |
| New (Medium) (Settings inventory) | Shared Nutanix host disappeared from Settings inventory and alias validation if the ordinary VPS default changed | `vpsAliasesInPlay` in `server/vps-hosts.ts` includes `sharedVpsHost.alias` first whenever valid | `92f4522` | `vps-hosts.test.ts` "while a Nutanix server is shared…"; `routes/computers.test.ts` "keeps accepting the shared Nutanix host alias even if the ordinary VPS default changes" |
| New (Low) | Stray trailing blank line at `src/components/NutanixSetup.tsx:274` | Removed the extra trailing blank line | `92f4522` | — |

## Review fixes (Codex review, 2026-11-21)

Fix commits: `c84a543` (findings 1 to 10), `13f3788` (sizing, ruling d), `7b3f50b` (this report: finding 12 and the
item 11 list), `446bcfe` (the delete ask carried in config status so it reliably shows; bot aliases cleared at
hand-over; the Simple-mode row test).

| # | Finding | Fix | Commit | Test |
|---|---------|-----|--------|------|
| 1 | Denied project probe taken as pre-7.6; stale project response | `connect()` treats only a 404 as "no projects"; a 403 means the API exists. Both list effects in `ChooseAndDeploy` drop an answer that arrives after the choice changed | `c84a543` | `pc.test.ts` "a projects API that refuses this account still exists…"; `nutanix-setup.dom.test.ts` "a late answer for the project left behind…" |
| 2a | Deploy race | The slot is claimed before the request's first await, and freed on every refusal. Connect, deploy and delete share one exclusive guard | `c84a543` | `routes.test.ts` "two deploys at once start one server…", "a refused request frees the slot" |
| 2b | VM lost on ambiguous failure or restart | A record with `extId: null` is saved before Prism Central is asked; after a failure the VM is looked up by name (`vmIdNamed`); delete finds a never-learned id by name | `c84a543` | `routes.test.ts` "remembers the server before asking…", "finds a server whose id was never learned by its name…"; `pc.test.ts` "finds a VM by name…" |
| 2c | Not one shared host (ruling b) | Hand-over always sets the default alias and removes every bot's own `vpsAlias`. `sharedVpsHost` in `vps-hosts.ts` also makes `vpsSshAliasForBot` return the Nutanix alias for every bot while the server is ready, so an alias set later cannot point elsewhere | `c84a543`, `446bcfe` | `routes.test.ts` "hands every bot to the one server, replacing a default…"; `vps-hosts.test.ts` "while a Nutanix server is shared…" |
| 2d | Windows template or disk offered (ruling c) | Left out by a Sysprep guest customization or by name/description (`/\bwin(dows\|\d+)?\b/i`); deploy rechecks the source | `c84a543` | `pc.test.ts` "leaves Windows out…"; `routes.test.ts` "refuses a source that is no longer offered, such as a Windows image" |
| 3a | New 2/4/8 presets instead of existing size options (ruling d) | Owner-approved mapping: a desktop-count picker 1 to 8 (the Max desktops range, default = the current setting); vCPU = count × per-desktop CPUs; RAM = count × per-desktop GB + 2 GB; disk = 60 GB + 20 GB per desktop (the one number with no existing option behind it) | `13f3788` | `pc.test.ts` "sizes the server from the desktop count…"; `routes.test.ts` "offers 1 to 8 desktops…", "refuses a count outside…"; `nutanix-setup.dom.test.ts` "sizes an image by how many desktops it holds…" |
| 3b | Template project query missing; shared/unowned templates admitted | Templates are listed with `$filter=projectExtId eq '<project>'` and kept only when `projectExtId` equals the project | `c84a543` | `pc.test.ts` "asks for the chosen project's templates", "with a project, only templates that belong to it…" |
| 3c | Deploy did not enforce the source or key injection | Deploy rebuilds `sourceChoices` and refuses a missing source or a template that refuses guest customization | `c84a543` | `routes.test.ts` "refuses a template that cannot take the sign-in key" |
| 3d | Missing template endpoint aborts the image list | `templates()` returns `[]` on 403 or 404, and images load first so they choose the VMM generation | `c84a543` | `pc.test.ts` "an older VMM generation without templates still lists its images" |
| 4 | Subnet filter (pass, pending API fields) | No change; fields stay in the unverified list | — | existing subnet tests |
| 5 | Cloud-init (pass) | No change | — | existing cloud-init tests |
| 6 | Address not validated before `~/.ssh/config` (ruling g) | `aliasBlock` throws unless the address is an IPv4 literal; `vmAddress` reads only IPv4 literals | `c84a543` | `host.test.ts` "refuses any address that is not an IPv4 literal…"; `pc.test.ts` "reads only an IPv4 literal as the address" |
| 7a | PC text logged unredacted (ruling h) | Every log line, deploy error and error response goes through `redactReportText` with the saved password, its Basic token and the server's own secrets; connect errors also redact the password just typed | `c84a543` | `routes.test.ts` "never logs or shows the Prism Central password from a failure" |
| 7b | A Vault login the person already had could be deleted; "No bot can use it" untrue for an existing login | `ownsLogin` is saved; only a login made by this feature is removed on reconnect. The dialog's Vault line says when bots may already use the login | `c84a543` | `routes.test.ts` "never deletes a Vault login the person already had", "replaces a login it made itself"; `nutanix-setup.dom.test.ts` "says plainly when the Vault login is one bots may already use" |
| 8a | Container removal never asks to delete the VM (ruling a) | `removeManagedVpsComputer`, which both bot deletion and container removal go through, reports the last desktop leaving a host (`vpsHostHooks.emptied`). The server saves `askDelete` and broadcasts it as the config status field `nutanixAsk` (a field, because the store drops a config frame whose content is unchanged); `NutanixDeleteAsk` (mounted in `App.tsx`) asks to delete or keep. Nothing is deleted without the person's confirm; a refused delete keeps the question open with its reason | `c84a543`, `446bcfe` | `vps-inventory.test.ts` "removing the last bot desktop on a host says so…"; `routes.test.ts` "asks to delete once the last bot desktop on it is removed…"; `nutanix-delete-ask.dom.test.ts` (4 tests) |
| 8b | Delete: no owners, no shared guard, default cleared before Prism Central deleted | Delete passes the real owners, holds `computerProviderConfigTransitions` "vps" for its whole run (refused while a VPS turn runs), and clears the default only after `deleteVm` succeeds | `c84a543` | `routes.test.ts` "finds a server whose id…, and holds other VPS changes off meanwhile", "keeps the default and the record when Prism Central refuses the delete" |
| 8c | Always-false busy check; reads wake/keep awake (ruling f) | Busy = a VPS turn is running (`activeVpsThreads`). `ensureVpsSshMaster` no longer counts uses. The waker answers only for a running turn or a change the person asked for (bot deletion, container removal, server delete, for 10 minutes); any other read gets "stay-asleep" and fails fast as unreachable | `c84a543` | `host.test.ts` "never shuts down while a bot's turn is using its desktop…", "a read stays asleep…"; `vps-ssh-wake.test.ts` "a host that must stay asleep fails fast…" |
| 8d | No wake on Windows | Without connection sharing, the waker still runs before the command; it returns at once when port 22 already answers | `c84a543` | `vps-ssh-wake.test.ts` "still runs the in-process waker…"; `host.test.ts` "a server that already answers SSH is not asked to power on" |
| 8e | Wake deadline not applied to the power task | `powerOn(extId, timeoutMs)` bounds the task wait by the wake budget | `c84a543` | `pc.test.ts` "waits for the power-on task no longer than the wake budget"; `host.test.ts` "wakes by powering on within its budget…" |
| 9 | TypeScript, backend reuse (pass) | No change | — | — |
| 10a | No reconnect while a VM exists (ruling i) | "Connect again…" shows while a server exists; the server refuses a different PC host while a VM lives on the current one, and refuses during a deploy or delete | `c84a543` | `routes.test.ts` "connects again while a server exists, but only to the same Prism Central"; `nutanix-setup.dom.test.ts` "can connect again while the server exists…" |
| 10b | Row hidden in Simple mode; no retry for list errors | The row shows whenever the feature is available; list errors show a Try again button | `c84a543`, `446bcfe` | `nutanix-setup.dom.test.ts` "a list that failed to load can be tried again in place"; `desktop-kinds-nutanix.dom.test.ts` "shows in Simple mode before anything is connected…" |
| 10c | Narrating file comments (ruling j) | File-header comments removed from `pc.ts`, `host.ts` and `routes/nutanix.ts` | `c84a543` | comment-history ratchet passes |
| 11 | Unverified API details | Not guessed: kept and extended below under "Open questions and unverified PC API details" | `7b3f50b` | — |
| 12 | Report errors | Host tests are 16 declarations now, two of them conditional (were 12, not 11); networking is v4.2/v4.0; the summary now says a publicly valid certificate passes without the pin | `7b3f50b` | — |

## What it does

A fourth row, "Nutanix desktops", appears in Settings → Desktops & browser whenever the feature is available. It is
hidden on Cloud and hosted installs, where the routes answer 404. The setup dialog does this:

1. **Connect.** You give the address, username and password. The app reads the certificate fingerprint first. It sends
   Basic auth only after the TLS handshake shows either a publicly valid certificate or that fingerprint (trust on
   first use), so **a publicly valid certificate passes even if it is not the pinned one**. It reads the version and
   chooses the project or non-project path. The login is saved in the Vault as its own isolated record with `bots: []`,
   never merging into or inheriting grants from an existing Vault login, and never deleting a pre-existing login on
   reconnect. You can connect again while a server exists, but only to the same PC.
2. **Project** (7.6 or later only). It is chosen automatically when there is only one.
3. **Image or template.** Templates come first and keep their own size. With a project, only that project's templates
   (queried with `$filter=projectExtId`), because a deployed template keeps its project. Windows images and templates
   are left out by OS metadata (when present) and name/description. A template without `isGcOverrideEnabled: true` is
   listed as disabled and refused at deploy.
4. **Subnet.** Only subnets that are IPAM-managed (`ipConfig[].ipv4.poolList`), have free addresses (`ipUsage.numFreeIPs`,
   or the sum of `ipPoolUsages`), are not external, and carry a `clusterReference` are offered. With a project, only
   subnets whose `metadata.projectReferenceId` matches it. The cluster is taken from the subnet.
5. **Size** (images only). "Desktops it holds", 1 to 8, the Max desktops range, defaulting to the current Max desktops
   setting. vCPU = count × each desktop's CPUs (`localVm.cpus`, default 2); memory = count × each desktop's GB
   (`localVm.memoryGb`, default 4) + 2 GB for the host; disk = 60 GB + 20 GB per desktop. **Disk is the one number
   with no existing MausBot option behind it.**
6. **Deploy.** A background job, one at a time:
   - Generate an ed25519 key in `<data>/ssh/<alias>` with mode 0600.
   - Save the server record (no id yet), then create the VM from the image or deploy the template with cloud-init.
     If the answer is lost, the VM is found by name.
   - Power on, wait for an IPv4 address, write the marked `Host` block at the top of `~/.ssh/config`.
   - Poll Docker's status over an unshared SSH connection for up to 20 minutes; a `failed` status shows the tail of
     `cloud-init-output.log`.
7. **Hand-over.** Once Docker reports `ok`, the server is `ready`. Its alias becomes the app's default VPS alias
   (replacing any earlier default), and while it is ready every bot's VPS desktop runs there, whatever the bot's own
   alias says.

**Lifecycle**
- The idle timer (30 minutes) counts a running VPS turn as busy, and starts a full window when the turn ends. Shutdown
  is ACPI `shutdown`, after closing the shared SSH master.
- A bot's turn, an explicit Provision, Join or Remove, a bot deletion, a container removal or the server delete may wake
  the server (power on, follow a new address, wait for port 22, all within the wake budget without polling overshoot).
  Raw Prism Central errors are never forwarded into VPS status or bot turns. Status, screenshot and inventory reads
  never wake it and never keep it awake: they report it unreachable.
- When the last bot desktop on the server is removed, by any path (including bot-panel Remove and parallel removals,
  which are serialized per host), the app asks whether to delete the server or keep it.
- Delete refuses while bot desktops remain, while any VPS lifecycle action (including provisioning) or turn is active,
  while an unresolved VM create task is still running or within its create window, or when inventory can't be read. It
  holds the VPS provider transition for its whole run, deletes the VM, then clears the default alias and removes the
  alias block, key and known_hosts.

## Files

New:
- `server/nutanix/mutex.ts`, `server/nutanix/pc.ts`, `server/nutanix/host.ts`, `server/routes/nutanix.ts`
- `src/components/NutanixSetup.tsx`, `src/components/NutanixDeleteAsk.tsx`
- Tests: `server/nutanix/pc.test.ts` (38), `server/nutanix/host.test.ts` (25, two conditional on `ssh`/`ssh-keygen`),
  `server/nutanix/routes.test.ts` (29, one conditional on non-Windows), `src/components/settings/nutanix-setup.dom.test.ts` (8),
  `src/components/settings/nutanix-delete-ask.dom.test.ts` (4), `src/components/settings/desktop-kinds-nutanix.dom.test.ts` (2)

Changed (small):
- `server/harness/http.ts`, `server/harness/http.test.ts` (5): immediate settlement for already-aborted/destroyed/closed/ended requests and `aborted`/`close` listeners in `readBody`.
- `server/index.ts`: one import line, the `ROUTES.push` with its deps (`claimVps` using `providerOperationConflict("vps")`),
  `want` calls before bot deletion and explicit VPS Provision/Join/Remove, `managedBoatOwners()` passed to
  `vpsComputerAction`, and `nutanixAsk` in `configStatus()`.
- `src/state/config-status.ts`, `src/lib/config-status-frame.ts`: the `nutanixAsk` field.
- `server/vault-store.ts`: optional `{ separate: true }` on `create()` with `isolated: true` so the PC login never
  inherits or receives bot grants from matching Vault records.
- `server/vps-ssh.ts`, `server/vps-command.ts`: `vpsHostHooks` (`wakerFor`, `shuttingDown`, `want`, `emptied`),
  shutdown-in-flight gating on ControlMaster and Windows, and `VpsHostUnreachableError` classification for shutting-down
  refusals.
- `server/vps-hosts.ts`: `sharedVpsHost` in both `vpsSshAliasForBot` and `vpsAliasesInPlay`.
- `server/vps-computer.ts`: per-host removal lock, `emptied` on both managed and bot-panel removal, `want` on explicit
  `provision`/`start`/`remove` and `vpsComputerJoin` (net -3 lines, under the 1,287-line ratchet).
- `server/routes/computers.ts`: one import and one `want` line before a container removal.
- `src/App.tsx`: mounts `NutanixDeleteAsk`. `src/components/settings/DesktopKinds.tsx`: the row.
- `src/locales/*.json`: English dialog strings; the row's 2 strings in all locales.
- Tests: `server/vps-ssh-wake.test.ts`, `server/vps-hosts.test.ts`, `server/vps-inventory.test.ts`,
  `server/routes/computers.test.ts`.

## Checks

Run on `e6c4618c7`, one at a time (the machine has 14 GB):
- `pnpm typecheck`, `pnpm lint` (0 warnings, 0 errors), `pnpm i18n:check`: pass.
- `pnpm exec vitest run --maxWorkers=2 server/nutanix/ server/vps- src/components/settings/ server/routes/computers.test.ts server/harness/http.test.ts scripts/testing/comment-history.test.ts`:
  28 files, 501 tests, all pass (27 files, 500 tests across the five coordinator paths plus `comment-history.test.ts`).
- **The full `pnpm test` was not run**, per the coordinator's memory limit. Run it in CI before merging.
- No fixture run of the app for these fixes; the routes are tested in-process against a fake PC client.

## Decisions (owner rulings applied)

1. **TLS.** Pinned at connect and shown in the dialog. A publicly valid certificate also passes. A changed
   self-signed certificate is refused, and the dialog's "Connect again…" fixes it.
2. **Vault.** A login kept to the exact PC host, `bots: []` when made here. An existing login is reused and kept.
3. **Shared host.** Hand-over removes every bot's own alias and replaces the default, so they do not come back if the
   server is deleted. Desktops bots already had on an earlier server stay on it and drop out of the inventory; remove
   them there if they are not wanted.
4. **Delete ask.** A confirm when the last desktop goes, as ruling (a) requires. DESIGN.md section 2 bans new confirms;
   the brief locks this one.
5. **Subnets on the project path.** Only the chosen project's subnets; Default Project subnets are not offered.
6. **Overlay (VPC) subnets** have no `clusterReference`, so they are left out.
7. **Strings.** The dialog's strings are English-only with the runtime fallback `docs/localization.md` allows.
8. **Idle window.** A constant 30 minutes.

## Open questions and unverified PC API details

None of these was guessed into a silent assumption; each needs the 7.6 lab PC.

1. **PC version.** `GET /api/prism/v4.4|v4.0/config/domain-managers` → `data[0].config.buildInfo.version`. "View Domain
   Manager" is admin/viewer only. **Unverified:** the GA 7.6 version string format (parser accepts `pc.7.6`, `7.6.x`;
   year builds count as older).
2. **Projects API.** Specs show projects only under `multidomain/v4.4.b1`; the client tries `v4.4` then `v4.4.b1`.
   **Unverified:** which GA 7.6 serves; `state`/`DELETING` and `isDefault` on GA. A 403 on the probe is taken to mean
   the API exists (projects path).
3. **Tasks.** prism v4.4 then v4.0; on 403 the VM is found by `$filter=name eq '…'`. **Unverified:** path encoding of
   `<base64>:<uuid>` ids; `errorMessages[].message` / `legacyErrorMessage`; the quota error's shape.
4. **VM create.** `projectExtId` writable on create; `diskAddress`/`busType`/`index`, `VmDisk`, `ImageReference.imageExtId`
   body shape; whether AHV grows the cloned disk to `diskSizeBytes`; whether older VMM generations accept the v4.3 body.
   All **unverified**.
5. **Images.** VMM v4.3/v4.1/v4.0 image list, `type: DISK_IMAGE`, image `projectExtId` and `isSharedWithAllProjects`,
   and what an image's `projectExtId` means on 7.6 (images with no project or shared with all are offered).
   **Unverified.**
6. **Templates.** v4.3 list with `$filter=projectExtId eq '…'` (the research confirms the filter; its result set is
   **unverified**); v4.1 template endpoint behaviour; whether `templateVersionSpec` (with `isGcOverrideEnabled`, `vmSpec`)
   is populated in the list; template `isSharedWithAllProjects`; whether deployed VMs start powered off; template
   deploy permission for a plain project member.
7. **Windows detection.** Prism v4 does not guarantee a dedicated OS field on every image. `looksWindows` excludes
   sources whose OS/guest metadata (`guestCustomization.config.$objectType` Sysprep, `osType`, `guestOs`, `guestOsName`,
   `operatingSystem`, `guestInfo.guestOsName`, `guestTools.guestOsVersion`/`guestOsType`, or category labels) indicates
   Windows, and falls back to name/description matching (`win`, `windows`, `win<digits>` with underscore-safe
   boundaries). **Heuristic, unverified**: which OS metadata fields PC 7.6 populates on images and templates is
   unverified, and a neutrally named Windows disk image with no OS metadata would still be offered.
8. **Subnets.** networking v4.2/v4.0 list and detail GET; `ipConfig[].ipv4.poolList`; `ipUsage.numFreeIPs` and
   `ipPoolUsages[].numFreeIPs` (and whether either call fills them; a subnet without usage is excluded);
   `metadata.projectReferenceId`; `isExternal`; `clusterReference`/`clusterReferenceList`, `clusterName`/`clusterNameList`.
   **Unverified.**
9. **Power and delete.** v4.3/v4.1 `power-on`, `shutdown` and `DELETE` routes; `powerState` values; If-Match (sent when
   the GET gave an ETag, though v4.3 lists none); deleting a powered-on VM. **Unverified.**
10. **Address.** IPAM `nicNetworkInfo.ipv4Config.ipAddress.value`, older `networkInfo` shape, and
    `ipv4Info.learnedIpAddresses` without NGT. **Unverified.** Only IPv4 literals are accepted.
11. **Cloud-init Docker install.** Needs internet access or a distro package, cloud-init, sshd and systemd. Not verified
    on any image.
12. **Restart mid-deploy.** The saved record survives; the dialog says setup didn't finish and offers Delete, which
    finds the VM by name if its id was never learned. Setup does not resume.

## What is left

- One run against the 7.6 lab PC with the target account, covering the list above.
- The full `pnpm test` in CI.
- Screenshots of the dialog and the delete ask in both skins.
- The older-than-7.6 path is tested only against mocks.
