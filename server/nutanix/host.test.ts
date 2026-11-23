import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { VaultStore } from "../vault-store.ts";
import {
  aliasBlock, createDesktopKey, desktopCloudInit, desktopFiles, DOCKER_STATUS_FILE, NUTANIX_STATE_FILE, NutanixPower,
  readNutanixState, removeAlias, writeAlias, writeNutanixState,
} from "./host.ts";
import { NutanixMutex } from "./mutex.ts";
import { PcClient, PcError, type PcRequest, type PcResponse } from "./pc.ts";

const roots: string[] = [];
const root = () => {
  const dir = mkdtempSync(join(tmpdir(), "omb-nutanix-"));
  roots.push(dir);
  return dir;
};
afterEach(() => {
  vi.useRealTimers();
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEexampleEXAMPLEexampleEXAMPLE1234 mausbot-desktops-abc123";

describe("cloud-init for a new server", () => {
  it("creates the user with the key, turns off password logins and installs Docker only when missing", () => {
    const text = desktopCloudInit(KEY);
    expect(text.startsWith("#cloud-config\n")).toBe(true);
    const doc = parse(text);
    expect(doc.users[1]).toMatchObject({ name: "mausbot", ssh_authorized_keys: [KEY] });
    expect(doc.ssh_pwauth).toBe(false);
    const script = doc.write_files[0].content as string;
    expect(script).toMatch(/if ! command -v docker/);
    expect(script).toContain("systemctl enable --now docker");
    expect(script).toContain("usermod -aG docker mausbot");
    expect(script).toContain(`echo ok > ${DOCKER_STATUS_FILE}`);
    expect(script).toContain(`echo failed > ${DOCKER_STATUS_FILE}`);
    expect(doc.runcmd).toEqual([["/usr/local/sbin/openmausbot-docker"]]);
  });

  it("refuses anything that is not one public key", () => {
    expect(() => desktopCloudInit("-----BEGIN OPENSSH PRIVATE KEY-----")).toThrow();
    expect(() => desktopCloudInit(`${KEY}\nruncmd: [reboot]`)).toThrow();
  });
});

describe("the SSH alias", () => {
  it("goes ahead of the person's own Host * and replaces itself in place", () => {
    const dir = root();
    const config = join(dir, ".ssh", "config");
    const files = desktopFiles(join(dir, "data"), "mausbot-desktops-abc123");
    writeAlias(config, aliasBlock("mausbot-desktops-abc123", "10.0.0.20", files), "mausbot-desktops-abc123");
    expect(statSync(config).mode & 0o777).toBe(0o600);
    const own = "Host *\n  User someone-else\n";
    writeFileSync(config, readFileSync(config, "utf8") + own);
    chmodSync(config, 0o640);
    writeAlias(config, aliasBlock("mausbot-desktops-abc123", "10.0.0.21", files), "mausbot-desktops-abc123");
    const text = readFileSync(config, "utf8");
    expect(text.indexOf("Host mausbot-desktops-abc123")).toBeLessThan(text.indexOf("Host *"));
    expect(text.match(/Host mausbot-desktops-abc123/g)).toHaveLength(1);
    expect(text).toContain("HostName 10.0.0.21");
    expect(text).toContain("User mausbot");
    expect(text).toContain("StrictHostKeyChecking accept-new");
    expect(text).toContain(`IdentityFile ${JSON.stringify(files.key)}`);
    expect(statSync(config).mode & 0o777).toBe(0o640);
    removeAlias(config, "mausbot-desktops-abc123");
    expect(readFileSync(config, "utf8")).toBe(own);
  });

  it("refuses any address that is not an IPv4 literal, so nothing else reaches ~/.ssh/config", () => {
    const files = desktopFiles(root(), "mausbot-desktops-abc123");
    for (const bad of ["10.0.0.20\n  ProxyCommand touch /tmp/owned", "pc.example.com", "fe80::1", "10.0.0.256", ""]) {
      expect(() => aliasBlock("mausbot-desktops-abc123", bad, files)).toThrow("isn't an IPv4 address");
    }
  });

  it.skipIf(process.platform === "win32" || !hasSsh())("leaves the person's top-of-file settings applying to every other host", () => {
    const dir = root();
    const config = join(dir, "config");
    writeFileSync(config, "ServerAliveInterval 61\nHost work\n  User me\n");
    writeAlias(config, aliasBlock("nx", "10.0.0.20", desktopFiles(dir, "nx")), "nx");
    const effective = (host: string) => execFileSync("ssh", ["-G", "-F", config, host], { encoding: "utf8" });
    expect(effective("other.example")).toMatch(/^serveraliveinterval 61$/m);
    expect(effective("work")).toMatch(/^user me$/m);
    expect(effective("nx")).toMatch(/^user mausbot$/m);
    expect(effective("nx")).toMatch(/^hostname 10\.0\.0\.20$/m);
  });

  it("keeps the key and known hosts under the data folder's ssh directory", () => {
    expect(desktopFiles("/data", "a1")).toEqual({ key: "/data/ssh/a1", knownHosts: "/data/ssh/a1.known_hosts" });
  });

  it.skipIf(process.platform === "win32" || !hasKeygen())("makes a private key only this user can read", async () => {
    const files = desktopFiles(root(), "a1");
    const publicKey = await createDesktopKey(files, "a1");
    expect(publicKey).toMatch(/^ssh-ed25519 \S+ a1$/);
    expect(statSync(files.key).mode & 0o777).toBe(0o600);
    expect(() => desktopCloudInit(publicKey)).not.toThrow();
  });
});

function hasSsh(): boolean {
  try { execFileSync("ssh", ["-V"], { stdio: "ignore" }); return true; }
  catch { return false; }
}

function hasKeygen(): boolean {
  try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); return true; }
  catch (error) { return (error as { code?: string }).code !== "ENOENT"; }
}

