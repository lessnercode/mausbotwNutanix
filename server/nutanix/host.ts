import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { connect, isIP } from "node:net";
import { dirname, join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "../atomic.ts";
import { ComputerIdleTimer } from "../computer-idle.ts";
import { VPS_SSH_DIR } from "../vps-ssh.ts";
import { NutanixMutex } from "./mutex.ts";
import { PcCertificateError, PcError, type PcClient } from "./pc.ts";

export const DESKTOP_USER = "mausbot";
/** cloud-init writes `ok` or `failed` here once Docker is installed and running, or could not be. */
export const DOCKER_STATUS_FILE = "/var/lib/openmausbot/docker";
export const NUTANIX_STATE_FILE = "nutanix.json";
export const NUTANIX_IDLE_MS = 30 * 60_000;

/** Installs Docker only where it is missing, so a template that has it goes straight to enabling the service. */
const DOCKER_SCRIPT = `#!/bin/sh
set -u
mkdir -p ${dirname(DOCKER_STATUS_FILE)}
if ! command -v docker >/dev/null 2>&1; then
  if command -v curl >/dev/null 2>&1; then curl -fsSL https://get.docker.com | sh; fi
  if ! command -v docker >/dev/null 2>&1; then
    if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y docker.io
    elif command -v dnf >/dev/null 2>&1; then dnf install -y docker
    elif command -v yum >/dev/null 2>&1; then yum install -y docker
    elif command -v zypper >/dev/null 2>&1; then zypper --non-interactive install docker
    fi
  fi
fi
if command -v docker >/dev/null 2>&1 && systemctl enable --now docker && usermod -aG docker ${DESKTOP_USER} && docker info >/dev/null; then
  echo ok > ${DOCKER_STATUS_FILE}
else
  echo failed > ${DOCKER_STATUS_FILE}
fi
`;

/** The cloud-config for a new desktop server: our user with the key, no password logins, Docker installed and running. */
export function desktopCloudInit(publicKey: string): string {
  const key = publicKey.trim();
  if (!/^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+( [^\n]*)?$/.test(key)) throw new Error("not an OpenSSH public key");
  const indented = DOCKER_SCRIPT.trimEnd().split("\n").map((line) => `      ${line}`).join("\n");
  return [
    "#cloud-config",
    "users:",
    "  - default",
    `  - name: ${DESKTOP_USER}`,
    "    shell: /bin/bash",
    "    sudo: \"ALL=(ALL) NOPASSWD:ALL\"",
    "    ssh_authorized_keys:",
    `      - ${JSON.stringify(key)}`,
    "ssh_pwauth: false",
    "disable_root: true",
    "write_files:",
    "  - path: /usr/local/sbin/openmausbot-docker",
    "    permissions: \"0755\"",
    "    content: |",
    indented,
    "runcmd:",
    "  - [/usr/local/sbin/openmausbot-docker]",
    "",
  ].join("\n");
}

export interface DesktopFiles {
  key: string;
  knownHosts: string;
}

/** Each server's key lives in the data folder's ssh directory, readable only by this user. */
export function desktopFiles(dataDir: string, alias: string): DesktopFiles {
  const dir = join(dataDir, VPS_SSH_DIR);
  return { key: join(dir, alias), knownHosts: join(dir, `${alias}.known_hosts`) };
}

function run(file: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr).trim().slice(-1000) || error.message));
      else resolve(String(stdout));
    });
  });
}

