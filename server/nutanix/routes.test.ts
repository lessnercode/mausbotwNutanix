import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as netConnect, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loginPlace } from "../../shared/logins.ts";
import { json, readBody } from "../harness/http.ts";
import { createNutanixRoutes, nutanixAsk, type NutanixRouteDeps } from "../routes/nutanix.ts";
import { dispatchRoutes } from "../routes/table.ts";
import { VaultStore } from "../vault-store.ts";
import { vpsComputerAction } from "../vps-computer.ts";
import { sharedVpsHost } from "../vps-hosts.ts";
import { vpsHostHooks } from "../vps-ssh.ts";
import { aliasBlock, desktopFiles, readNutanixState, writeAlias, writeNutanixState } from "./host.ts";
import { PcClient, PcError, type PcRequest, type PcResponse } from "./pc.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEXAMPLEexampleEXAMPLEexampleEXAMPLE1234 test";
const PASSWORD = "Hunter2-very-secret";
const pool = [{ ipv4: { poolList: [{ startIp: { value: "10.0.0.10" }, endIp: { value: "10.0.0.200" } }] } }];

const servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete vpsHostHooks.wakerFor;
  delete vpsHostHooks.shuttingDown;
  delete vpsHostHooks.want;
  delete vpsHostHooks.emptied;
  sharedVpsHost.alias = null;
});

type Fake = Partial<Record<keyof PcClient, (...args: any[]) => unknown>>;