describe("what is saved", () => {
  it("round-trips without any password and reads a broken file as empty", () => {
    const dir = root();
    const state = { pc: { address: "pc.lab.example:9440", loginId: "login-1", ownsLogin: true, fingerprint: "AB:CD", version: "pc.7.6", projects: true },
      vm: { extId: "vm-1", name: "mausbot-desktops-abc123", alias: "mausbot-desktops-abc123", ip: "10.0.0.20", projectExtId: "proj-a", ready: true } };
    writeNutanixState(dir, state);
    expect(readNutanixState(dir)).toEqual(state);
    expect(readFileSync(join(dir, NUTANIX_STATE_FILE), "utf8")).not.toMatch(/password/i);
    expect(statSync(join(dir, NUTANIX_STATE_FILE)).mode & 0o777).toBe(0o600);
    writeFileSync(join(dir, NUTANIX_STATE_FILE), "{not json");
    expect(readNutanixState(dir)).toEqual({});
  });

  it("the PC login in the Vault is one no bot may fill or read", () => {
    const vault = new VaultStore({ dataDir: root() });
    const login = vault.create({ site: "pc.lab.example", hosts: ["pc.lab.example"], exactHost: true, username: "admin", password: "secret", source: "settings", bots: [] });
    expect(vault.get(login.id)?.password).toBe("secret");
    expect(vault.usableFor("pc.lab.example", ["bot-1"])).toEqual([]);
    expect(vault.usableFor("pc.lab.example", "bot-1")).toEqual([]);
  });
});

