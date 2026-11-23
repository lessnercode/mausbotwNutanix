import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";

import { loginPlace } from "../../shared/logins.ts";
import { isValidSshAlias } from "../config.ts";
import { environmentSecrets, redactReportText } from "../devs-report.ts";
import { augmentedPath, userHome } from "../env-path.ts";
import {
  aliasBlock, createDesktopKey, desktopCloudInit, desktopFiles, DOCKER_STATUS_FILE, NutanixPower, readNutanixState,
  removeAlias, removeDesktopFiles, writeAlias, writeNutanixState, type DesktopFiles, type NutanixState,
} from "../nutanix/host.ts";
import { NutanixMutex } from "../nutanix/mutex.ts";
import {
  httpsTransport, PcCertificateError, pcBaseUrl, pcCertificateFingerprint, PcClient, PcError, prismConsoleUrl, serverShape, sourceChoices,
  usableSubnets,
} from "../nutanix/pc.ts";
import type { DesktopResources } from "../container-limits.ts";
import { MAX_LOCAL_VM_MAX_INSTANCES, MIN_LOCAL_VM_MAX_INSTANCES } from "../local-vm-settings.ts";
import { HELD_SECRET_MASK } from "../redact.ts";
import type { VaultStore } from "../vault-store.ts";
import { listManagedVpsComputers, vpsLifecycleBusy, type ManagedVpsOwner } from "../vps-computer.ts";
import { sharedVpsHost } from "../vps-hosts.ts";
import { prepareVpsSsh, vpsHostHooks } from "../vps-ssh.ts";
import { PASS, type RouteHandler } from "./table.ts";

export type DeployPhase = "creating" | "starting" | "address" | "installing" | "ready" | "failed";

export interface NutanixRouteDeps {
  dataDir: string;
  /** False on a Cloud, a hosted workspace or a team: the server and its key would live on someone else's machine. */
  available: boolean;
  vault: Pick<VaultStore, "create" | "get" | "remove" | "changes">;
  /** The app-wide "Your own servers" alias, read and saved the way Settings saves it. */
  defaultAlias(): string | null;
  setDefaultAlias(alias: string): void;
  /** Removes every bot's own VPS alias, so none is left pointing at another server. */
  clearBotAliases(): void;
  /** Who owns each bot desktop, for the inventory check before the server is deleted. */
  owners(): ManagedVpsOwner[];
  /** A bot's turn is using a desktop on the server. */
  busy(): boolean;
  /** Holds every other VPS change off until released; throws a 409 while one is already under way. */
  claimVps(): () => void;
  /** MausBot's desktop size options: the Max desktops setting and each desktop's CPUs and memory. */
  desktopSize(): { desktops: number; perDesktop: DesktopResources };
  /** Tells open windows that the Nutanix status changed. */
  changed(): void;
  sshConfig?: string;
  log(line: string): void;
  pcClient?(base: URL, login: { username: string; password: string }, pin: string | null): PcClient;
  fingerprint?(base: URL): Promise<string>;
  createKey?: typeof createDesktopKey;
  waitForDocker?(alias: string): Promise<void>;
  closeConnection?(alias: string): Promise<void>;
  portOpen?(host: string, port: number, timeoutMs?: number): Promise<boolean>;
}

const CREATE_WAIT_MS = 15 * 60_000;
const ADDRESS_WAIT_MS = 10 * 60_000;
const DOCKER_WAIT_MS = 20 * 60_000;
const POLL_MS = 5_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function pcProblem(error: unknown): { status: number; error: string } {
  if (error instanceof PcCertificateError) return { status: 409, error: "Prism Central's certificate changed since you connected. Connect again to trust the new one." };
  if (error instanceof PcError) {
    if (error.status === 401) return { status: 400, error: "Prism Central didn't accept that username and password." };
    if (error.status === 403) return { status: 403, error: `Your Prism Central account isn't allowed to do this. ${error.message}` };
    return { status: 502, error: `Prism Central refused: ${error.message}` };
  }
  const status = typeof (error as { status?: unknown })?.status === "number" ? (error as { status: number }).status : 502;
  const message = error instanceof Error ? error.message : String(error);
  if (status !== 502) return { status, error: message };
  return { status, error: `Couldn't reach Prism Central. Check the address and that this computer can reach it. (${message})` };
}

function sshRun(configPath: string | null, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("ssh", [...(configPath ? ["-F", configPath] : []), ...args], {
      timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 256 * 1024, env: { ...process.env, PATH: augmentedPath() },
    }, (error, stdout, stderr) => error ? reject(new Error(String(stderr).trim().slice(-1000) || error.message)) : resolve(String(stdout)));
  });
}