async function serve(pc: Fake = {}, extra: Partial<NutanixRouteDeps> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-nutanix-routes-"));
  roots.push(dataDir);
  const vault = new VaultStore({ dataDir });
  const logs: string[] = [];
  const calls: string[] = [];
  let defaultAlias: string | null = "my-own-vps";
  const client = {
    connect: async () => ({ version: "pc.7.6", projects: false }),
    images: async () => [{ extId: "img-1", name: "Ubuntu 24.04", type: "DISK_IMAGE" }],
    templates: async () => [],
    subnets: async () => [{ extId: "sub-1", name: "Lab", clusterReference: "c1", ipConfig: pool, ipUsage: { numFreeIPs: 9 } }],
    createVm: async () => "vm-1",
    powerOn: async () => {},
    vm: async () => ({ extId: "vm-1", name: "n", powerState: "ON", ip: "10.0.0.20", etag: null }),
    vmIdNamed: async () => null,
    taskState: async () => ({ state: "failed" as const, vmExtId: null }),
    deleteVm: async (extId: string) => { calls.push(`delete ${extId}`); },
    ...pc,
  } as unknown as PcClient;
  const routes = [createNutanixRoutes({
    dataDir, available: true, vault, log: (line) => logs.push(line),
    defaultAlias: () => defaultAlias,
    setDefaultAlias: (alias) => { defaultAlias = alias || null; calls.push(`default ${alias}`); },
    clearBotAliases: () => calls.push("clear bot aliases"), owners: () => [], busy: () => false, desktopSize: () => ({ desktops: 2, perDesktop: { cpus: 2, memoryGb: 4 } }), changed: () => calls.push("changed"),
    claimVps: () => { calls.push("claim"); return () => calls.push("release"); },
    sshConfig: join(dataDir, "ssh_config"),
    pcClient: () => client,
    fingerprint: async () => "AB:CD",
    createKey: async () => KEY,
    waitForDocker: async () => {},
    closeConnection: async () => {},
    ...extra,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const handled = await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth: { kind: "loopback", scopes: ["admin"] }, json, readBody });
    if (!handled) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const port = (server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const send = async (method: string, path: string, body: unknown = {}) => {
    const response = await fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const status = async () => (await (await fetch(`${base}/api/nutanix`)).json()) as any;
  const until = async (done: (status: any) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const now = await status();
      if (done(now)) return now;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("timed out");
  };
  const connect = (address = "pc.lab.example", username = "admin", password = PASSWORD) => send("POST", "/api/nutanix/connect", { address, username, password });
  return { dataDir, vault, logs, calls, port, base, send, status, until, connect, defaultAlias: () => defaultAlias };
}

const deployBody = { projectExtId: null, source: { kind: "image", extId: "img-1" }, subnetExtId: "sub-1", desktops: 3 };

describe("deploying the server", () => {
  it("two deploys at once start one server: the slot is taken before the request body is read", async () => {
    let creates = 0;
    const app = await serve({ createVm: () => { creates++; return new Promise(() => {}); } });
    await app.connect();
    const [first, second] = await Promise.all([app.send("POST", "/api/nutanix/deploy", deployBody), app.send("POST", "/api/nutanix/deploy", deployBody)]);
    expect([first.status, second.status].sort()).toEqual([202, 409]);
    expect(creates).toBe(1);
  });

  it("a refused request frees the slot", async () => {
    const app = await serve();
    await app.connect();
    expect((await app.send("POST", "/api/nutanix/deploy", { nonsense: true })).status).toBe(400);
    expect((await app.send("POST", "/api/nutanix/deploy", deployBody)).status).toBe(202);
  });

  it("remembers the server before asking Prism Central for it, and finds it by name when the answer is lost", async () => {
    let savedBefore: unknown;
    const app = await serve({
      createVm: async () => { savedBefore = readNutanixState(app.dataDir).vm; throw new PcError(504, "Prism Central's task did not finish in time"); },
      vmIdNamed: async () => "vm-9",
    });
    await app.connect();
    await app.send("POST", "/api/nutanix/deploy", deployBody);
    const failed = await app.until((now) => now.deploy?.phase === "failed");
    expect(savedBefore).toMatchObject({ extId: null, ready: false });
    expect(readNutanixState(app.dataDir).vm).toMatchObject({ extId: "vm-9", ready: false });
    expect(failed.server).not.toBeNull();
  });

  it("refuses a source that is no longer offered, such as a Windows image", async () => {
    const app = await serve({ images: async () => [{ extId: "img-1", name: "Windows Server 2022", type: "DISK_IMAGE" }] });
    await app.connect();
    expect((await app.send("POST", "/api/nutanix/deploy", deployBody)).status).toBe(400);
  });

  it("refuses a template that cannot take the sign-in key, including one with no override metadata", async () => {
    const app = await serve({
      templates: async () => [
        { extId: "t-1", templateName: "Appliance", templateVersionSpec: { isGcOverrideEnabled: false } },
        { extId: "t-2", templateName: "Unknown Override" },
      ],
    });
    await app.connect();
    expect((await app.send("POST", "/api/nutanix/deploy", { ...deployBody, source: { kind: "template", extId: "t-1" } })).status).toBe(400);
    expect((await app.send("POST", "/api/nutanix/deploy", { ...deployBody, source: { kind: "template", extId: "t-2" } })).status).toBe(400);
  });

  it("hands every bot to the one server, replacing a default that was already set", async () => {
    const app = await serve();
    await app.connect();
    await app.send("POST", "/api/nutanix/deploy", deployBody);
    const done = await app.until((now) => now.deploy?.phase === "ready");
    expect(app.defaultAlias()).toBe(done.server.alias);
    expect(app.calls).toContain("clear bot aliases");
    expect(sharedVpsHost.alias).toBe(done.server.alias);
  });

  it("gives the ready server's Prism Central address for the console button", async () => {
    const app = await serve();
    await app.connect();
    await app.send("POST", "/api/nutanix/deploy", deployBody);
    const done = await app.until((now) => now.deploy?.phase === "ready");
    expect(done.server.consoleUrl).toMatch(/^https:\/\/[^/]+:9440\/$/);
  });

  it("never logs or shows the Prism Central password from a failure, even for 1-3 character passwords", async () => {
    const token = Buffer.from(`admin:${PASSWORD}`).toString("base64");
    const app = await serve({ createVm: async () => { throw new PcError(500, `bad request for admin:${PASSWORD} (Basic ${token})`); } });
    await app.connect();
    await app.send("POST", "/api/nutanix/deploy", deployBody);
    const failed = await app.until((now) => now.deploy?.phase === "failed");
    expect(failed.deploy.error).not.toContain(PASSWORD);
    expect(failed.deploy.error).not.toContain(token);
    expect(app.logs.join("\n")).not.toContain(PASSWORD);
    expect(app.logs.length).toBeGreaterThan(0);

    const shortPw = "pw";
    const shortToken = Buffer.from(`admin:${shortPw}`).toString("base64");
    const shortApp = await serve({
      connect: async () => { throw new PcError(500, `rejected admin:${shortPw} Basic ${shortToken}`); },
    });
    const res = await shortApp.connect("pc.lab.example", "admin", shortPw);
    expect(res.status).toBe(502);
    expect(res.body.error).not.toContain(shortPw);
    expect(res.body.error).not.toContain(shortToken);

    const oneChar = "x";
    const oneApp = await serve({ createVm: async () => { throw new PcError(500, `bad secret ${oneChar}`); } });
    await oneApp.connect("pc.lab.example", "admin", oneChar);
    await oneApp.send("POST", "/api/nutanix/deploy", deployBody);
    const oneFailed = await oneApp.until((now) => now.deploy?.phase === "failed");
    expect(oneFailed.deploy.error).not.toContain(oneChar);
    expect(oneApp.logs.join("\n")).not.toContain(oneChar);
  });

  it("never leaks raw Prism error text or password through the wake hook", async () => {
    const app = await serve(
      { powerOn: async () => { throw new PcError(500, `Prism echoed ${PASSWORD} in wake failure`); } },
      { portOpen: async () => false },
    );
    await app.connect();
    writeNutanixState(app.dataDir, {
      ...readNutanixState(app.dataDir),
      vm: { extId: "vm-1", name: "mausbot-desktops-wake", alias: "mausbot-desktops-wake", ip: "10.0.0.20", projectExtId: null, ready: true },
    });
    vpsHostHooks.want?.("mausbot-desktops-wake");
    const waker = vpsHostHooks.wakerFor?.("mausbot-desktops-wake");
    expect(typeof waker).toBe("function");
    const err = await (waker as (ms: number) => Promise<void>)(5_000).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(PASSWORD);
    expect((err as Error).message).not.toContain("Prism echoed");
    expect(app.logs.join("\n")).not.toContain(PASSWORD);
    expect(app.logs.length).toBeGreaterThan(0);
  });

  it("serializes reconnect behind an in-flight wake and scrubs old credentials even if the Vault login changes", async () => {
    const oldPassword = "Old-Wake-Secret-99";
    const oldBasic = Buffer.from(`admin:${oldPassword}`).toString("base64");
    const newPassword = "New-Reconnect-Password-42";
    let rejectWake!: (error: Error) => void;
    let wakeEntered!: () => void;
    const entered = new Promise<void>((resolve) => { wakeEntered = resolve; });
    const events: string[] = [];
    const app = await serve(
      {
        connect: async () => {
          events.push("connect");
          return { version: "pc.7.6", projects: false };
        },
        powerOn: () => {
          events.push("wake-start");
          wakeEntered();
          return new Promise<void>((_resolve, reject) => { rejectWake = reject; });
        },
      },
      { portOpen: async () => false },
    );
    await app.connect("pc.lab.example", "admin", oldPassword);
    events.length = 0;
    writeNutanixState(app.dataDir, {
      ...readNutanixState(app.dataDir),
      vm: { extId: "vm-1", name: "mausbot-desktops-wake", alias: "mausbot-desktops-wake", ip: "10.0.0.20", projectExtId: null, ready: true },
    });
    vpsHostHooks.want?.("mausbot-desktops-wake");
    const waker = vpsHostHooks.wakerFor?.("mausbot-desktops-wake") as (ms: number) => Promise<void>;
    const waking = waker(5_000).catch((e: Error) => e);
    await entered;

    const reconnecting = app.connect("pc.lab.example", "admin", newPassword);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual(["wake-start"]);

    app.vault.remove(readNutanixState(app.dataDir).pc!.loginId);
    expect(app.vault.secretValues()).not.toContain(oldPassword);

    rejectWake(new PcError(500, `Prism rejected admin:${oldPassword} (Basic ${oldBasic})`));
    const [err, reconnected] = await Promise.all([waking, reconnecting]);
    expect(events).toEqual(["wake-start", "connect"]);
    expect(reconnected.status).toBe(200);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(oldPassword);
    expect((err as Error).message).not.toContain(oldBasic);
    expect(app.logs.length).toBeGreaterThan(0);
    expect(app.logs.join("\n")).not.toContain(oldPassword);
    expect(app.logs.join("\n")).not.toContain(oldBasic);
  });
});

describe("sizing an image-based server", () => {
  it("offers 1 to 8 desktops from the app's own desktop size, defaulting to Max desktops, and creates the chosen one", async () => {
    let spec: any;
    const app = await serve({ createVm: async (given: unknown) => { spec = given; return "vm-1"; } });
    await app.connect();
    const sizes = (await app.status()).sizes;
    expect(sizes.default).toBe(2);
    expect(sizes.shapes.map((one: any) => one.desktops)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    await app.send("POST", "/api/nutanix/deploy", deployBody);
    await app.until((now) => now.deploy?.phase === "ready");
    expect(spec).toMatchObject({ kind: "image", vcpus: 6, memoryGb: 14, diskGb: 120 });
  });

  it("refuses a count outside the Max desktops range", async () => {
    const app = await serve();
    await app.connect();
    expect((await app.send("POST", "/api/nutanix/deploy", { ...deployBody, desktops: 9 })).status).toBe(400);
  });
});

describe("connecting", () => {
  it("connects again while a server exists, but only to the same Prism Central", async () => {
    const app = await serve();
    await app.connect();
    const pc = readNutanixState(app.dataDir).pc!;
    writeNutanixState(app.dataDir, { pc, vm: { extId: "vm-1", name: "mausbot-desktops-aaaaaa", alias: "mausbot-desktops-aaaaaa", ip: "10.0.0.20", projectExtId: null, ready: true } });
    expect((await app.connect()).status).toBe(200);
    expect((await app.connect("pc.other.example")).status).toBe(409);
  });

  it("stores a new PC login as its own record with no bot grants instead of inheriting grants from a matching Vault login", async () => {
    const app = await serve();
    const theirs = app.vault.create({ ...loginPlace("pc.lab.example", [], true), username: "admin", password: "old", source: "settings", bots: ["bot-1"] });
    await app.connect();
    const saved = readNutanixState(app.dataDir).pc!;
    expect(saved.loginId).not.toBe(theirs.id);
    expect(saved.ownsLogin).toBe(true);
    expect((await app.status()).pc.botsMayUse).toBe(false);
    expect(app.vault.get(saved.loginId)).toMatchObject({ username: "admin", password: PASSWORD, bots: [] });
    expect(app.vault.get(theirs.id)).toMatchObject({ username: "admin", password: "old", bots: ["bot-1"] });
    expect(app.vault.usableFor("pc.lab.example", "bot-1").map((one) => one.password)).toEqual(["old"]);
    app.vault.create({ ...loginPlace("pc.lab.example", [], true), username: "admin", password: "browser-new", source: "card", bots: ["bot-2"] });
    expect(app.vault.get(saved.loginId)).toMatchObject({ password: PASSWORD, bots: [] });
    await app.connect("pc.lab.example", "someone-else");
    expect(app.vault.get(theirs.id)).not.toBeNull();
    expect(app.vault.get(saved.loginId)).toBeNull();
  });

  it("replaces a login it made itself", async () => {
    const app = await serve();
    await app.connect();
    const ours = readNutanixState(app.dataDir).pc!;
    expect(ours.ownsLogin).toBe(true);
    expect((await app.status()).pc.botsMayUse).toBe(false);
    await app.connect("pc.lab.example", "someone-else");
    expect(app.vault.get(ours.loginId)).toBeNull();
  });
});

describe("deleting the server", () => {
  const unfinished = { extId: null, name: "mausbot-desktops-bbbbbb", alias: "mausbot-desktops-bbbbbb", ip: null, projectExtId: null, ready: false };

  it("finds a server whose id was never learned by its name, and holds other VPS changes off meanwhile", async () => {
    const app = await serve({ vmIdNamed: async () => "vm-7" });
    await app.connect();
    writeNutanixState(app.dataDir, { ...readNutanixState(app.dataDir), vm: unfinished });
    expect((await app.send("DELETE", "/api/nutanix/server")).status).toBe(200);
    expect(app.calls).toEqual(["claim", "delete vm-7", "release", "changed"]);
    expect(readNutanixState(app.dataDir).vm).toBeUndefined();
  });

  it("keeps the default and the record when Prism Central refuses the delete", async () => {
    const app = await serve({ vmIdNamed: async () => "vm-7", deleteVm: async () => { throw new PcError(500, "no"); } });
    await app.connect();
    writeNutanixState(app.dataDir, { ...readNutanixState(app.dataDir), vm: { ...unfinished, alias: "my-own-vps", name: "my-own-vps" } });
    expect((await app.send("DELETE", "/api/nutanix/server")).status).toBe(502);
    expect(app.defaultAlias()).toBe("my-own-vps");
    expect(readNutanixState(app.dataDir).vm).toBeDefined();
    expect(app.calls).toContain("release");
  });

  it("asks to delete once the last bot desktop on it is removed, and can be told to keep it", async () => {
    const app = await serve();
    await app.connect();
    writeNutanixState(app.dataDir, { ...readNutanixState(app.dataDir), vm: { ...unfinished, extId: "vm-1", ip: "10.0.0.20", ready: true } });
    vpsHostHooks.emptied?.("some-other-host");
    expect((await app.status()).server.askDelete).toBe(false);
    vpsHostHooks.emptied?.(unfinished.alias);
    expect((await app.status()).server.askDelete).toBe(true);
    expect(nutanixAsk(app.dataDir)).toBe(unfinished.name);
    expect(app.calls).toContain("changed");
    await app.send("POST", "/api/nutanix/keep");
    expect((await app.status()).server.askDelete).toBe(false);
    expect(nutanixAsk(app.dataDir)).toBeUndefined();
  });

  it("refuses to clear an unresolved create while its task is still running, then deletes the late VM once it finishes", async () => {
    let taskStatus: { state: "running" | "succeeded"; vmExtId: string | null } = { state: "running", vmExtId: null };
    const app = await serve({
      createVm: async (_spec: unknown, _timeout: unknown, onTask?: (id: string) => void) => {
        onTask?.("task-late");
        throw new PcError(504, "Prism Central's task did not finish in time");
      },
      taskState: async () => taskStatus,
      vmIdNamed: async () => null,
    });
    await app.connect();
    await app.send("POST", "/api/nutanix/deploy", deployBody);
    await app.until((now) => now.deploy?.phase === "failed");
    expect(readNutanixState(app.dataDir).vm).toMatchObject({ extId: null, taskExtId: "task-late" });

    expect((await app.send("DELETE", "/api/nutanix/server")).status).toBe(409);
    expect(readNutanixState(app.dataDir).vm).toBeDefined();
    expect((await app.send("POST", "/api/nutanix/deploy", deployBody)).status).toBe(409);

    taskStatus = { state: "succeeded", vmExtId: "vm-late" };
    expect((await app.send("DELETE", "/api/nutanix/server")).status).toBe(200);
    expect(app.calls).toContain("delete vm-late");
    expect(readNutanixState(app.dataDir).vm).toBeUndefined();
  });

  it("refuses to clear an unresolved create within the create window when no task id was learned and no VM appears yet", async () => {
    const app = await serve({
      createVm: async () => { throw new Error("socket closed before task id"); },
      vmIdNamed: async () => null,
    });
    await app.connect();
    await app.send("POST", "/api/nutanix/deploy", deployBody);
    await app.until((now) => now.deploy?.phase === "failed");

    expect((await app.send("DELETE", "/api/nutanix/server")).status).toBe(409);
    expect(readNutanixState(app.dataDir).vm).toBeDefined();
  });

  it("serializes concurrent DELETE and reconnect through one mutex so reconnect never restores a deleted VM record", async () => {
    const events: string[] = [];
    let releaseDelete!: () => void;
    let deleteEntered!: () => void;
    const entered = new Promise<void>((resolve) => { deleteEntered = resolve; });
    const app = await serve({
      connect: async () => {
        events.push("connect");
        return { version: "pc.7.6", projects: false };
      },
      deleteVm: async (extId: string) => {
        events.push(`delete-start ${extId}`);
        deleteEntered();
        await new Promise<void>((resolve) => { releaseDelete = resolve; });
        events.push(`delete-end ${extId}`);
      },
    });
    await app.connect("pc.first.example");
    events.length = 0;
    writeNutanixState(app.dataDir, {
      ...readNutanixState(app.dataDir),
      vm: { ...unfinished, extId: "vm-del" },
    });

    const deleting = app.send("DELETE", "/api/nutanix/server");
    await entered;
    const reconnecting = app.connect("pc.second.example");
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual(["delete-start vm-del"]);

    releaseDelete();
    const [deleted, reconnected] = await Promise.all([deleting, reconnecting]);
    expect(deleted.status).toBe(200);
    expect(reconnected.status).toBe(200);
    expect(events).toEqual(["delete-start vm-del", "delete-end vm-del", "connect"]);
    expect(readNutanixState(app.dataDir).vm).toBeUndefined();
    expect(readNutanixState(app.dataDir).pc?.address).toBe("pc.second.example:9440");
  });

  it("acquires the mutex before reading DELETE's request body so a concurrent reconnect cannot snapshot pre-delete state", async () => {
    const events: string[] = [];
    let releaseBody!: () => void;
    let bodyEntered!: () => void;
    const entered = new Promise<void>((resolve) => { bodyEntered = resolve; });
    const dataDir = mkdtempSync(join(tmpdir(), "omb-nutanix-body-race-"));
    roots.push(dataDir);
    const vault = new VaultStore({ dataDir });
    const client = {
      connect: async () => { events.push("connect"); return { version: "pc.7.6", projects: false }; },
      deleteVm: async (extId: string) => { events.push(`delete ${extId}`); },
    } as unknown as PcClient;
    const handler = createNutanixRoutes({
      dataDir, available: true, vault, log: () => {},
      defaultAlias: () => null, setDefaultAlias: () => {}, clearBotAliases: () => {},
      owners: () => [], busy: () => false, desktopSize: () => ({ desktops: 2, perDesktop: { cpus: 2, memoryGb: 4 } }),
      changed: () => {}, claimVps: () => () => {},
      sshConfig: join(dataDir, "ssh_config"), pcClient: () => client, fingerprint: async () => "AB:CD",
      closeConnection: async () => {},
    });
    const call = async (method: string, path: string, body: unknown, holdBody = false) => {
      let statusCode = 0;
      let reply: any;
      await handler({
        req: { headers: { "content-type": "application/json" } } as any,
        res: { setHeader: () => {} } as any,
        url: new URL(`http://localhost${path}`),
        path,
        method,
        auth: { kind: "loopback", scopes: ["admin"] },
        json: (_res, code, data) => { statusCode = code; reply = data; },
        readBody: async () => {
          if (holdBody) {
            events.push("delete-body-start");
            bodyEntered();
            await new Promise<void>((resolve) => { releaseBody = resolve; });
            events.push("delete-body-end");
          }
          return body;
        },
      });
      return { status: statusCode, body: reply };
    };
    await call("POST", "/api/nutanix/connect", { address: "pc.first.example", username: "admin", password: PASSWORD });
    events.length = 0;
    writeNutanixState(dataDir, { ...readNutanixState(dataDir), vm: { ...unfinished, extId: "vm-body-race" } });

    const deleting = call("DELETE", "/api/nutanix/server", {}, true);
    await entered;
    const reconnecting = call("POST", "/api/nutanix/connect", { address: "pc.second.example", username: "admin", password: PASSWORD });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual(["delete-body-start"]);

    releaseBody();
    const [deleted, reconnected] = await Promise.all([deleting, reconnecting]);
    expect(deleted.status).toBe(200);
    expect(reconnected.status).toBe(200);
    expect(events).toEqual(["delete-body-start", "delete-body-end", "delete vm-body-race", "connect"]);
    expect(readNutanixState(dataDir).vm).toBeUndefined();
    expect(readNutanixState(dataDir).pc?.address).toBe("pc.second.example:9440");
  });

  it("keeps the create reservation and refuses explicit clear inside the create window and for legacy records without startedAt, clearing only on confirmed task failure or after a post-window check finds no VM", async () => {
    const now = Date.now();
    for (const scenario of [
      {
        label: "unreadable task inside create window",
        vm: { ...unfinished, taskExtId: "task-403", startedAt: now },
        taskState: async () => ({ state: "unreadable" as const, vmExtId: null }),
      },
      {
        label: "missing task id inside create window",
        vm: { ...unfinished, startedAt: now },
      },
      {
        label: "succeeded task without VM id inside create window",
        vm: { ...unfinished, taskExtId: "task-no-id", startedAt: now },
        taskState: async () => ({ state: "succeeded" as const, vmExtId: null }),
      },
      {
        label: "legacy record without startedAt or task",
        vm: { ...unfinished },
      },
      {
        label: "legacy record without startedAt and unreadable task",
        vm: { ...unfinished, taskExtId: "task-legacy-403" },
        taskState: async () => ({ state: "unreadable" as const, vmExtId: null }),
      },
    ]) {
      const app = await serve({
        vmIdNamed: async () => null,
        ...(scenario.taskState ? { taskState: scenario.taskState } : {}),
      });
      await app.connect();
      writeNutanixState(app.dataDir, { ...readNutanixState(app.dataDir), vm: scenario.vm as any });

      expect((await app.send("DELETE", "/api/nutanix/server")).status, scenario.label).toBe(409);
      expect(readNutanixState(app.dataDir).vm?.startedAt, scenario.label).toBeTypeOf("number");
      const checked = await app.send("POST", "/api/nutanix/check");
      expect(checked.status, scenario.label).toBe(200);
      expect(checked.body.check.outcome, scenario.label).toBe("pending");
      expect(checked.body.server.needsCheck, scenario.label).toBe(true);
      expect(checked.body.server.canClear, scenario.label).toBe(false);

      expect((await app.send("DELETE", "/api/nutanix/server", { confirmedChecked: true })).status, scenario.label).toBe(409);
      expect(readNutanixState(app.dataDir).vm, scenario.label).toBeDefined();
      expect((await app.send("POST", "/api/nutanix/deploy", deployBody)).status, scenario.label).toBe(409);
    }

    const failedTaskApp = await serve({
      taskState: async () => ({ state: "failed", vmExtId: null }),
      vmIdNamed: async () => null,
    });
    await failedTaskApp.connect();
    writeNutanixState(failedTaskApp.dataDir, {
      ...readNutanixState(failedTaskApp.dataDir),
      vm: { ...unfinished, taskExtId: "task-failed" },
    });
    expect((await failedTaskApp.send("DELETE", "/api/nutanix/server")).status).toBe(200);
    expect(readNutanixState(failedTaskApp.dataDir).vm).toBeUndefined();
  });

  it("never releases the create reservation on empty DELETE lookups alone past the create window, clearing only after a check finds no VM and the user explicitly resolves it", async () => {
    const hourAgo = Date.now() - 60 * 60_000;
    const cases: Array<{
      label: string;
      vm: Record<string, unknown>;
      taskState?: () => Promise<{ state: "running" | "succeeded" | "failed" | "unreadable"; vmExtId: string | null }>;
    }> = [
      {
        label: "unreadable task past 15 min",
        vm: { ...unfinished, taskExtId: "task-403", startedAt: hourAgo },
        taskState: async () => ({ state: "unreadable", vmExtId: null }),
      },
      {
        label: "missing task past 15 min",
        vm: { ...unfinished, startedAt: hourAgo },
      },
      {
        label: "succeeded task without VM ID",
        vm: { ...unfinished, taskExtId: "task-no-id", startedAt: hourAgo },
        taskState: async () => ({ state: "succeeded", vmExtId: null }),
      },
    ];

    for (const scenario of cases) {
      const app = await serve({
        vmIdNamed: async () => null,
        ...(scenario.taskState ? { taskState: scenario.taskState } : {}),
      });
      await app.connect();
      writeNutanixState(app.dataDir, { ...readNutanixState(app.dataDir), vm: scenario.vm as any });

      // Ordinary DELETE lookups alone never arm canClear or release the reservation.
      expect((await app.send("DELETE", "/api/nutanix/server")).status, scenario.label).toBe(409);
      expect((await app.send("DELETE", "/api/nutanix/server")).status, scenario.label).toBe(409);
      expect(readNutanixState(app.dataDir).vm, scenario.label).toMatchObject({ needsCheck: true });
      expect((await app.status()).server.canClear, scenario.label).toBe(false);

      const premature = await app.send("DELETE", "/api/nutanix/server", { confirmedChecked: true });
      expect(premature.status, scenario.label).toBe(409);
      expect((await app.send("POST", "/api/nutanix/deploy", deployBody)).status, scenario.label).toBe(409);

      const checked = await app.send("POST", "/api/nutanix/check");
      expect(checked.status, scenario.label).toBe(200);
      expect(checked.body.check.outcome, scenario.label).toBe("missing");
      expect(checked.body.server.canClear, scenario.label).toBe(true);

      const ordinary = await app.send("DELETE", "/api/nutanix/server");
      expect(ordinary.status, scenario.label).toBe(409);
      expect(readNutanixState(app.dataDir).vm, scenario.label).toBeDefined();

      const resolved = await app.send("DELETE", "/api/nutanix/server", { confirmedChecked: true });
      expect(resolved.status, scenario.label).toBe(200);
      expect(readNutanixState(app.dataDir).vm, scenario.label).toBeUndefined();
    }
  });

  it("POST /api/nutanix/check only checks and reports, never deleting a newly visible VM, leaving delete as a separate confirmed action", async () => {
    let found: string | null = null;
    const app = await serve({
      taskState: async () => ({ state: "succeeded", vmExtId: null }),
      vmIdNamed: async () => found,
    });
    await app.connect();
    writeNutanixState(app.dataDir, {
      ...readNutanixState(app.dataDir),
      vm: { ...unfinished, taskExtId: "task-no-id", startedAt: Date.now() - 60 * 60_000, needsCheck: true },
    });

    const emptyCheck = await app.send("POST", "/api/nutanix/check");
    expect(emptyCheck.status).toBe(200);
    expect(emptyCheck.body.check.outcome).toBe("missing");
    expect(emptyCheck.body.server.canClear).toBe(true);
    expect(app.calls.filter((call) => call.startsWith("delete "))).toEqual([]);

    found = "vm-late-visible";
    const foundCheck = await app.send("POST", "/api/nutanix/check");
    expect(foundCheck.status).toBe(200);
    expect(foundCheck.body.check.outcome).toBe("found");
    expect(foundCheck.body.server.needsCheck).toBe(false);
    expect(readNutanixState(app.dataDir).vm).toMatchObject({ extId: "vm-late-visible", needsCheck: false });
    expect(app.calls.filter((call) => call.startsWith("delete "))).toEqual([]);

    // Explicit clear must not delete a newly visible VM either.
    const clearRefused = await app.send("DELETE", "/api/nutanix/server", { confirmedChecked: true });
    expect(clearRefused.status).toBe(409);
    expect(app.calls.filter((call) => call.startsWith("delete "))).toEqual([]);

    // Confirmed delete removes the VM.
    expect((await app.send("DELETE", "/api/nutanix/server")).status).toBe(200);
    expect(app.calls).toContain("delete vm-late-visible");
    expect(readNutanixState(app.dataDir).vm).toBeUndefined();
  });

  it("refuses delete while a VPS desktop is actively provisioning", async () => {
    const app = await serve();
    await app.connect();
    writeNutanixState(app.dataDir, { ...readNutanixState(app.dataDir), vm: unfinished });
    let releaseProvision!: () => void;
    const provisionStarted = new Promise<void>((resolve) => {
      void vpsComputerAction("provision", { vps: { sshAlias: unfinished.alias } }, "bot-prov", async () => {
        resolve();
        await new Promise<void>((done) => { releaseProvision = done; });
        throw new Error("cancelled");
      }).catch(() => {});
    });
    await provisionStarted;
    try {
      const deleted = await app.send("DELETE", "/api/nutanix/server");
      expect(deleted.status).toBe(409);
      expect(app.calls).not.toContain("delete vm-1");
      expect(app.calls).toContain("release");
      expect(readNutanixState(app.dataDir).vm).toBeDefined();
    } finally {
      releaseProvision();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  });

  it("an aborted request queued behind the mutex settles immediately and never blocks later actions", async () => {
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => { firstEntered = resolve; });
    let connectCalls = 0;
    const app = await serve({
      connect: async () => {
        connectCalls += 1;
        if (connectCalls === 2) {
          firstEntered();
          await new Promise<void>((resolve) => { releaseFirst = resolve; });
        }
        return { version: "pc.7.6", projects: false };
      },
    });
    await app.connect();

    // Hold the mutex with a slow reconnect.
    const holding = app.connect();
    await entered;

    // Queue both a fetch-aborted POST and a raw partial-body destroyed socket behind the mutex.
    const ac = new AbortController();
    const abortedFetch = fetch(`${app.base}/api/nutanix/keep`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: ac.signal,
    }).catch(() => {});
    await new Promise<void>((resolve) => {
      const sock = netConnect(app.port, "127.0.0.1", () => {
        sock.write("POST /api/nutanix/keep HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{\"a\":");
        setTimeout(() => { sock.destroy(); resolve(); }, 15);
      });
    });
    ac.abort();
    await abortedFetch;
    await new Promise((resolve) => setTimeout(resolve, 25));

    // Release the holder: queued aborted requests must settle and release the mutex immediately.
    releaseFirst();
    expect((await holding).status).toBe(200);
    const later = await app.send("POST", "/api/nutanix/keep");
    expect(later.status).toBe(200);
  });

  it("keeps the record, alias, default and files and surfaces check-Prism-Central when an accepted delete task returns 404 and VM disappearance cannot be confirmed", async () => {
    let vmLookupMode: "exists" | "fail" | "gone" = "exists";
    const pc = new PcClient(async (request: PcRequest): Promise<PcResponse> => {
      const path = request.path.split("?")[0]!;
      if (request.method === "GET" && path === "/api/prism/v4.4/config/domain-managers") {
        return { status: 200, etag: null, body: { data: [{ config: { buildInfo: { version: "pc.7.6" } } }] } };
      }
      if (request.method === "GET" && path === "/api/vmm/v4.3/ahv/config/vms/vm-del-404") {
        if (vmLookupMode === "exists") return { status: 200, etag: "e1", body: { data: { extId: "vm-del-404", name: "my-own-vps", powerState: "OFF" } } };
        if (vmLookupMode === "fail") return { status: 500, etag: null, body: { data: { error: [{ message: "VMM unreachable" }] } } };
        return { status: 404, etag: null, body: null };
      }
      if (request.method === "DELETE" && path === "/api/vmm/v4.3/ahv/config/vms/vm-del-404") {
        vmLookupMode = "fail";
        return { status: 202, etag: null, body: { data: { extId: "task-del-404" } } };
      }
      if (request.method === "GET" && path === "/api/prism/v4.4/config/tasks/task-del-404") {
        return { status: 404, etag: null, body: { data: { error: [{ message: "Task not found" }] } } };
      }
      return { status: 404, etag: null, body: null };
    }, async () => {});

    const app = await serve({}, { pcClient: () => pc });
    await app.connect();
    const vmName = "my-own-vps";
    const files = desktopFiles(app.dataDir, vmName);
    mkdirSync(join(app.dataDir, "ssh"), { recursive: true });
    writeFileSync(files.key, "fake-key");
    writeAlias(join(app.dataDir, "ssh_config"), aliasBlock(vmName, "10.0.0.20", files), vmName);
    writeNutanixState(app.dataDir, {
      ...readNutanixState(app.dataDir),
      vm: { extId: "vm-del-404", name: vmName, alias: vmName, ip: "10.0.0.20", projectExtId: null, ready: false, startedAt: Date.now() },
    });

    const del = await app.send("DELETE", "/api/nutanix/server");
    expect(del.status).toBe(409);
    expect(readNutanixState(app.dataDir).vm).toMatchObject({ extId: "vm-del-404", needsCheck: true, checkReason: "delete" });
    expect((await app.status()).server).toMatchObject({ needsCheck: true, checkReason: "delete", canClear: false });
    expect(app.defaultAlias()).toBe(vmName);
    expect(existsSync(files.key)).toBe(true);
    expect(readFileSync(join(app.dataDir, "ssh_config"), "utf8")).toContain(`Host ${vmName}`);

    // Once Prism Central confirms 404 on a later check, the user can explicitly clear everything.
    vmLookupMode = "gone";
    const checked = await app.send("POST", "/api/nutanix/check");
    expect(checked.status).toBe(200);
    expect(checked.body.check.outcome).toBe("missing");
    expect(checked.body.server.canClear).toBe(true);

    const cleared = await app.send("DELETE", "/api/nutanix/server", { confirmedChecked: true });
    expect(cleared.status).toBe(200);
    expect(readNutanixState(app.dataDir).vm).toBeUndefined();
    expect(app.defaultAlias()).toBeNull();
    expect(existsSync(files.key)).toBe(false);
    expect(readFileSync(join(app.dataDir, "ssh_config"), "utf8")).not.toContain(`Host ${vmName}`);
  });

  it("surfaces shutdownUnknown, keeps SSH gate closed on unknown power state, and resolves only via confirmed OFF or user resume after confirmed ON", async () => {
    let powerState = "UNDETERMINED";
    const app = await serve({
      vm: async () => ({ extId: "vm-1", name: "mausbot-desktops-sd", powerState, ip: "10.0.0.20", etag: "e1" }),
    });
    await app.connect();
    writeNutanixState(app.dataDir, {
      ...readNutanixState(app.dataDir),
      vm: { extId: "vm-1", name: "mausbot-desktops-sd", alias: "mausbot-desktops-sd", ip: "10.0.0.20", projectExtId: null, ready: true, shutdownUnknown: true },
    });

    expect(vpsHostHooks.shuttingDown?.("mausbot-desktops-sd")).toBe(true);
    expect((await app.status()).server).toMatchObject({ shutdownUnknown: true, canResume: false });

    // UNDETERMINED keeps gate closed and refuses resume.
    const unknownCheck = await app.send("POST", "/api/nutanix/check");
    expect(unknownCheck.status).toBe(200);
    expect(unknownCheck.body.check.outcome).toBe("unknown");
    expect(unknownCheck.body.server).toMatchObject({ shutdownUnknown: true, canResume: false });
    expect((await app.send("POST", "/api/nutanix/resume")).status).toBe(409);
    expect(vpsHostHooks.shuttingDown?.("mausbot-desktops-sd")).toBe(true);

    // ON enables explicit user resume, keeping gate closed until the user confirms.
    powerState = "ON";
    const onCheck = await app.send("POST", "/api/nutanix/check");
    expect(onCheck.status).toBe(200);
    expect(onCheck.body.check.outcome).toBe("on");
    expect(onCheck.body.server).toMatchObject({ shutdownUnknown: true, canResume: true });
    expect(vpsHostHooks.shuttingDown?.("mausbot-desktops-sd")).toBe(true);

    const resumed = await app.send("POST", "/api/nutanix/resume");
    expect(resumed.status).toBe(200);
    expect(resumed.body.server).toMatchObject({ shutdownUnknown: false, canResume: false });
    expect(vpsHostHooks.shuttingDown?.("mausbot-desktops-sd")).toBe(false);

    // Confirmed OFF clears shutdownUnknown directly on check.
    writeNutanixState(app.dataDir, {
      ...readNutanixState(app.dataDir),
      vm: { ...readNutanixState(app.dataDir).vm!, shutdownUnknown: true },
    });
    expect(vpsHostHooks.shuttingDown?.("mausbot-desktops-sd")).toBe(true);
    powerState = "OFF";
    const offCheck = await app.send("POST", "/api/nutanix/check");
    expect(offCheck.status).toBe(200);
    expect(offCheck.body.check.outcome).toBe("off");
    expect(offCheck.body.server.shutdownUnknown).toBe(false);
    expect(vpsHostHooks.shuttingDown?.("mausbot-desktops-sd")).toBe(false);
  });

  it.skipIf(process.platform === "win32")("runs deploy power-on and bootstrap, including prepareVpsSsh writes, inside the mutex so concurrent routes serialize behind them", async () => {
    const events: string[] = [];
    let releasePowerOn!: () => void;
    let powerOnEntered!: () => void;
    const powerOnStarted = new Promise<void>((resolve) => { powerOnEntered = resolve; });

    const binDir = mkdtempSync(join(tmpdir(), "omb-nutanix-ssh-bin-"));
    roots.push(binDir);
    const sshStarted = join(binDir, "ssh-started");
    const sshRelease = join(binDir, "ssh-release");
    writeFileSync(join(binDir, "ssh"), [
      "#!/bin/sh",
      `touch '${sshStarted}'`,
      `while [ ! -f '${sshRelease}' ]; do sleep 0.02; done`,
      "echo ok",
      "",
    ].join("\n"), { mode: 0o700 });

    const prevPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${prevPath ?? ""}`;
    try {
      const app = await serve(
        {
          connect: async () => {
            events.push("connect");
            return { version: "pc.7.6", projects: false };
          },
          powerOn: async () => {
            events.push("powerOn-start");
            powerOnEntered();
            await new Promise<void>((resolve) => { releasePowerOn = resolve; });
            events.push("powerOn-end");
          },
        },
        // Use the real waitForDocker -> runOnServer -> prepareVpsSsh path.
        { waitForDocker: undefined },
      );
      await app.connect();
      events.length = 0;

      expect((await app.send("POST", "/api/nutanix/deploy", deployBody)).status).toBe(202);
      await powerOnStarted;

      // Status polling still works while deploy holds the mutex for power-on and bootstrap.
      expect((await app.status()).deploy?.phase).toBe("starting");

      // A concurrent connect queues behind the mutex and does not interleave with power-on or bootstrap.
      const concurrentConnect = app.connect();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(events).toEqual(["powerOn-start"]);

      releasePowerOn();
      const waitDeadline = Date.now() + 5_000;
      while (!existsSync(sshStarted)) {
        if (Date.now() > waitDeadline) throw new Error("fake ssh never started");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }

      // prepareVpsSsh wrote the SSH config and shim inside the mutex, and connect is still blocked.
      expect(existsSync(join(app.dataDir, "ssh", "config"))).toBe(true);
      expect(existsSync(join(app.dataDir, "ssh", "bin", "ssh"))).toBe(true);
      expect((await app.status()).deploy?.phase).toBe("installing");
      expect(events).toEqual(["powerOn-start", "powerOn-end"]);

      writeFileSync(sshRelease, "go");
      const reconnected = await concurrentConnect;
      const done = await app.until((now) => now.deploy?.phase === "ready");
      expect(done.server.ready).toBe(true);
      expect(reconnected.status).toBe(200);
      expect(events).toEqual(["powerOn-start", "powerOn-end", "connect"]);
    } finally {
      process.env.PATH = prevPath;
    }
  });
});