describe("powering the server around use", () => {
  function setup(options: { power?: string; ip?: string | null } = {}) {
    const calls: string[] = [];
    let power = options.power ?? "ON";
    let ip = options.ip === undefined ? "10.0.0.20" : options.ip;
    let busy = false;
    const budgets: Array<number | undefined> = [];
    const client = {
      powerOn: async (_extId: string, timeoutMs?: number) => { calls.push("powerOn"); budgets.push(timeoutMs); power = "ON"; },
      shutdown: async () => { calls.push("shutdown"); power = "OFF"; },
      vm: async () => ({ extId: "vm-1", name: "n", powerState: power, ip, etag: null }),
    } as unknown as PcClient;
    const moved: string[] = [];
    const lifecycle = new NutanixPower({
      server: () => ({ alias: "nx", extId: "vm-1", ip: "10.0.0.20" }),
      client: () => client,
      busy: () => busy,
      addressChanged: (next) => moved.push(next),
      closeConnection: async (alias) => { calls.push(`close ${alias}`); },
      portOpen: async (host) => host === ip && power === "ON",
      sleep: async () => {},
      idleMs: 60_000,
    });
    return { lifecycle, calls, moved, budgets, setIp: (next: string) => { ip = next; }, setBusy: (next: boolean) => { busy = next; } };
  }
  const waker = (lifecycle: NutanixPower, alias = "nx") => {
    const found = lifecycle.wakerFor(alias);
    if (typeof found !== "function") throw new Error(`no waker: ${String(found)}`);
    return found;
  };

  it("shuts down after a quiet window", async () => {
    vi.useFakeTimers();
    const { lifecycle, calls } = setup();
    lifecycle.watch();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toEqual(["close nx", "shutdown"]);
  });

  it("never shuts down while a bot's turn is using its desktop, and waits a full window after it ends", async () => {
    vi.useFakeTimers();
    const { lifecycle, calls, setBusy } = setup();
    setBusy(true);
    lifecycle.watch();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(calls).toEqual([]);
    setBusy(false);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(["close nx", "shutdown"]);
  });

  it("a read stays asleep; a turn or a change the person asked for may wake it", async () => {
    const { lifecycle, setBusy } = setup({ power: "OFF" });
    expect(lifecycle.wakerFor("nx")).toBe("stay-asleep");
    setBusy(true);
    expect(typeof lifecycle.wakerFor("nx")).toBe("function");
    setBusy(false);
    lifecycle.want("nx");
    expect(typeof lifecycle.wakerFor("nx")).toBe("function");
    lifecycle.cancel();
  });

  it("another alias is neither woken nor kept asleep", () => {
    const { lifecycle } = setup();
    lifecycle.want("someone-elses-vps");
    expect(lifecycle.wakerFor("someone-elses-vps")).toBeNull();
    expect(lifecycle.wakerFor("nx")).toBe("stay-asleep");
  });

  it("wakes by powering on within its budget and returns once SSH answers, following a new address", async () => {
    const { lifecycle, calls, moved, budgets, setIp, setBusy } = setup({ power: "OFF" });
    setBusy(true);
    setIp("10.0.0.30");
    await waker(lifecycle)(60_000);
    expect(calls).toEqual(["powerOn"]);
    expect(budgets).toHaveLength(1);
    expect(budgets[0]).toBeGreaterThan(59_000);
    expect(budgets[0]).toBeLessThanOrEqual(60_000);
    expect(moved).toEqual(["10.0.0.30"]);
    lifecycle.cancel();
  });

  it("a server that already answers SSH is not asked to power on", async () => {
    const { lifecycle, calls } = setup();
    await lifecycle.powerOn(60_000);
    expect(calls).toEqual([]);
    lifecycle.cancel();
  });

  it("gives up when SSH never answers", async () => {
    const { lifecycle } = setup({ power: "OFF", ip: null });
    await expect(lifecycle.powerOn(0)).rejects.toThrow("did not come back on in time");
  });

  it("never exposes raw Prism Central error text from wake", async () => {
    const logs: string[] = [];
    const client = {
      powerOn: async () => { throw new PcError(500, "echoed secret Hunter2-raw-prism-text"); },
      shutdown: async () => {},
      vm: async () => ({ extId: "vm-1", name: "n", powerState: "OFF", ip: "10.0.0.20", etag: null }),
    } as unknown as PcClient;
    const lifecycle = new NutanixPower({
      server: () => ({ alias: "nx", extId: "vm-1", ip: "10.0.0.20" }),
      client: () => client,
      busy: () => true,
      addressChanged: () => {},
      closeConnection: async () => {},
      portOpen: async () => false,
      sleep: async () => {},
      log: (line) => logs.push(line),
      idleMs: 60_000,
    });
    const error = await lifecycle.powerOn(10_000).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain("Hunter2-raw-prism-text");
    expect((error as Error).message).toContain("Prism Central");
    expect(logs.join("\n")).toContain("Hunter2-raw-prism-text");
    lifecycle.cancel();
  });

  it("aborts shutdown if work starts while closing the SSH connection", async () => {
    vi.useFakeTimers();
    let busy = false;
    const calls: string[] = [];
    let finishClose!: () => void;
    const client = {
      powerOn: async () => { calls.push("powerOn"); },
      shutdown: async () => { calls.push("shutdown"); },
      vm: async () => ({ extId: "vm-1", name: "n", powerState: "ON", ip: "10.0.0.20", etag: null }),
    } as unknown as PcClient;
    const lifecycle = new NutanixPower({
      server: () => ({ alias: "nx", extId: "vm-1", ip: "10.0.0.20" }),
      client: () => client,
      busy: () => busy,
      addressChanged: () => {},
      closeConnection: () => {
        calls.push("close");
        return new Promise<void>((resolve) => { finishClose = resolve; });
      },
      portOpen: async () => true,
      sleep: async () => {},
      idleMs: 60_000,
    });
    lifecycle.watch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(["close"]);
    busy = true;
    finishClose();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["close"]);
    lifecycle.cancel();
  });

  it("waits for an in-flight shutdown to finish before powering back on", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let finishShutdown!: () => void;
    const client = {
      powerOn: async () => { calls.push("powerOn"); },
      shutdown: () => {
        calls.push("shutdown-start");
        return new Promise<void>((resolve) => { finishShutdown = () => { calls.push("shutdown-end"); resolve(); }; });
      },
      vm: async () => ({ extId: "vm-1", name: "n", powerState: "ON", ip: "10.0.0.20", etag: null }),
    } as unknown as PcClient;
    const lifecycle = new NutanixPower({
      server: () => ({ alias: "nx", extId: "vm-1", ip: "10.0.0.20" }),
      client: () => client,
      busy: () => false,
      addressChanged: () => {},
      closeConnection: async () => { calls.push("close"); },
      portOpen: async () => true,
      sleep: async () => {},
      idleMs: 60_000,
    });
    lifecycle.watch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toEqual(["close", "shutdown-start"]);
    const waking = lifecycle.powerOn(10_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(["close", "shutdown-start"]);
    finishShutdown();
    await waking;
    expect(calls).toEqual(["close", "shutdown-start", "shutdown-end", "powerOn"]);
    lifecycle.cancel();
  });

  it("reports isShuttingDown only after ACPI shutdown is dispatched and until it finishes", async () => {
    vi.useFakeTimers();
    let finishClose!: () => void;
    let finishShutdown!: () => void;
    const client = {
      powerOn: async () => {},
      shutdown: () => new Promise<void>((resolve) => { finishShutdown = resolve; }),
      vm: async () => ({ extId: "vm-1", name: "n", powerState: "ON", ip: "10.0.0.20", etag: null }),
    } as unknown as PcClient;
    const lifecycle = new NutanixPower({
      server: () => ({ alias: "nx", extId: "vm-1", ip: "10.0.0.20" }),
      client: () => client,
      busy: () => false,
      addressChanged: () => {},
      closeConnection: () => new Promise<void>((resolve) => { finishClose = resolve; }),
      portOpen: async () => true,
      sleep: async () => {},
      idleMs: 60_000,
    });
    lifecycle.watch();
    expect(lifecycle.isShuttingDown("nx")).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lifecycle.isShuttingDown("nx")).toBe(false);
    finishClose();
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.isShuttingDown("nx")).toBe(true);
    expect(lifecycle.isShuttingDown("other-host")).toBe(false);
    finishShutdown();
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.isShuttingDown("nx")).toBe(false);
    lifecycle.cancel();
  });

  it("scrubs wake and shutdown failure logs with the failing client's own scrubber", async () => {
    vi.useFakeTimers();
    const logs: string[] = [];
    const oldSecret = "Client-1-Secret";
    let failMode: "powerOn" | "shutdown" = "powerOn";
    const client = {
      powerOn: async () => { if (failMode === "powerOn") throw new PcError(500, `wake echoed ${oldSecret}`); },
      shutdown: async () => { if (failMode === "shutdown") throw new PcError(500, `shutdown echoed ${oldSecret}`); },
      vm: async () => ({ extId: "vm-1", name: "n", powerState: "OFF", ip: "10.0.0.20", etag: null }),
    } as unknown as PcClient;
    const lifecycle = new NutanixPower({
      server: () => ({ alias: "nx", extId: "vm-1", ip: "10.0.0.20" }),
      client: () => ({ client, scrub: (text) => text.split(oldSecret).join("[redacted]") }),
      busy: () => false,
      addressChanged: () => {},
      closeConnection: async () => {},
      portOpen: async () => false,
      sleep: async () => {},
      log: (line) => logs.push(line),
      idleMs: 60_000,
    });
    await expect(lifecycle.powerOn(10_000)).rejects.toThrow("Prism Central");
    failMode = "shutdown";
    lifecycle.watch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logs).toHaveLength(2);
    expect(logs.join("\n")).not.toContain(oldSecret);
    expect(logs.join("\n")).toContain("[redacted]");
    lifecycle.cancel();
  });

  it("applies the wake deadline to vm polls, port probes and sleep without overshoot", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const vmBudgets: Array<number | undefined> = [];
    const portBudgets: Array<number | undefined> = [];
    const sleeps: number[] = [];
    const client = {
      powerOn: async () => { vi.advanceTimersByTime(1_000); },
      shutdown: async () => {},
      vm: async (_extId: string, timeoutMs?: number) => {
        vmBudgets.push(timeoutMs);
        vi.advanceTimersByTime(800);
        return { extId: "vm-1", name: "n", powerState: "ON", ip: "10.0.0.20", etag: null };
      },
    } as unknown as PcClient;
    const lifecycle = new NutanixPower({
      server: () => ({ alias: "nx", extId: "vm-1", ip: "10.0.0.20" }),
      client: () => client,
      busy: () => true,
      addressChanged: () => {},
      closeConnection: async () => {},
      portOpen: async (_host, _port, timeoutMs) => {
        portBudgets.push(timeoutMs);
        vi.advanceTimersByTime(500);
        return false;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
        vi.advanceTimersByTime(ms);
      },
      idleMs: 60_000,
    });
    await expect(lifecycle.powerOn(4_000)).rejects.toThrow("did not come back on in time");
    expect(vmBudgets).toEqual([2_500]);
    expect(portBudgets).toEqual([3_000, 1_700]);
    expect(sleeps).toEqual([1_200]);
    lifecycle.cancel();
  });

  it("holds the mutex and keeps isShuttingDown true until PC reports the VM OFF even after a 403 task poll, blocking wake until OFF", async () => {
    vi.useFakeTimers();
    const mutex = new NutanixMutex();
    const events: string[] = [];
    let powerState: "ON" | "OFF" = "ON";
    let releaseNextVmPoll!: () => void;
    let vmPollCount = 0;
    const transport = async (request: PcRequest): Promise<PcResponse> => {
      const path = request.path.split("?")[0]!;
      if (request.method === "GET" && path === "/api/vmm/v4.3/ahv/config/vms/vm-1") {
        vmPollCount += 1;
        if (vmPollCount === 2) {
          events.push("vm-poll-after-403");
          await new Promise<void>((resolve) => { releaseNextVmPoll = resolve; });
        }
        return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState, nics: [{ nicNetworkInfo: { ipv4Config: { ipAddress: { value: "10.0.0.20" } } } }] } } };
      }
      if (request.method === "POST" && path === "/api/vmm/v4.3/ahv/config/vms/vm-1/$actions/shutdown") {
        events.push("shutdown-post");
        return { status: 202, etag: null, body: { data: { extId: "t-403" } } };
      }
      if (request.method === "GET" && path === "/api/prism/v4.4/config/tasks/t-403") {
        events.push("task-403");
        return { status: 403, etag: null, body: { data: { error: [{ message: "forbidden" }] } } };
      }
      if (request.method === "POST" && path === "/api/vmm/v4.3/ahv/config/vms/vm-1/$actions/power-on") {
        events.push("power-on-post");
        powerState = "ON";
        return { status: 202, etag: null, body: { data: {} } };
      }
      return { status: 404, etag: null, body: null };
    };
    const pc = new PcClient(transport, async () => {});
    const lifecycle = new NutanixPower({
      server: () => ({ alias: "nx", extId: "vm-1", ip: "10.0.0.20" }),
      client: () => pc,
      busy: () => false,
      addressChanged: () => {},
      closeConnection: async () => { events.push("close"); },
      mutex,
      portOpen: async () => true,
      sleep: async () => {},
      idleMs: 60_000,
    });
    lifecycle.watch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events).toEqual(["close", "shutdown-post", "task-403", "vm-poll-after-403"]);
    expect(mutex.locked).toBe(true);
    expect(lifecycle.isShuttingDown("nx")).toBe(true);

    const waking = lifecycle.powerOn(30_000);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(["close", "shutdown-post", "task-403", "vm-poll-after-403"]);

    powerState = "OFF";
    releaseNextVmPoll();
    await waking;
    expect(lifecycle.isShuttingDown("nx")).toBe(false);
    expect(mutex.locked).toBe(false);
    expect(events).toEqual(["close", "shutdown-post", "task-403", "vm-poll-after-403", "power-on-post"]);
    lifecycle.cancel();
  });

  it("releases the mutex and clears isShuttingDown immediately when the shutdown task fails", async () => {
    vi.useFakeTimers();
    const mutex = new NutanixMutex();
    const logs: string[] = [];
    const transport = async (request: PcRequest): Promise<PcResponse> => {
      const path = request.path.split("?")[0]!;
      if (request.method === "GET" && path === "/api/vmm/v4.3/ahv/config/vms/vm-1") {
        return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "ON" } } };
      }
      if (request.method === "POST" && path === "/api/vmm/v4.3/ahv/config/vms/vm-1/$actions/shutdown") {
        return { status: 202, etag: null, body: { data: { extId: "t-fail" } } };
      }
      if (request.method === "GET" && path === "/api/prism/v4.4/config/tasks/t-fail") {
        return { status: 200, etag: null, body: { data: { status: "FAILED", errorMessages: [{ message: "ACPI failed" }] } } };
      }
      return { status: 404, etag: null, body: null };
    };
    const pc = new PcClient(transport, async () => {});
    const lifecycle = new NutanixPower({
      server: () => ({ alias: "nx", extId: "vm-1", ip: "10.0.0.20" }),
      client: () => pc,
      busy: () => false,
      addressChanged: () => {},
      closeConnection: async () => {},
      mutex,
      portOpen: async () => true,
      sleep: async () => {},
      log: (line) => logs.push(line),
      idleMs: 60_000,
    });
    lifecycle.watch();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lifecycle.isShuttingDown("nx")).toBe(false);
    expect(mutex.locked).toBe(false);
    expect(logs.join("\n")).toContain("ACPI failed");
    lifecycle.cancel();
  });

  it("keeps the SSH gate closed when accepted shutdown polling returns UNDETERMINED, fails, or times out, and clears only once a later read confirms OFF", async () => {
    vi.useFakeTimers();
    for (const mode of ["undetermined", "read-error", "timeout"] as const) {
      const mutex = new NutanixMutex();
      let phase: "initial" | "post-shutdown" | "still-on" | "now-off" = "initial";
      let powerOnCalls = 0;
      let portProbeCalls = 0;
      const reported: boolean[] = [];
      const transport = async (request: PcRequest): Promise<PcResponse> => {
        const path = request.path.split("?")[0]!;
        if (request.method === "GET" && path === "/api/vmm/v4.3/ahv/config/vms/vm-1") {
          if (phase === "initial") {
            return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "ON", nics: [{ nicNetworkInfo: { ipv4Config: { ipAddress: { value: "10.0.0.20" } } } }] } } };
          }
          if (phase === "post-shutdown") {
            if (mode === "undetermined") return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "UNDETERMINED" } } };
            if (mode === "read-error") return { status: 500, etag: null, body: { data: { error: [{ message: "PC read failed" }] } } };
            vi.advanceTimersByTime(60_000);
            return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "ON" } } };
          }
          if (phase === "still-on") {
            return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "ON" } } };
          }
          return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "OFF", nics: [{ nicNetworkInfo: { ipv4Config: { ipAddress: { value: "10.0.0.20" } } } }] } } };
        }
        if (request.method === "POST" && path === "/api/vmm/v4.3/ahv/config/vms/vm-1/$actions/shutdown") {
          phase = "post-shutdown";
          return { status: 202, etag: null, body: { data: {} } };
        }
        if (request.method === "POST" && path === "/api/vmm/v4.3/ahv/config/vms/vm-1/$actions/power-on") {
          powerOnCalls += 1;
          return { status: 202, etag: null, body: { data: {} } };
        }
        return { status: 404, etag: null, body: null };
      };
      const pc = new PcClient(transport, async (ms) => { vi.advanceTimersByTime(ms); });
      const lifecycle = new NutanixPower({
        server: () => ({ alias: "nx", extId: "vm-1", ip: "10.0.0.20" }),
        client: () => pc,
        busy: () => false,
        addressChanged: () => {},
        closeConnection: async () => {},
        mutex,
        onShutdownUnknown: (unknown) => { reported.push(unknown); },
        portOpen: async () => { portProbeCalls += 1; return true; },
        sleep: async () => {},
        idleMs: 60_000,
      });

      lifecycle.watch();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(lifecycle.isShuttingDown("nx"), mode).toBe(true);
      expect(reported, mode).toEqual([true]);

      // Neither UNDETERMINED/read-error nor ON reopens SSH or takes the port-22 fast path.
      phase = "still-on";
      await expect(lifecycle.powerOn(10_000)).rejects.toThrow("uncertain after shutdown");
      expect(lifecycle.isShuttingDown("nx"), mode).toBe(true);
      expect(portProbeCalls, mode).toBe(0);
      expect(powerOnCalls, mode).toBe(0);

      // Once PC confirms OFF, the gate clears and powerOn proceeds without taking the port-22 fast path before power-on.
      phase = "now-off";
      await lifecycle.powerOn(10_000);
      expect(lifecycle.isShuttingDown("nx"), mode).toBe(false);
      expect(powerOnCalls, mode).toBe(1);
      expect(reported, mode).toEqual([true, false]);
      lifecycle.cancel();
    }
  });
});