/** A fresh ed25519 key for one server. Returns the public half. */
export async function createDesktopKey(files: DesktopFiles, comment: string, keygen = "ssh-keygen"): Promise<string> {
  mkdirSync(dirname(files.key), { recursive: true, mode: 0o700 });
  chmodSync(dirname(files.key), 0o700);
  rmSync(files.key, { force: true });
  rmSync(`${files.key}.pub`, { force: true });
  await run(keygen, ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", files.key]);
  chmodSync(files.key, 0o600);
  return readFileSync(`${files.key}.pub`, "utf8").trim();
}

export function removeDesktopFiles(files: DesktopFiles): void {
  for (const path of [files.key, `${files.key}.pub`, files.knownHosts]) rmSync(path, { force: true });
}

const blockStart = (alias: string) => `# >>> OpenMausBot Nutanix desktop server ${alias}`;
const blockEnd = (alias: string) => `# <<< OpenMausBot Nutanix desktop server ${alias}`;

/**
 * The alias the VPS code connects through. host keys are new for every server, so the first one is accepted and kept.
 * Security: the address must be an IPv4 literal, or Prism Central's answer could add lines to ~/.ssh/config.
 */
export function aliasBlock(alias: string, ip: string, files: DesktopFiles): string {
  if (isIP(ip) !== 4) throw new Error("Prism Central reported an address that isn't an IPv4 address");
  return [
    blockStart(alias),
    `Host ${alias}`,
    `  HostName ${ip}`,
    `  User ${DESKTOP_USER}`,
    `  IdentityFile ${JSON.stringify(files.key)}`,
    "  IdentitiesOnly yes",
    "  StrictHostKeyChecking accept-new",
    `  UserKnownHostsFile ${JSON.stringify(files.knownHosts)}`,
    // Lines after a Host line belong to it, so the person's own top-of-file settings go back to applying to every host.
    "Host *",
    blockEnd(alias),
    "",
  ].join("\n");
}

function withoutBlock(text: string, alias: string): string {
  const start = text.indexOf(blockStart(alias));
  if (start < 0) return text;
  const endMarker = text.indexOf(blockEnd(alias), start);
  if (endMarker < 0) return text;
  const lineEnd = text.indexOf("\n", endMarker);
  return text.slice(0, start) + (lineEnd < 0 ? "" : text.slice(lineEnd + 1));
}

/** ssh keeps the first value it reads, so the block goes first, ahead of any `Host *` in the person's own file. */
export function writeAlias(sshConfig: string, block: string, alias: string): void {
  const target = existsSync(sshConfig) ? realpathSync(sshConfig) : sshConfig;
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const before = existsSync(target) ? readFileSync(target, "utf8") : "";
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : 0o600;
  writeFileAtomic(target, block + withoutBlock(before, alias), { mode });
}

export function removeAlias(sshConfig: string, alias: string): void {
  if (!existsSync(sshConfig)) return;
  const target = realpathSync(sshConfig);
  const before = readFileSync(target, "utf8");
  const after = withoutBlock(before, alias);
  if (after !== before) writeFileAtomic(target, after, { mode: statSync(target).mode & 0o777 });
}

/** What is kept about the PC and its one server. Never a password: that is in the Vault, under `loginId`. */
const stateSchema = z.object({
  pc: z.object({
    address: z.string().min(1),
    loginId: z.string().min(1),
    /** The login was made here, not one the person already had in the Vault, so it may be removed on reconnect. */
    ownsLogin: z.boolean().default(false),
    fingerprint: z.string(),
    version: z.string().nullable(),
    projects: z.boolean(),
  }).optional(),
  vm: z.object({
    /** Null from just before Prism Central is asked to create it until its id is known; it is then found by name. */
    extId: z.string().min(1).nullable(),
    taskExtId: z.string().min(1).nullable().optional(),
    startedAt: z.number().optional(),
    createRejected: z.boolean().optional(),
    createFailed: z.boolean().optional(),
    name: z.string().min(1),
    alias: z.string().min(1),
    /** Null until Prism Central reports the address IPAM gave it. */
    ip: z.string().min(1).nullable(),
    projectExtId: z.string().nullable(),
    /** Docker reported running; until then the server is neither powered around use nor handed to bots. */
    ready: z.boolean().default(false),
    /** The last bot desktop on it was removed: ask the person whether to delete the server. */
    askDelete: z.boolean().optional(),
    /** Create or delete outcome could not be confirmed: the person must check Prism Central before clearing the record. */
    needsCheck: z.boolean().optional(),
    /** Whether the unresolved Prism Central check is for a create or delete attempt. */
    checkReason: z.enum(["create", "delete"]).optional(),
    /** Prism Central confirmed this VM no longer exists (GET by id returned 404). */
    confirmedGone: z.boolean().optional(),
    /** When a Prism Central check past the create window last confirmed no VM existed. */
    checkedEmptyAt: z.number().optional(),
    /** Shutdown was accepted but Prism Central could not confirm the VM is OFF: keep SSH closed until resolved or PC confirms OFF. */
    shutdownUnknown: z.boolean().optional(),
    /** A Prism Central check saw the VM still ON while `shutdownUnknown` is set, enabling explicit user resume. */
    shutdownCheckedOn: z.boolean().optional(),
  }).optional(),
});
export type NutanixState = z.input<typeof stateSchema>;

export function readNutanixState(dataDir: string): z.output<typeof stateSchema> {
  try { return stateSchema.parse(JSON.parse(readFileSync(join(dataDir, NUTANIX_STATE_FILE), "utf8"))); }
  catch { return {}; }
}

export function writeNutanixState(dataDir: string, state: NutanixState): void {
  writeFileAtomic(join(dataDir, NUTANIX_STATE_FILE), `${JSON.stringify(stateSchema.parse(state), null, 2)}\n`, { mode: 0o600 });
}

export function portOpen(host: string, port: number, timeoutMs = 3_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export type NutanixPowerClient = PcClient | { client: PcClient; scrub(text: string): string };

export interface NutanixPowerDeps {
  /** The server's alias and id, or null when there is none. */
  server(): { alias: string; extId: string; ip: string } | null;
  client(): NutanixPowerClient | null;
  /** A bot's turn is using its desktop on the server. */
  busy(): boolean;
  /** The VM came back on a different address. */
  addressChanged(ip: string): void;
  /** Closes the shared SSH connection, so nothing waits on a host that is going away. */
  closeConnection(alias: string): Promise<void>;
  /** Shared mutex serializing every Nutanix route and lifecycle action. */
  mutex?: NutanixMutex;
  /** Whether persisted state says the server's power state is unknown after an accepted shutdown. */
  shutdownUnknown?(): boolean;
  /** Called inside the mutex when shutdown leaves power state unknown (true) or a later read confirms OFF (false). */
  onShutdownUnknown?(unknown: boolean): void;
  portOpen?(host: string, port: number, timeoutMs?: number): Promise<boolean>;
  sleep?(ms: number): Promise<void>;
  log?(line: string): void;
  idleMs?: number;
}

export const NUTANIX_WANTED_MS = 10 * 60_000;

export class NutanixPower {
  private readonly idle: ComputerIdleTimer;
  private readonly deps: NutanixPowerDeps;
  private readonly mutex: NutanixMutex;
  private wantedUntil = 0;
  private waking = 0;
  private shuttingDownAlias: string | null = null;
  private shutdownUncertainAlias: string | null = null;
  private poweredOff = false;
  private deletingAlias: string | null = null;

  constructor(deps: NutanixPowerDeps) {
    this.deps = deps;
    this.mutex = deps.mutex ?? new NutanixMutex();
    this.idle = new ComputerIdleTimer(deps.idleMs ?? NUTANIX_IDLE_MS, () => this.active(), () => this.suspend(),
      (error) => deps.log?.(`nutanix: could not power the desktop server off: ${error instanceof Error ? error.message : String(error)}`));
  }

  private active(): boolean {
    return this.waking > 0 || this.deps.busy() || Date.now() < this.wantedUntil;
  }

  watch(): void {
    if (this.deps.server()) this.idle.touch();
  }

  cancel(): void {
    this.idle.cancel();
    this.poweredOff = false;
  }

  want(alias: string | null): void {
    if (alias && this.deps.server()?.alias === alias) this.wantedUntil = Date.now() + NUTANIX_WANTED_MS;
  }

  /** Null for another host's alias; "stay-asleep" when nothing but a read wants the server. */
  wakerFor(alias: string): ((timeoutMs: number) => Promise<void>) | "stay-asleep" | null {
    if (this.deps.server()?.alias !== alias) return null;
    if (this.deletingAlias === alias) return "stay-asleep";
    return this.active() ? (timeoutMs) => this.powerOn(timeoutMs) : "stay-asleep";
  }

  private isShutdownUncertain(alias: string): boolean {
    return this.shutdownUncertainAlias === alias || this.deps.shutdownUnknown?.() === true;
  }

  /** Called inside the mutex once Prism Central confirms the VM's power state or the server is deleted. */
  clearShutdownState(poweredOff = false): void {
    this.shutdownUncertainAlias = null;
    this.poweredOff = poweredOff;
  }

  isShuttingDown(alias: string): boolean {
    if (this.deps.server()?.alias !== alias) return false;
    return this.shuttingDownAlias === alias || this.isShutdownUncertain(alias);
  }

  /** Wakes the server while the caller already holds the Nutanix mutex, then runs `work` without re-entering the mutex via SSH wake hooks. */
  async withAwakeForDelete<T>(alias: string, timeoutMs: number, work: () => Promise<T>): Promise<T> {
    await this.powerOnLocked(Date.now() + timeoutMs);
    this.deletingAlias = alias;
    try { return await work(); }
    finally { this.deletingAlias = null; }
  }

  private acquireClient(): { client: PcClient; scrub: (text: string) => string } | null {
    const raw = this.deps.client();
    if (!raw) return null;
    return "client" in raw ? raw : { client: raw, scrub: (text) => text };
  }

  /** Security: raw Prism Central errors may echo credentials or internal details and must not reach VPS status or bot turns. */
  private wakeFailure(error: unknown, scrub: (text: string) => string): Error {
    this.deps.log?.(`nutanix: could not power the desktop server on: ${scrub(error instanceof Error ? error.message : String(error))}`);
    if (error instanceof PcCertificateError) {
      return new Error("Prism Central's certificate changed since you connected. Reconnect in Settings → Desktops & browser.");
    }
    if (error instanceof PcError && error.status === 401) {
      return new Error("Prism Central didn't accept the saved login. Reconnect in Settings → Desktops & browser.");
    }
    if (error instanceof PcError && error.status === 504) {
      return new Error("The Nutanix desktop server did not come back on in time");
    }
    return new Error("Could not power on the Nutanix desktop server through Prism Central");
  }

  private async suspend(): Promise<void | "busy"> {
    return await this.mutex.run(async () => {
      const server = this.deps.server();
      const session = this.acquireClient();
      if (!server || !session) return;
      if (this.active()) return "busy";
      await this.deps.closeConnection(server.alias);
      if (this.deps.server()?.extId !== server.extId) return;
      if (this.active()) return "busy";
      const wasUncertain = this.isShutdownUncertain(server.alias);
      this.shuttingDownAlias = server.alias;
      let keepGateClosed = true;
      try {
        await session.client.shutdown(server.extId);
        this.poweredOff = true;
        this.shutdownUncertainAlias = null;
        this.deps.onShutdownUnknown?.(false);
        keepGateClosed = false;
      } catch (error) {
        if (!wasUncertain && error instanceof PcError && (error.taskFailed || error.beforeAccept)) {
          keepGateClosed = false;
        }
        throw new Error(session.scrub(error instanceof Error ? error.message : String(error)));
      } finally {
        this.shuttingDownAlias = null;
        if (keepGateClosed) {
          this.shutdownUncertainAlias = server.alias;
          this.deps.onShutdownUnknown?.(true);
        }
      }
    });
  }

  async powerOn(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    this.waking += 1;
    try {
      await this.mutex.runWithDeadline(
        deadline,
        () => new Error("The Nutanix desktop server did not come back on in time"),
        () => this.powerOnLocked(deadline),
      );
    } finally {
      this.waking -= 1;
    }
  }

  private async powerOnLocked(deadline: number): Promise<void> {
    const server = this.deps.server();
    const session = this.acquireClient();
    if (!server || !session) throw new Error("The Nutanix desktop server is not set up");
    if (this.isShutdownUncertain(server.alias)) {
      const checkLeft = deadline - Date.now();
      if (checkLeft <= 0) throw new Error("The Nutanix desktop server did not come back on in time");
      let latest;
      try { latest = await session.client.vm(server.extId, checkLeft); }
      catch (error) { throw this.wakeFailure(error, session.scrub); }
      if (latest.powerState !== "OFF") {
        this.deps.log?.(`nutanix: keeping SSH closed after uncertain shutdown because power state is ${latest.powerState}`);
        throw Object.assign(
          new Error("The Nutanix desktop server's power state is uncertain after shutdown. Check Prism Central in Settings → Desktops & browser."),
          { status: 409 },
        );
      }
      this.shutdownUncertainAlias = null;
      this.poweredOff = true;
      this.deps.onShutdownUnknown?.(false);
    }
    const open = this.deps.portOpen ?? portOpen;
    if (!this.poweredOff) {
      const probeLeft = deadline - Date.now();
      if (probeLeft > 0 && await open(server.ip, 22, Math.min(3_000, probeLeft))) { this.idle.touch(); return; }
    }
    const powerLeft = deadline - Date.now();
    if (powerLeft <= 0) throw new Error("The Nutanix desktop server did not come back on in time");
    try { await session.client.powerOn(server.extId, powerLeft); }
    catch (error) { throw this.wakeFailure(error, session.scrub); }
    this.poweredOff = false;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let ip = server.ip;
    for (;;) {
      const vmLeft = deadline - Date.now();
      if (vmLeft <= 0) throw new Error("The Nutanix desktop server did not come back on in time");
      let current: string | null;
      try { current = (await session.client.vm(server.extId, vmLeft)).ip; }
      catch (error) { throw this.wakeFailure(error, session.scrub); }
      if (current && current !== ip) { ip = current; this.deps.addressChanged(current); }
      const portLeft = deadline - Date.now();
      if (portLeft <= 0) throw new Error("The Nutanix desktop server did not come back on in time");
      if (await open(ip, 22, Math.min(3_000, portLeft))) {
        this.idle.touch();
        return;
      }
      const wait = Math.min(3_000, deadline - Date.now());
      if (wait <= 0) throw new Error("The Nutanix desktop server did not come back on in time");
      await sleep(wait);
    }
  }
}
