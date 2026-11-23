# Brief: Nutanix desktops for OpenMausBot (v1)

You are Wilder. Read `/home/lowbrow/Documents/claude/ateam/agents/wilder.md` and work in
character. This repo's own rules come first: `AGENTS.md`, `DESIGN.md` and
`docs/verification/README.md`.

Worktree: `/home/lowbrow/orca/workspaces/OpenMausBot/nutanix-desktops`, branch
`lessnercode/nutanix-desktops`. This is a private fork of `milind-soni/OpenMausBot`, and
`upstream` is kept so its changes can be merged in. Keep the Nutanix code in new files and
keep edits to existing files small, so upstream merges stay easy. Do not touch `enterprise/`.
Do not push.

## Goal

Add a fourth row, "Nutanix desktops", to Settings → Desktops & browser
(`src/components/settings/DesktopKinds.tsx`). Its setup connects to a Nutanix Prism Central
(PC), deploys one VM, and hands that VM to the existing "Your own servers" backend. Bot
desktops then run as Docker containers on the VM.

## How "Your own servers" works today (reuse it, do not rebuild it)

`server/vps-*.ts`. The app reaches a host through an alias in `~/.ssh/config` (an SSH shim
with ControlMaster), drives Docker on it remotely, and builds the `trycua/xfce-cua` desktop
image there. Bots point at a host through `vpsAlias` (`server/vps-hosts.ts`). Nutanix only has
to produce a reachable host with Docker and a working alias, then register it the same way a
user-added server is registered.

## Locked decisions

1. **Setup flow:** connect to PC → (PC 7.6 or later, and in several projects) pick a project
   → pick an image or template → pick a subnet → pick a size (images only) → deploy.
2. **One shared VM** hosts every bot. More VMs only when the user asks.
3. **Image list:** PC disk images and VM templates in one list, labelled by type, templates
   first. Templates keep their own size. For images, map MausBot's existing size options to
   vCPU, memory and disk.
4. **Subnets:** offer only subnets whose IP addresses are managed by Nutanix (IPAM) and that
   still have free addresses. On PC 7.6 or later, offer only the subnets in the chosen project.
   The cluster comes from the subnet; the user does not pick one.
5. **Cloud-init at deploy:** create a user, inject the public key, install Docker if it is
   missing, and enable the Docker service. A template that already has Docker skips the install.
   A failed install is reported clearly in setup, never left hanging.
6. **SSH key:** one generated key per VM, private key under `~/.openmausbot/ssh/` with mode
   0600. Write the `~/.ssh/config` alias the VPS code expects.
7. **PC login** (address, username, password) is stored in MausBot's Vault. Find how the app
   stores secrets and use that. Never log the password or write it to `config.json`.
8. **Lifecycle:** power the VM off when no bot has used it for a while, and power it on when a
   bot needs it. Removing the last bot on the VM deletes the VM after the user confirms.
9. **PC API calls in TypeScript inside this repo.** No Python, and no dependency on NutanixBot.
10. **Out of scope:** Flow network lockdown, more than one VM, Windows images.

## PC API

Use the v4 APIs. Read these research files before writing the client, and trust each file's
correction block over its tables:

- `/home/lowbrow/orca/workspaces/ateam/NutanixBot/handoff/research-nutanixbot-2026-11-15.md`
  (projects are v4 `multidomain` on PC 7.6, project-scoped VM create, subnet and cluster lists)
- `/home/lowbrow/orca/workspaces/ateam/NutanixBot/handoff/research-nutanixbot-template-ssh-flow-2026-11-16.md`
  (templates are listed with `GET /api/vmm/v4.3/content/templates`, filtered by project, and
  deployed with `POST .../$actions/deploy`. Disk size cannot be set at template deploy.
  Template deploy permissions are unconfirmed.)

Detect the PC version at connect time, and choose the project path (7.6 or later) or the
non-project path from it. Where the research does not settle an endpoint or a field, such as
how to read the free addresses in a subnet's IPAM pool, say so in your report. Do not guess
silently.

## Done when

All of this is in place:

- Unit tests for the PC client, the subnet filter on both version paths, the image/template
  list, cloud-init generation, and the lifecycle rules, all against mocked PC responses.
  Nothing has run against a live PC.
- The setup screen and row follow `DESIGN.md`, with new strings added through the app's i18n
  (`pnpm i18n:check` passes).
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass. Any test that failed before your change
  is named as such.
- Any check of a running app uses an isolated fixture, per `docs/verification/README.md`.
  Never touch `~/.openmausbot` or the installed app.

Report the files you changed and the tests you added, plus every open question or unverified
API detail. Commit on the branch with clear messages; do not push.