export function nutanixAsk(dataDir: string): string | undefined {
  const vm = readNutanixState(dataDir).vm;
  return vm?.askDelete ? vm.name : undefined;
}

const conflict = (message: string) => Object.assign(new Error(message), { status: 409 });

export function createNutanixRoutes(deps: NutanixRouteDeps): RouteHandler {
  const sshConfig = deps.sshConfig ?? join(userHome(), ".ssh", "config");
  const mutex = new NutanixMutex();
  let job: { phase: DeployPhase; error: string | null } | null = null;
  const deploying = () => job !== null && job.phase !== "ready" && job.phase !== "failed";
  const state = () => readNutanixState(deps.dataDir);
  const save = (next: NutanixState) => writeNutanixState(deps.dataDir, next);
  const sshSetup = () => prepareVpsSsh(deps.dataDir, augmentedPath());
  /** Our own polling never shares the app's connection: a shared one opened before Docker's group existed would keep the old groups. */
  const runOnServer = (alias: string, command: string) => sshRun(sshSetup().configPath,
    ["-o", "BatchMode=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=10", "-T", "--", alias, command]);
  const closeConnection = deps.closeConnection ?? (async (alias: string) => {
    const configPath = sshSetup().configPath;
    if (configPath) await sshRun(configPath, ["-O", "exit", "--", alias], 10_000).catch(() => {});
  });

  const savedLogin = () => {
    const pc = state().pc;
    return pc ? deps.vault.get(pc.loginId) : null;
  };
  const pcSecrets = (login: { username: string; password: string } | null | undefined): string[] => {
    if (!login || !login.password) return [];
    const basic = Buffer.from(`${login.username}:${login.password}`).toString("base64");
    return [basic, `${login.username}:${login.password}`, login.password];
  };
  /** Security: Prism Central's own error and task text may quote what it was sent, so passwords of any length are scrubbed before display or logging. */
  const redact = (text: string, extra: readonly string[] = []) => {
    const own = [...extra, ...pcSecrets(savedLogin())].filter((one) => one.length > 0).sort((a, b) => b.length - a.length);
    let out = redactReportText(text, environmentSecrets());
    for (const secret of own) if (out.includes(secret)) out = out.split(secret).join(HELD_SECRET_MASK);
    return out;
  };
  const log = (line: string) => deps.log(redact(line));

  const connectClient = (base: URL, login: { username: string; password: string }, pin: string | null) =>
    deps.pcClient?.(base, login, pin) ?? new PcClient(httpsTransport({ base, username: login.username, password: login.password, pin }));
  type ClientSession = { pc: PcClient; secrets: string[]; scrub: (text: string) => string };
  const clientSession = (): ClientSession | null => {
    const pc = state().pc;
    const login = savedLogin();
    if (!pc || !login) return null;
    const secrets = pcSecrets(login);
    return {
      pc: connectClient(pcBaseUrl(pc.address), login, pc.fingerprint),
      secrets,
      scrub: (text: string) => redact(text, secrets),
    };
  };

  const power = new NutanixPower({
    server: () => {
      const vm = state().vm;
      return vm?.extId && vm.ip && vm.ready ? { alias: vm.alias, extId: vm.extId, ip: vm.ip } : null;
    },
    client: () => {
      const session = clientSession();
      return session ? { client: session.pc, scrub: session.scrub } : null;
    },
    busy: deps.busy,
    addressChanged: (ip) => {
      const current = state();
      if (!current.vm) return;
      writeAlias(sshConfig, aliasBlock(current.vm.alias, ip, desktopFiles(deps.dataDir, current.vm.alias)), current.vm.alias);
      save({ ...current, vm: { ...current.vm, ip } });
    },
    closeConnection,
    mutex,
    shutdownUnknown: () => state().vm?.shutdownUnknown === true,
    onShutdownUnknown: (unknown) => {
      const current = state();
      if (!current.vm) return;
      if (current.vm.shutdownUnknown === unknown && (!unknown || !current.vm.shutdownCheckedOn)) return;
      save({
        ...current,
        vm: { ...current.vm, shutdownUnknown: unknown, shutdownCheckedOn: unknown ? false : undefined },
      });
      deps.changed();
    },
    portOpen: deps.portOpen,
    log,
  });
  const shareHost = () => {
    const vm = state().vm;
    sharedVpsHost.alias = vm?.ready ? vm.alias : null;
  };
  if (deps.available) {
    vpsHostHooks.wakerFor = (alias) => power.wakerFor(alias);
    vpsHostHooks.shuttingDown = (alias) => power.isShuttingDown(alias);
    vpsHostHooks.want = (alias) => power.want(alias);
    vpsHostHooks.emptied = (alias) => {
      void mutex.run(async () => {
        const current = state();
        if (!current.vm?.ready || current.vm.alias !== alias) return;
        save({ ...current, vm: { ...current.vm, askDelete: true } });
        deps.changed();
      });
    };
    shareHost();
    power.watch();
  }

  const sizes = () => {
    const { desktops, perDesktop } = deps.desktopSize();
    const counts = Array.from({ length: MAX_LOCAL_VM_MAX_INSTANCES - MIN_LOCAL_VM_MAX_INSTANCES + 1 }, (_, i) => i + MIN_LOCAL_VM_MAX_INSTANCES);
    return { default: desktops, shapes: counts.map((count) => serverShape(count, perDesktop)) };
  };
  const vmCanClear = (vm: NonNullable<NutanixState["vm"]>): boolean => {
    if (vm.extId) return false;
    if (vm.createRejected === true || vm.createFailed === true || vm.confirmedGone === true) return true;
    if (vm.startedAt === undefined || Date.now() - vm.startedAt < CREATE_WAIT_MS) return false;
    return vm.needsCheck === true && vm.checkedEmptyAt !== undefined;
  };
  const status = () => {
    const current = state();
    const login = savedLogin();
    return {
      available: deps.available,
      pc: current.pc && login ? {
        address: current.pc.address, username: login.username, version: current.pc.version, projects: current.pc.projects, fingerprint: current.pc.fingerprint,
        botsMayUse: login.bots === "all" || login.bots.length > 0,
      } : null,
      server: current.vm ? {
        name: current.vm.name, alias: current.vm.alias, ip: current.vm.ip, ready: current.vm.ready,
        consoleUrl: current.pc ? prismConsoleUrl(current.pc.address) : null,
        askDelete: current.vm.askDelete === true, needsCheck: current.vm.needsCheck === true,
        checkReason: current.vm.checkReason ?? "create",
        canClear: vmCanClear(current.vm),
        shutdownUnknown: current.vm.shutdownUnknown === true,
        canResume: current.vm.shutdownUnknown === true && current.vm.shutdownCheckedOn === true,
      } : null,
      defaultAlias: deps.defaultAlias(),
      deploy: job ?? (current.vm && !current.vm.ready ? {
        phase: "failed" as const,
        error: current.vm.needsCheck
          ? current.vm.checkReason === "delete"
            ? `Couldn't confirm whether ${current.vm.name} was deleted in Prism Central. Check Prism Central before clearing this record.`
            : `Couldn't confirm whether ${current.vm.name} was created in Prism Central. Check Prism Central and delete it there if it exists before clearing this record.`
          : "Setup didn't finish. Delete the server and deploy again.",
      } : null),
      sizes: sizes(),
    };
  };

  async function waitForAddress(pc: PcClient, extId: string): Promise<string> {
    const deadline = Date.now() + ADDRESS_WAIT_MS;
    for (;;) {
      const { ip } = await pc.vm(extId);
      if (ip) return ip;
      if (Date.now() >= deadline) throw new Error("The server didn't get an address within 10 minutes. Check the subnet's address pool in Prism Central.");
      await sleep(POLL_MS);
    }
  }

  async function waitForDocker(alias: string): Promise<void> {
    const deadline = Date.now() + DOCKER_WAIT_MS;
    for (;;) {
      const answer = (await runOnServer(alias, `cat ${DOCKER_STATUS_FILE} 2>/dev/null || true`).catch(() => "")).trim();
      if (answer === "ok") return;
      if (answer === "failed") {
        const tail = (await runOnServer(alias, "sudo tail -n 15 /var/log/cloud-init-output.log").catch(() => "")).trim();
        throw new Error(`Docker couldn't be installed on the server.${tail ? ` The end of its setup log:\n${tail}` : ""}`);
      }
      if (Date.now() >= deadline) throw new Error("Docker didn't finish installing within 20 minutes. The server may not reach the internet, or its image may not run cloud-init.");
      await sleep(POLL_MS);
    }
  }

  async function runDeploy(
    session: ClientSession,
    input: DeployInput,
    record: { name: string; alias: string; ip: null; projectExtId: string | null; ready: false; startedAt: number },
    files: DesktopFiles,
    publicKey: string,
  ): Promise<void> {
    const pc = session.pc;
    try {
      const common = { name: record.name, clusterExtId: input.clusterExtId, subnetExtId: input.subnetExtId, projectExtId: input.projectExtId, userData: desktopCloudInit(publicKey) };
      let taskExtId: string | null = null;
      let extId: string;
      try {
        extId = await pc.createVm(
          input.source.kind === "image"
            ? { ...common, kind: "image", imageExtId: input.source.extId, ...serverShape(input.desktops ?? deps.desktopSize().desktops, deps.desktopSize().perDesktop) }
            : { ...common, kind: "template", templateExtId: input.source.extId },
          CREATE_WAIT_MS,
          (id) => {
            taskExtId = id;
            void mutex.run(async () => {
              const current = state();
              if (current.vm?.name === record.name) save({ ...current, vm: { ...current.vm, taskExtId: id } });
            });
          },
        );
      } catch (error) {
        const rejectedBeforeTask = !taskExtId && error instanceof PcError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
        const taskFailed = error instanceof PcError && error.taskFailed;
        const found = rejectedBeforeTask ? null : await pc.vmIdNamed(record.name).catch(() => null);
        await mutex.run(async () => {
          const current = state();
          if (current.vm?.name !== record.name) return;
          if (found) save({ ...current, vm: { ...current.vm, extId: found } });
          else if (rejectedBeforeTask) save({ ...current, vm: { ...current.vm, createRejected: true } });
          else if (taskFailed) save({ ...current, vm: { ...current.vm, createFailed: true } });
          else save({ ...current, vm: { ...current.vm, needsCheck: true, checkReason: "create", checkedEmptyAt: undefined } });
        });
        throw error;
      }
      await mutex.run(async () => {
        try {
          const current = state();
          if (current.vm?.name === record.name) save({ ...current, vm: { ...current.vm, extId } });
          job = { phase: "starting", error: null };
          await pc.powerOn(extId);
          job = { phase: "address", error: null };
          const ip = await waitForAddress(pc, extId);
          writeAlias(sshConfig, aliasBlock(record.name, ip, files), record.name);
          const withIp = state();
          if (withIp.vm?.name === record.name) save({ ...withIp, vm: { ...withIp.vm, extId, ip } });
          job = { phase: "installing", error: null };
          await (deps.waitForDocker ?? waitForDocker)(record.name);
          const readyState = state();
          if (readyState.vm?.name === record.name) save({ ...readyState, vm: { ...readyState.vm, extId, ip, ready: true } });
          deps.setDefaultAlias(record.name);
          deps.clearBotAliases();
          shareHost();
          power.watch();
          job = { phase: "ready", error: null };
          deps.changed();
        } catch (error) {
          const problem = session.scrub(error instanceof PcError || error instanceof PcCertificateError ? pcProblem(error).error : error instanceof Error ? error.message : String(error));
          log(`nutanix: setting up the desktop server failed: ${problem}`);
          job = { phase: "failed", error: problem };
          deps.changed();
        }
      });
    } catch (error) {
      const problem = session.scrub(error instanceof PcError || error instanceof PcCertificateError ? pcProblem(error).error : error instanceof Error ? error.message : String(error));
      log(`nutanix: setting up the desktop server failed: ${problem}`);
      await mutex.run(async () => {
        job = { phase: "failed", error: problem };
        deps.changed();
      });
    }
  }

  type UnfinishedCheck =
    | { kind: "found"; extId: string }
    | { kind: "running" }
    | { kind: "failed" }
    | { kind: "pending" }
    | { kind: "missing" };

  async function inspectUnfinishedVm(pc: PcClient, vm: NonNullable<NutanixState["vm"]>): Promise<UnfinishedCheck> {
    if (vm.createRejected === true || vm.confirmedGone === true) return { kind: "failed" };
    let taskFailed = vm.createFailed === true;
    let extId: string | null = null;
    if (!taskFailed && vm.taskExtId) {
      const task = await pc.taskState(vm.taskExtId, vm.name);
      if (task.state === "running") return { kind: "running" };
      if (task.state === "succeeded") {
        extId = task.vmExtId ?? await pc.vmIdNamed(vm.name);
      } else if (task.state === "failed") {
        extId = await pc.vmIdNamed(vm.name);
        if (!extId) taskFailed = true;
      } else {
        extId = await pc.vmIdNamed(vm.name);
      }
    } else {
      extId = await pc.vmIdNamed(vm.name);
    }
    if (extId) return { kind: "found", extId };
    if (taskFailed) return { kind: "failed" };
    if (vm.startedAt === undefined || Date.now() - vm.startedAt < CREATE_WAIT_MS) return { kind: "pending" };
    return { kind: "missing" };
  }

  async function checkServer(
    onSecrets?: (secrets: string[]) => void,
  ): Promise<{ outcome: "found" | "running" | "pending" | "failed" | "missing" | "off" | "on" | "unknown"; message: string }> {
    const current = state();
    if (!current.vm) throw Object.assign(new Error("There is no Nutanix desktop server."), { status: 404 });
    const session = clientSession();
    if (!session) throw conflict("Connect to Prism Central first.");
    onSecrets?.(session.secrets);
    const pc = session.pc;
    const vm = current.vm;
    if (vm.extId) {
      try {
        const live = await pc.vm(vm.extId);
        if (vm.shutdownUnknown) {
          if (live.powerState === "OFF") {
            power.clearShutdownState(true);
            save({ ...current, vm: { ...vm, shutdownUnknown: false, shutdownCheckedOn: undefined, needsCheck: false, checkReason: undefined, checkedEmptyAt: undefined } });
            deps.changed();
            return { outcome: "off", message: `${vm.name} is powered off in Prism Central. Connections will wake it when needed.` };
          }
          if (live.powerState === "ON") {
            save({ ...current, vm: { ...vm, shutdownUnknown: true, shutdownCheckedOn: true, needsCheck: false, checkReason: undefined, checkedEmptyAt: undefined } });
            deps.changed();
            return { outcome: "on", message: `${vm.name} is still powered on in Prism Central. Confirm it is no longer shutting down before resuming connections.` };
          }
          save({ ...current, vm: { ...vm, shutdownUnknown: true, shutdownCheckedOn: false, needsCheck: false, checkReason: undefined, checkedEmptyAt: undefined } });
          deps.changed();
          return { outcome: "unknown", message: `Prism Central reported an unknown power state (${live.powerState}) for ${vm.name}. Connections stay paused.` };
        }
        if (vm.needsCheck || vm.checkedEmptyAt !== undefined) {
          save({ ...current, vm: { ...vm, needsCheck: false, checkReason: undefined, checkedEmptyAt: undefined } });
          if (vm.ready) power.watch();
          deps.changed();
        }
        return { outcome: "found", message: `Found ${vm.name} in Prism Central. Delete it if you want to start over.` };
      } catch (error) {
        if (error instanceof PcError && error.status === 404) {
          power.clearShutdownState(false);
          save({
            ...current,
            vm: {
              ...vm,
              extId: null,
              confirmedGone: true,
              needsCheck: true,
              checkReason: vm.checkReason ?? "delete",
              checkedEmptyAt: Date.now(),
              shutdownUnknown: false,
              shutdownCheckedOn: undefined,
            },
          });
          deps.changed();
          return { outcome: "missing", message: `${vm.name} wasn't found in Prism Central. You can clear this server record now.` };
        }
        throw error;
      }
    }
    const checked = await inspectUnfinishedVm(pc, vm);
    if (checked.kind === "found") {
      save({ ...current, vm: { ...vm, extId: checked.extId, needsCheck: false, checkReason: undefined, checkedEmptyAt: undefined } });
      deps.changed();
      return { outcome: "found", message: `Found ${vm.name} in Prism Central. Delete it if you want to start over.` };
    }
    if (checked.kind === "running") {
      save({ ...current, vm: { ...vm, needsCheck: true, checkReason: "create", checkedEmptyAt: undefined } });
      deps.changed();
      return { outcome: "running", message: "Prism Central is still creating this server. Wait for it to finish before deleting it." };
    }
    if (checked.kind === "pending") {
      save({ ...current, vm: { ...vm, startedAt: vm.startedAt ?? Date.now(), needsCheck: true, checkReason: "create", checkedEmptyAt: undefined } });
      deps.changed();
      return { outcome: "pending", message: `Prism Central may still be creating ${vm.name}. Wait for creation to finish, then check Prism Central again.` };
    }
    if (checked.kind === "failed") {
      save({ ...current, vm: { ...vm, createFailed: vm.confirmedGone ? vm.createFailed : true, needsCheck: true, checkedEmptyAt: Date.now() } });
      deps.changed();
      return {
        outcome: vm.confirmedGone ? "missing" : "failed",
        message: vm.confirmedGone
          ? `${vm.name} wasn't found in Prism Central. You can clear this server record now.`
          : `Prism Central confirmed that creating ${vm.name} failed and no server exists. You can clear this record now.`,
      };
    }
    save({ ...current, vm: { ...vm, needsCheck: true, checkReason: "create", checkedEmptyAt: Date.now() } });
    deps.changed();
    return { outcome: "missing", message: `${vm.name} wasn't found in Prism Central. If you've checked Prism Central, you can clear this server record now.` };
  }

  async function resumeServer(onSecrets?: (secrets: string[]) => void): Promise<void> {
    const current = state();
    const vm = current.vm;
    if (!vm) throw Object.assign(new Error("There is no Nutanix desktop server."), { status: 404 });
    if (!vm.shutdownUnknown) return;
    if (!vm.extId) throw conflict("Check Prism Central before resuming connections.");
    const session = clientSession();
    if (!session) throw conflict("Connect to Prism Central first.");
    onSecrets?.(session.secrets);
    let live;
    try { live = await session.pc.vm(vm.extId); }
    catch (error) {
      if (error instanceof PcError && error.status === 404) {
        power.clearShutdownState(false);
        save({
          ...current,
          vm: {
            ...vm,
            extId: null,
            confirmedGone: true,
            needsCheck: true,
            checkReason: "delete",
            checkedEmptyAt: Date.now(),
            shutdownUnknown: false,
            shutdownCheckedOn: undefined,
          },
        });
        deps.changed();
        throw conflict(`${vm.name} wasn't found in Prism Central. You can clear this server record now.`);
      }
      throw error;
    }
    if (live.powerState === "OFF") {
      power.clearShutdownState(true);
      save({ ...current, vm: { ...vm, shutdownUnknown: false, shutdownCheckedOn: undefined } });
      deps.changed();
      return;
    }
    if (live.powerState === "ON") {
      if (vm.shutdownCheckedOn !== true) {
        save({ ...current, vm: { ...vm, shutdownCheckedOn: true } });
        deps.changed();
        throw conflict(`${vm.name} is still powered on in Prism Central. Check Prism Central first, then confirm resuming connections.`);
      }
      power.clearShutdownState(false);
      save({ ...current, vm: { ...vm, shutdownUnknown: false, shutdownCheckedOn: undefined } });
      if (vm.ready) power.watch();
      deps.changed();
      return;
    }
    save({ ...current, vm: { ...vm, shutdownUnknown: true, shutdownCheckedOn: false } });
    deps.changed();
    throw conflict(`Prism Central reported an unknown power state (${live.powerState}) for ${vm.name}. Connections stay paused.`);
  }

  async function deleteServer(
    options: { confirmedChecked?: boolean; onSecrets?: (secrets: string[]) => void } = {},
  ): Promise<void> {
    const current = state();
    if (!current.vm) throw Object.assign(new Error("There is no Nutanix desktop server."), { status: 404 });
    const session = clientSession();
    if (!session) throw conflict("Connect to Prism Central first.");
    options.onSecrets?.(session.secrets);
    const pc = session.pc;
    const vm = current.vm;
    const release = deps.claimVps();
    try {
      if (deps.busy() || vpsLifecycleBusy()) {
        throw conflict("A bot is using or changing a desktop on this server. Try again when it finishes.");
      }
      if (options.confirmedChecked === true && vm.extId) {
        throw conflict(`Found ${vm.name} in Prism Central. Delete it from here if you want to remove it.`);
      }
      if (vm.ready && vm.extId && isValidSshAlias(vm.alias)) {
        const inventory = await power.withAwakeForDelete(vm.alias, 120_000, () =>
          listManagedVpsComputers({ vps: { sshAlias: vm.alias } }, deps.owners(), undefined, [vm.alias]));
        if (!inventory.available) throw conflict(`Couldn't check the server for bot desktops, so it was kept. ${inventory.problem ?? ""}`.trim());
        if (inventory.instances.length) throw conflict(`${inventory.instances.length} bot desktops still run on this server. Remove them first.`);
      }
      power.cancel();
      await closeConnection(vm.alias);
      let extId = vm.extId;
      if (!extId) {
        const checked = await inspectUnfinishedVm(pc, vm);
        if (checked.kind === "running") {
          save({ ...state(), vm: { ...vm, needsCheck: true, checkReason: "create", checkedEmptyAt: undefined } });
          deps.changed();
          throw conflict("Prism Central is still creating this server. Wait for it to finish before deleting it.");
        }
        if (checked.kind === "found") {
          save({ ...state(), vm: { ...vm, extId: checked.extId, needsCheck: false, checkReason: undefined, checkedEmptyAt: undefined } });
          if (options.confirmedChecked === true) {
            deps.changed();
            throw conflict(`Found ${vm.name} in Prism Central. Delete it from here if you want to remove it.`);
          }
          extId = checked.extId;
        } else if (checked.kind === "pending") {
          save({ ...state(), vm: { ...vm, startedAt: vm.startedAt ?? Date.now(), needsCheck: true, checkReason: "create", checkedEmptyAt: undefined } });
          deps.changed();
          throw conflict(`Prism Central may still be creating ${vm.name}. Wait for creation to finish, then check Prism Central again before clearing this record.`);
        } else if (checked.kind === "missing") {
          const previouslyChecked = vm.needsCheck === true && vm.checkedEmptyAt !== undefined;
          if (!(options.confirmedChecked === true && previouslyChecked)) {
            save({
              ...state(),
              vm: {
                ...vm,
                needsCheck: true,
                checkReason: "create",
                checkedEmptyAt: vm.checkedEmptyAt,
              },
            });
            deps.changed();
            throw conflict(`Couldn't confirm whether ${vm.name} was created in Prism Central. Check Prism Central and delete it there if it exists before clearing this record.`);
          }
        }
      }
      if (extId) {
        try {
          await pc.deleteVm(extId);
        } catch (error) {
          if (error instanceof PcError && error.unconfirmed) {
            save({ ...state(), vm: { ...vm, extId, needsCheck: true, checkReason: "delete", checkedEmptyAt: undefined } });
            deps.changed();
            throw conflict(`Couldn't confirm whether ${vm.name} was deleted in Prism Central. Check Prism Central before clearing this record.`);
          }
          throw error;
        }
      }
      power.clearShutdownState(false);
      if (deps.defaultAlias() === vm.alias) deps.setDefaultAlias("");
      sharedVpsHost.alias = null;
      removeAlias(sshConfig, vm.alias);
      removeDesktopFiles(desktopFiles(deps.dataDir, vm.alias));
      save({ ...state(), vm: undefined });
      job = null;
    } finally {
      release();
    }
  }

  const deployInput = z.object({
    projectExtId: z.string().min(1).nullable(),
    source: z.object({ kind: z.enum(["image", "template"]), extId: z.string().min(1) }),
    subnetExtId: z.string().min(1),
    desktops: z.number().int().min(MIN_LOCAL_VM_MAX_INSTANCES).max(MAX_LOCAL_VM_MAX_INSTANCES).optional(),
  }).strict();
  type DeployInput = z.infer<typeof deployInput> & { clusterExtId: string };

  async function startDeploy(body: unknown, onSecrets?: (secrets: string[]) => void): Promise<{ status: number; body: unknown }> {
    const parsed = deployInput.safeParse(body);
    if (!parsed.success) return { status: 400, body: { error: "Choose an image or template and a subnet." } };
    const session = clientSession();
    const pcState = state().pc;
    if (!session || !pcState) return { status: 409, body: { error: "Connect to Prism Central first." } };
    onSecrets?.(session.secrets);
    const pc = session.pc;
    const project = parsed.data.projectExtId;
    if (pcState.projects !== (project !== null)) return { status: 400, body: { error: pcState.projects ? "Choose a project first." : "This Prism Central has no projects to choose." } };
    const images = await pc.images();
    const [templates, subnets] = await Promise.all([pc.templates(project), pc.subnets()]);
    const source = sourceChoices(images, templates, project).find((one) => one.kind === parsed.data.source.kind && one.extId === parsed.data.source.extId);
    if (!source || (source.kind === "template" && !source.canInjectKey)) return { status: 400, body: { error: "That image or template can't be used here any more. Choose another." } };
    const subnet = usableSubnets(subnets, project).find((one) => one.extId === parsed.data.subnetExtId);
    if (!subnet) return { status: 400, body: { error: "That subnet has no free addresses managed by Nutanix any more. Choose another." } };
    const name = `mausbot-desktops-${randomBytes(3).toString("hex")}`;
    const files = desktopFiles(deps.dataDir, name);
    const publicKey = await (deps.createKey ?? createDesktopKey)(files, name);
    const record = { name, alias: name, ip: null as null, projectExtId: parsed.data.projectExtId, ready: false as const, startedAt: Date.now() };
    save({ ...state(), vm: { ...record, extId: null } });
    job = { phase: "creating", error: null };
    void runDeploy(session, { ...parsed.data, clusterExtId: subnet.clusterExtId }, record, files, publicKey);
    return { status: 202, body: status() };
  }

  async function connect(body: unknown): Promise<{ status: number; body: unknown }> {
    const parsed = z.object({ address: z.string().min(1).max(253), username: z.string().min(1).max(256), password: z.string().min(1).max(1024) }).strict().safeParse(body);
    if (!parsed.success) return { status: 400, body: { error: "Enter the Prism Central address, username and password." } };
    let base: URL;
    try { base = pcBaseUrl(parsed.data.address); }
    catch { return { status: 400, body: { error: "That isn't a Prism Central address. Enter a host name or IP address." } }; }
    const before = state();
    if (before.vm && before.pc && before.pc.address !== base.host) {
      return { status: 409, body: { error: `The desktop server lives on ${before.pc.address}. Delete it before connecting to another Prism Central.` } };
    }
    const fingerprint = await (deps.fingerprint ?? pcCertificateFingerprint)(base);
    const { version, projects } = await connectClient(base, parsed.data, fingerprint).connect();
    const place = loginPlace(base.hostname.replace(/^\[|\]$/g, ""), [], true);
    const login = deps.vault.create({ ...place, username: parsed.data.username, password: parsed.data.password, source: "settings", bots: [] }, { separate: true });
    if (before.pc && before.pc.loginId !== login.id && before.pc.ownsLogin) deps.vault.remove(before.pc.loginId);
    save({ ...before, pc: { address: base.host, loginId: login.id, ownsLogin: true, fingerprint, version, projects } });
    return { status: 200, body: status() };
  }

  return async ({ req, res, url, path, method, json, readBody }) => {
    if (path !== "/api/nutanix" && !path.startsWith("/api/nutanix/")) return PASS;
    res.setHeader("cache-control", "private, no-store");
    if (!deps.available) return json(res, 404, { error: "Nutanix desktops run only on this computer's own install." });
    if (method !== "GET" && !String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    const requestClosed = () => Boolean(req.aborted || req.readableAborted || req.destroyed || req.closed || res.destroyed || res.closed || res.writableEnded);
    const responseClosed = () => Boolean(res.destroyed || res.closed || res.writableEnded);
    if (requestClosed()) return;
    if (method === "GET" && path === "/api/nutanix") return json(res, 200, status());
    return await mutex.run(async () => {
      if (requestClosed()) return;
      let extraSecrets: string[] = [];
      const reply = (code: number, body: unknown) => { if (!responseClosed()) json(res, code, body); };
      try {
        if (method === "POST" && path === "/api/nutanix/connect") {
          const body = await readBody(req, 8192);
          const raw = body as { username?: unknown; password?: unknown } | null;
          if (typeof raw?.password === "string" && raw.password) {
            extraSecrets = pcSecrets({ username: typeof raw.username === "string" ? raw.username : "", password: raw.password });
          }
          if (deploying()) return reply(409, { error: "Wait for the desktop server to finish first." });
          const done = await connect(body);
          return reply(done.status, done.body);
        }
        if (method === "GET" && path === "/api/nutanix/projects") {
          const session = clientSession();
          if (!session) return reply(409, { error: "Connect to Prism Central first." });
          extraSecrets = session.secrets;
          return reply(200, { projects: state().pc?.projects ? await session.pc.projects() : [] });
        }
        if (method === "GET" && path === "/api/nutanix/choices") {
          const session = clientSession();
          const pcState = state().pc;
          if (!session || !pcState) return reply(409, { error: "Connect to Prism Central first." });
          extraSecrets = session.secrets;
          const project = pcState.projects ? url.searchParams.get("project") : null;
          if (pcState.projects && !project) return reply(400, { error: "Choose a project first." });
          const images = await session.pc.images();
          const [templates, subnets] = await Promise.all([session.pc.templates(project), session.pc.subnets()]);
          return reply(200, { sources: sourceChoices(images, templates, project), subnets: usableSubnets(subnets, project) });
        }
        if (method === "POST" && path === "/api/nutanix/deploy") {
          const body = await readBody(req, 8192);
          if (deploying()) return reply(409, { error: "A server is already being set up." });
          if (state().vm) return reply(409, { error: "There is already a Nutanix desktop server. Delete it before making another." });
          const started = await startDeploy(body, (secrets) => { extraSecrets = secrets; });
          return reply(started.status, started.body);
        }
        if (method === "POST" && path === "/api/nutanix/keep") {
          await readBody(req, 1024);
          if (deploying()) return reply(409, { error: "Wait for the desktop server to finish first." });
          const current = state();
          if (current.vm) save({ ...current, vm: { ...current.vm, askDelete: false } });
          deps.changed();
          return reply(200, status());
        }
        if (method === "POST" && path === "/api/nutanix/check") {
          await readBody(req, 1024);
          if (deploying()) return reply(409, { error: "Wait for the desktop server to finish first." });
          const checked = await checkServer((secrets) => { extraSecrets = secrets; });
          return reply(200, { ...status(), check: checked });
        }
        if (method === "POST" && path === "/api/nutanix/resume") {
          await readBody(req, 1024);
          if (deploying()) return reply(409, { error: "Wait for the desktop server to finish first." });
          await resumeServer((secrets) => { extraSecrets = secrets; });
          return reply(200, status());
        }
        if (method === "DELETE" && path === "/api/nutanix/server") {
          const body = await readBody(req, 1024);
          if (deploying()) return reply(409, { error: "Wait for the desktop server to finish first." });
          const parsed = z.object({ confirmedChecked: z.boolean().optional() }).strict().safeParse(body ?? {});
          if (!parsed.success) return reply(400, { error: "Invalid delete request." });
          await deleteServer({
            confirmedChecked: parsed.data.confirmedChecked === true,
            onSecrets: (secrets) => { extraSecrets = secrets; },
          });
          deps.changed();
          return reply(200, status());
        }
      } catch (error) {
        if (responseClosed()) return;
        const problem = pcProblem(error);
        return reply(problem.status, { error: redact(problem.error, extraSecrets) });
      }
      return reply(404, { error: "unknown Nutanix request" });
    });
  };
}
