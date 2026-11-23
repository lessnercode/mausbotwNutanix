FAIL — Nutanix desktop re-review on bd84694
FAIL by inspection on bd84694 for 5c0d107..HEAD against the prior re-review, brief, AGENTS.md and DESIGN.md.
The findings below include unresolved deployment and lifecycle risks and a new wake diagnostic credential leak.
The coordinator reported passing typecheck, lint, i18n:check and 472 scoped tests in 26 files, with the full suite and isolated app verification still open and Prism behavior unverified.

Prior partly fixed items

- 2 partly fixed [High for one-VM recovery, Medium for source filtering]
  - Shared alias fixed at server/vps-hosts.ts:8-16 and the deploy reservation retained at server/routes/nutanix.ts:420-427
  - Late create partly fixed at server/routes/nutanix.ts:225-247,286-315 and server/nutanix/pc.ts:357-369, with saved task IDs and a 409 while the task is known to be running, but an unreadable or missing task followed by an empty name lookup clears the only record after 15 minutes, and old records without startedAt can clear immediately. A successful task without a VM ID also clears the record on the first empty name lookup even though createVm normally polls for later visibility
  - Windows sources partly fixed at server/nutanix/pc.ts:470-492,502-511, with additional metadata detection and a name fallback that still offers a neutrally named Windows disk without OS metadata, as recorded at handoff/report-wilder-nutanix-desktops-2026-11-21.md:181-186
- 3 fixed by inspection at server/nutanix/pc.ts:499-511 and server/routes/nutanix.ts:338-345, with explicit guest-customization override required and enforced at deploy
- 7 partly fixed [High]. Saved credential ownership retained at server/routes/nutanix.ts:369-374 and literal short passwords plus Basic tokens now scrubbed at server/routes/nutanix.ts:119-129,387-402. A matching Vault record still receives the new password with its existing bot grants at server/vault-store.ts:275-285, and first-time setup displays the shared-grant warning only after it receives the saved status at server/routes/nutanix.ts:185-189 and src/components/NutanixSetup.tsx:56-65
- 8 partly fixed
  - Removal paths and the parallel removal case fixed by inspection for successful inventory scans at server/vps-computer.ts:919-950,995-1016. Remaining Medium recovery gap at server/vps-computer.ts:997-1004 when removal succeeds but its post-remove inventory fails, because retry returns early on a missing container and never raises the confirmation
  - Delete guard fixed by inspection at server/index.ts:5906-5927,12268,14961-14966,14991 and server/routes/nutanix.ts:273-283
  - Shutdown race partly fixed [High] at server/nutanix/host.ts:275-285,297-309 and server/vps-ssh.ts:194-207. The post-close check prevents dispatch of a shutdown when work starts during the close, and a wake that enters powerOn waits for an in-flight shutdown. After shutdown dispatch, ordinary SSH can still reconnect while the guest remains reachable and return before calling the waker, letting a new Docker action or desktop session start moments before ACPI takes the VM down
  - Power-on deadline partly fixed [Medium] at server/nutanix/host.ts:292-337 and server/nutanix/pc.ts:45-56,80-115,301-318,385-388. Polling and per-call budgets are clamped, but socket.setTimeout and req.setTimeout are inactivity timers, so a response delivering bytes within each inactivity interval can hold the Prism request beyond the advertised deadline
- 10 fixed for the named comments at server/routes/nutanix.ts:94 and src/components/NutanixDeleteAsk.tsx:7. Prior retry, reconnect and Simple mode changes retained at src/components/NutanixSetup.tsx:144-151,255-259 and src/components/settings/DesktopKinds.tsx:116

Problems marked new in the prior re-review

- High wake error propagation fixed for VPS status and bot turns at server/nutanix/host.ts:256-268,321-330 and server/vps-ssh.ts:207-209, with a separate diagnostic leak below
- High delete during provisioning fixed at server/index.ts:5906-5927,12268,14961-14966,14991 and server/routes/nutanix.ts:273-283, with provisioning and deletion now checking the same lifecycle fences
- Medium explicit wake partly fixed at server/index.ts:15005-15013 and server/vps-computer.ts:963,1062. Provision, Join and Remove now request wake authority, but on ControlMaster platforms they can still inherit an in-flight passive SSH initialization whose closure has no waker, then fail without attempting wake at server/vps-ssh.ts:163-176,194-207,221-226
- Medium shared alias missing from inventory and validation fixed at server/vps-hosts.ts:20-28 and server/routes/computers.ts:249-278
- Low trailing blank line fixed at src/components/NutanixSetup.tsx:270-272

New problem

- [High] Wake diagnostics can log the previous Prism password or Basic token after reconnect. server/nutanix/host.ts:257-258,311-330 logs raw errors from the client created before the request, while server/routes/nutanix.ts:115-139 scrubs against the login currently saved at log time. Reconnect at server/routes/nutanix.ts:367-374,387-398 can replace that password while wake is in flight. The shared Vault scrubber at server/vault-store.ts:600-616 also reads current values, so it cannot reliably catch the old credential in an error that arrives after the save. This violates the brief's requirement to keep the password out of logs.
