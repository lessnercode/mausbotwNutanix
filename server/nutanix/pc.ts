import { randomUUID } from "node:crypto";
import { Agent, request as httpRequest } from "node:http";
import { isIP } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";

import type { DesktopResources } from "../container-limits.ts";

export interface PcRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
}
export interface PcResponse {
  status: number;
  etag: string | null;
  body: unknown;
}
export type PcTransport = (request: PcRequest) => Promise<PcResponse>;

export class PcError extends Error {
  readonly status: number;
  readonly taskFailed: boolean;
  readonly unconfirmed: boolean;
  readonly beforeAccept: boolean;
  constructor(status: number, message: string, options?: { taskFailed?: boolean; unconfirmed?: boolean; beforeAccept?: boolean }) {
    super(message);
    this.status = status;
    this.taskFailed = options?.taskFailed === true;
    this.unconfirmed = options?.unconfirmed === true;
    this.beforeAccept = options?.beforeAccept === true;
  }
}

/** The PC presented a certificate that is neither publicly valid nor the one pinned at connect. */
export class PcCertificateError extends Error {
  readonly fingerprint: string;
  constructor(fingerprint: string) { super("Prism Central's certificate changed since you connected"); this.fingerprint = fingerprint; }
}

const REQUEST_TIMEOUT_MS = 30_000;

/** `https://host:9440` from what the person typed: a bare host, an IP or a URL. */
export function pcBaseUrl(address: string): URL {
  const trimmed = address.trim();
  const url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  if (url.protocol !== "https:") throw new Error("Prism Central is reached over https");
  if (!url.port) url.port = "9440";
  return new URL(`${url.protocol}//${url.host}`);
}

/** Where a person signs in to Prism Central in a browser. The address is the one they connected with, so it is never
 * guessed. A deep link to one VM's console is not used: that page's address is not documented for v4, so it is left out. */
export function prismConsoleUrl(address: string): string {
  return pcBaseUrl(address).href;
}

/** Security: Basic auth is written only after the TLS handshake shows a publicly valid certificate or the pinned one. */
function pinnedSocket(base: URL, pin: string | null, timeoutMs = REQUEST_TIMEOUT_MS): Promise<{ socket: TLSSocket; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const limit = Math.min(REQUEST_TIMEOUT_MS, timeoutMs);
    if (limit <= 0) { reject(new PcError(504, "Prism Central did not answer in time")); return; }
    const host = base.hostname.replace(/^\[|\]$/g, "");
    const socket = tlsConnect({ host, port: Number(base.port), servername: isIP(host) ? undefined : host, rejectUnauthorized: false });
    socket.setTimeout(limit, () => socket.destroy(new PcError(504, "Prism Central did not answer in time")));
    socket.once("error", reject);
    socket.once("secureConnect", () => {
      const fingerprint = socket.getPeerCertificate().fingerprint256 ?? "";
      if (socket.authorized || (pin !== null && fingerprint === pin)) {
        socket.setTimeout(0);
        socket.removeListener("error", reject);
        resolve({ socket, fingerprint });
        return;
      }
      socket.destroy();
      reject(new PcCertificateError(fingerprint));
    });
  });
}

/** Reads the PC's certificate fingerprint without sending anything, for the trust-on-first-use pin. */
export async function pcCertificateFingerprint(base: URL): Promise<string> {
  try {
    const { socket, fingerprint } = await pinnedSocket(base, null);
    socket.destroy();
    return fingerprint;
  } catch (error) {
    if (error instanceof PcCertificateError) return error.fingerprint;
    throw error;
  }
}

export function httpsTransport(options: { base: URL; username: string; password: string; pin: string | null }): PcTransport {
  const auth = `Basic ${Buffer.from(`${options.username}:${options.password}`).toString("base64")}`;
  return async ({ method, path, body, headers, timeoutMs }) => {
    const deadline = timeoutMs === undefined ? null : Date.now() + timeoutMs;
    const handshakeTimeout = deadline === null ? REQUEST_TIMEOUT_MS : deadline - Date.now();
    const { socket } = await pinnedSocket(options.base, options.pin, handshakeTimeout);
    const requestTimeout = deadline === null ? REQUEST_TIMEOUT_MS : Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now());
    if (requestTimeout <= 0) {
      socket.destroy();
      throw new PcError(504, "Prism Central did not answer in time");
    }
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return await new Promise<PcResponse>((resolve, reject) => {
      // Node 24: `agent: false` builds a fresh Agent that ignores a `createConnection` option, so the pinned socket goes through an Agent of its own.
      const agent = new Agent({ keepAlive: false });
      agent.createConnection = () => socket;
      const req = httpRequest({
        host: options.base.hostname, port: Number(options.base.port), method, path, agent,
        headers: {
          accept: "application/json", authorization: auth, ...headers,
          ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }),
        },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let parsed: unknown = null;
          try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
          const etag = res.headers.etag;
          resolve({ status: res.statusCode ?? 0, etag: typeof etag === "string" ? etag : null, body: parsed });
        });
        res.on("error", reject);
      });
      req.setTimeout(requestTimeout, () => req.destroy(new PcError(504, "Prism Central did not answer in time")));
      req.on("error", reject);
      req.end(payload);
    });
  };
}

// Newest first. PC builds serve different generations of each namespace, so the first one that does not 404 is kept.
const VERSIONS = {
  vmm: ["v4.3", "v4.1", "v4.0"],
  networking: ["v4.2", "v4.0"],
  // Tasks: prism v4.4's "View Task" includes Project Admin; v4.0's does not (developers.nutanix.com prism spec).
  prism: ["v4.4", "v4.0"],
  // Projects exist only under multidomain v4.4.b1 in the published specs; a GA pc.7.6 may serve v4.4.
  multidomain: ["v4.4", "v4.4.b1"],
} as const;
type Namespace = keyof typeof VERSIONS;

type Json = Record<string, any>;

function errorText(body: unknown): string | null {
  const data = (body as Json | null)?.data ?? body;
  const list = (data as Json | null)?.error;
  const first = Array.isArray(list) ? list[0] : null;
  return typeof first?.message === "string" ? first.message : null;
}

/** "pc.7.6", "7.6.0.1": true from 7.6. Year-numbered builds (pc.2024.3) came before 7.x. */
export function pcSupportsProjects(version: string): boolean {
  const match = /(\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major >= 2000) return false;
  return major > 7 || (major === 7 && minor >= 6);
}

/** Task ids look like `<base64>:<uuid>`. */
function idSegment(id: string): string {
  return encodeURIComponent(id);
}

export interface PcProject { extId: string; name: string; isDefault: boolean }
export interface PcVm { extId: string; name: string; powerState: string; ip: string | null; etag: string | null }
export type VmSpec = {
  name: string;
  clusterExtId: string;
  subnetExtId: string;
  projectExtId: string | null;
  userData: string;
} & ({ kind: "image"; imageExtId: string; vcpus: number; memoryGb: number; diskGb: number } | { kind: "template"; templateExtId: string });

const GIB = 1024 ** 3;
const VM_REL = "vmm:ahv:config:vm";
const TASK_POLL_MS = 3_000;

export class PcClient {
  private readonly chosen = new Map<Namespace, string>();
  private readonly transport: PcTransport;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(transport: PcTransport, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))) {
    this.transport = transport;
    this.sleep = sleep;
  }

  private async call(namespace: Namespace, rest: string, init: Omit<PcRequest, "path"> = { method: "GET" }, deadline?: number): Promise<PcResponse> {
    const known = this.chosen.get(namespace);
    for (const version of known ? [known] : VERSIONS[namespace]) {
      let timeoutMs = init.timeoutMs;
      if (deadline !== undefined) {
        const left = deadline - Date.now();
        if (left <= 0) throw new PcError(504, "Prism Central did not answer in time");
        timeoutMs = timeoutMs === undefined ? left : Math.min(timeoutMs, left);
      }
      const headers = init.method === "GET" ? init.headers : { "NTNX-Request-Id": randomUUID(), ...init.headers };
      const response = await this.transport({ ...init, ...(timeoutMs === undefined ? {} : { timeoutMs }), headers, path: `/api/${namespace}/${version}${rest}` });
      if (response.status === 404 && !known) continue;
      this.chosen.set(namespace, version);
      if (response.status >= 400) throw new PcError(response.status, errorText(response.body) ?? `Prism Central answered ${response.status}`);
      return response;
    }
    throw new PcError(404, `This Prism Central does not serve the ${namespace} API`);
  }

  private async listAll(namespace: Namespace, rest: string): Promise<Json[]> {
    const items: Json[] = [];
    const joiner = rest.includes("?") ? "&" : "?";
    for (let page = 0; ; page++) {
      const { body } = await this.call(namespace, `${rest}${joiner}$page=${page}&$limit=100`);
      const data = (body as Json | null)?.data;
      const batch = Array.isArray(data) ? data as Json[] : [];
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  /** The PC's version string, or null when this account may not read it (View Domain Manager is an admin or viewer role). */
  async version(): Promise<string | null> {
    try {
      const { body } = await this.call("prism", "/config/domain-managers");
      const version = (body as Json | null)?.data?.[0]?.config?.buildInfo?.version;
      return typeof version === "string" ? version : null;
    } catch (error) {
      if (error instanceof PcError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
  }

  /** Whether Projects 2.0 applies: from the version when readable, else whether the projects API exists. A 403 means it exists. */
  async connect(): Promise<{ version: string | null; projects: boolean }> {
    const version = await this.version();
    if (version !== null) return { version, projects: pcSupportsProjects(version) };
    try {
      await this.call("multidomain", "/config/projects?$limit=1");
      return { version, projects: true };
    } catch (error) {
      if (error instanceof PcError && error.status === 403) return { version, projects: true };
      if (error instanceof PcError && error.status === 404) return { version, projects: false };
      throw error;
    }
  }

  async projects(): Promise<PcProject[]> {
    const items = await this.listAll("multidomain", "/config/projects");
    return items.filter((item) => item.state !== "DELETING" && typeof item.extId === "string")
      .map((item) => ({ extId: item.extId, name: String(item.name ?? item.extId), isDefault: item.isDefault === true }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async images(): Promise<Json[]> {
    return await this.listAll("vmm", "/content/images");
  }

  /**
   * Templates need Project Admin, Project Manager or an admin role to see, and older VMM generations do not serve them:
   * either way the list is images only. Call after `images()`, so the VMM generation is chosen by an endpoint every PC has.
   */
  async templates(projectExtId: string | null): Promise<Json[]> {
    const filter = projectExtId === null ? "" : `?$filter=${encodeURIComponent(`projectExtId eq '${projectExtId.replace(/'/g, "''")}'`)}`;
    try { return await this.listAll("vmm", `/content/templates${filter}`); }
    catch (error) {
      if (error instanceof PcError && (error.status === 403 || error.status === 404)) return [];
      throw error;
    }
  }

  /** The list does not promise `ipUsage`, so a Nutanix-managed subnet without it is read again on its own. */
  async subnets(): Promise<Json[]> {
    const items = await this.listAll("networking", "/config/subnets");
    return await Promise.all(items.map(async (subnet) => {
      if (subnet.ipUsage || !ipamManaged(subnet) || typeof subnet.extId !== "string") return subnet;
      const { body } = await this.call("networking", `/config/subnets/${idSegment(subnet.extId)}`);
      return { ...subnet, ...(body as Json | null)?.data };
    }));
  }

  async vm(extId: string, timeoutMs?: number): Promise<PcVm> {
    const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
    const response = await this.call("vmm", `/ahv/config/vms/${idSegment(extId)}`, { method: "GET" }, deadline);
    return vmFrom((response.body as Json | null)?.data ?? {}, response.etag);
  }

  private async vmsNamed(name: string): Promise<PcVm[]> {
    const items = await this.listAll("vmm", `/ahv/config/vms?$filter=${encodeURIComponent(`name eq '${name.replace(/'/g, "''")}'`)}`);
    return items.map((item) => vmFrom(item, null));
  }

  /** The id of the one VM with this name, or null when there is none. */
  async vmIdNamed(name: string): Promise<string | null> {
    const found = await this.vmsNamed(name);
    if (found.length > 1) throw new PcError(409, `More than one VM is named ${name}`);
    return found[0]?.extId ?? null;
  }

  async taskState(taskExtId: string, vmName?: string): Promise<{ state: "running" | "succeeded" | "failed" | "unreadable"; vmExtId: string | null }> {
    let task: Json;
    try { task = (await this.call("prism", `/config/tasks/${idSegment(taskExtId)}`)).body as Json; }
    catch (error) {
      if (error instanceof PcError && (error.status === 403 || error.status === 404)) return { state: "unreadable", vmExtId: null };
      throw error;
    }
    const data = task?.data ?? {};
    if (data.status === "SUCCEEDED") return { state: "succeeded", vmExtId: taskVmId(data, vmName) };
    if (data.status === "FAILED" || data.status === "CANCELED") return { state: "failed", vmExtId: null };
    return { state: "running", vmExtId: null };
  }

  private async waitTaskUntil(taskExtId: string, deadline: number): Promise<Json | null> {
    for (;;) {
      if (deadline - Date.now() <= 0) throw new PcError(504, "Prism Central's task did not finish in time");
      let task: Json;
      try { task = (await this.call("prism", `/config/tasks/${idSegment(taskExtId)}`, { method: "GET" }, deadline)).body as Json; }
      catch (error) {
        if (error instanceof PcError && (error.status === 403 || error.status === 404)) return null;
        throw error;
      }
      const data = task?.data ?? {};
      if (data.status === "SUCCEEDED") return data;
      if (data.status === "FAILED" || data.status === "CANCELED") {
        const messages = Array.isArray(data.errorMessages) ? data.errorMessages.map((one: Json) => one?.message).filter(Boolean) : [];
        throw new PcError(500, messages.join("; ") || data.legacyErrorMessage || "Prism Central could not finish the task", { taskFailed: true });
      }
      const wait = Math.min(TASK_POLL_MS, deadline - Date.now());
      if (wait <= 0) throw new PcError(504, "Prism Central's task did not finish in time");
      await this.sleep(wait);
    }
  }

  /** Waits for a task to finish. A role that may not read tasks gets null, and the caller looks for the VM by name. */
  async waitTask(taskExtId: string, timeoutMs: number): Promise<Json | null> {
    return await this.waitTaskUntil(taskExtId, Date.now() + timeoutMs);
  }

  /** Creates or deploys the VM, waits for it, and returns its id. */
  async createVm(spec: VmSpec, timeoutMs = 15 * 60_000, onTask?: (taskExtId: string) => void): Promise<string> {
    const nics = [{
      nicBackingInfo: { $objectType: "vmm.v4.ahv.config.VirtualEthernetNic", model: "VIRTIO", isConnected: true },
      nicNetworkInfo: { $objectType: "vmm.v4.ahv.config.VirtualEthernetNicNetworkInfo", nicType: "NORMAL_NIC", subnet: { extId: spec.subnetExtId } },
    }];
    const guestCustomization = { config: {
      $objectType: "vmm.v4.ahv.config.CloudInit", datasourceType: "CONFIG_DRIVE_V2",
      cloudInitScript: { $objectType: "vmm.v4.ahv.config.Userdata", value: Buffer.from(spec.userData, "utf8").toString("base64") },
    } };
    const response = spec.kind === "image"
      ? await this.call("vmm", "/ahv/config/vms", { method: "POST", body: {
        name: spec.name,
        numSockets: spec.vcpus, numCoresPerSocket: 1, memorySizeBytes: spec.memoryGb * GIB,
        cluster: { extId: spec.clusterExtId },
        ...(spec.projectExtId ? { projectExtId: spec.projectExtId } : {}),
        disks: [{
          diskAddress: { busType: "SCSI", index: 0 },
          backingInfo: {
            $objectType: "vmm.v4.ahv.config.VmDisk", diskSizeBytes: spec.diskGb * GIB,
            dataSource: { reference: { $objectType: "vmm.v4.ahv.config.ImageReference", imageExtId: spec.imageExtId } },
          },
        }],
        nics, guestCustomization,
      } })
      // Template deploy: clusterReference is a bare UUID, sizes and disks stay the template's, the project is inherited (vmm v4.3).
      : await this.call("vmm", `/content/templates/${idSegment(spec.templateExtId)}/$actions/deploy`, { method: "POST", body: {
        numberOfVms: 1, clusterReference: spec.clusterExtId,
        overrideVmConfigMap: { 0: { name: spec.name, nics, guestCustomization } },
      } });
    const taskExtId = (response.body as Json | null)?.data?.extId;
    if (typeof taskExtId !== "string") throw new PcError(500, "Prism Central did not return a task for the new server");
    onTask?.(taskExtId);
    const task = await this.waitTask(taskExtId, timeoutMs);
    const fromTask = task ? taskVmId(task, spec.name) : null;
    if (fromTask) return fromTask;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = await this.vmIdNamed(spec.name);
      if (found) return found;
      const wait = Math.min(TASK_POLL_MS, deadline - Date.now());
      if (wait <= 0) throw new PcError(504, "The new server did not appear in Prism Central in time");
      await this.sleep(wait);
    }
  }

  // The v4.3 spec lists no If-Match on these actions; earlier generations asked for one, so it is sent when the GET gave an ETag.
  private async vmAction(current: PcVm, action: "power-on", deadline?: number): Promise<void> {
    const response = await this.call(
      "vmm",
      `/ahv/config/vms/${idSegment(current.extId)}/$actions/${action}`,
      { method: "POST", headers: current.etag ? { "If-Match": current.etag } : {} },
      deadline,
    );
    const taskExtId = (response.body as Json | null)?.data?.extId;
    if (typeof taskExtId === "string") await this.waitTaskUntil(taskExtId, deadline ?? Date.now() + 5 * 60_000);
  }

  async powerOn(extId: string, timeoutMs = 5 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    const current = await this.vm(extId, deadline - Date.now());
    if (current.powerState !== "ON") await this.vmAction({ ...current, extId }, "power-on", deadline);
  }

  /** ACPI shutdown: `power-off` is the pulled-plug stop, which can leave Docker's state half-written. Waits until Prism Central reports the VM OFF or the shutdown task fails. */
  async shutdown(extId: string, timeoutMs = 5 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let current: PcVm;
    try { current = await this.vm(extId, deadline - Date.now()); }
    catch (error) {
      const status = error instanceof PcError ? error.status : 502;
      const message = error instanceof Error ? error.message : String(error);
      throw new PcError(status, message, { beforeAccept: true });
    }
    if (current.powerState === "OFF") return;
    if (current.powerState !== "ON") {
      throw new PcError(502, `Prism Central reported an unknown power state (${current.powerState}) for the Nutanix desktop server`, { unconfirmed: true });
    }
    let response: PcResponse;
    try {
      response = await this.call(
        "vmm",
        `/ahv/config/vms/${idSegment(extId)}/$actions/shutdown`,
        { method: "POST", headers: current.etag ? { "If-Match": current.etag } : {} },
        deadline,
      );
    } catch (error) {
      if (error instanceof PcError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429) {
        throw new PcError(error.status, error.message, { beforeAccept: true });
      }
      throw error;
    }
    const taskExtId = (response.body as Json | null)?.data?.extId;
    try {
      if (typeof taskExtId === "string") await this.waitTaskUntil(taskExtId, deadline);
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) throw new PcError(504, "The Nutanix desktop server did not power off in time", { unconfirmed: true });
        let latest: PcVm;
        try { latest = await this.vm(extId, left); }
        catch (error) {
          if (error instanceof PcError && error.status === 404) return;
          throw error;
        }
        if (latest.powerState === "OFF") return;
        if (latest.powerState !== "ON") {
          throw new PcError(502, `Prism Central reported an unknown power state (${latest.powerState}) for the Nutanix desktop server`, { unconfirmed: true });
        }
        const wait = Math.min(TASK_POLL_MS, deadline - Date.now());
        if (wait <= 0) throw new PcError(504, "The Nutanix desktop server did not power off in time", { unconfirmed: true });
        await this.sleep(wait);
      }
    } catch (error) {
      if (error instanceof PcError && (error.taskFailed || error.unconfirmed)) throw error;
      if (error instanceof PcCertificateError) throw error;
      const status = error instanceof PcError ? error.status : 502;
      const message = error instanceof Error ? error.message : String(error);
      throw new PcError(status, message, { unconfirmed: true });
    }
  }

  async deleteVm(extId: string, timeoutMs = 10 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let current: PcVm;
    try { current = await this.vm(extId, deadline - Date.now()); }
    catch (error) {
      if (error instanceof PcError && error.status === 404) return;
      throw error;
    }
    const response = await this.call(
      "vmm",
      `/ahv/config/vms/${idSegment(extId)}`,
      { method: "DELETE", headers: current.etag ? { "If-Match": current.etag } : {} },
      deadline,
    );
    const taskExtId = (response.body as Json | null)?.data?.extId;
    try {
      if (typeof taskExtId === "string") await this.waitTaskUntil(taskExtId, deadline);
      for (;;) {
        const left = deadline - Date.now();
        if (left <= 0) throw new PcError(504, "Could not confirm that the Nutanix desktop server was deleted in Prism Central", { unconfirmed: true });
        try { await this.vm(extId, left); }
        catch (error) {
          if (error instanceof PcError && error.status === 404) return;
          throw error;
        }
        const wait = Math.min(TASK_POLL_MS, deadline - Date.now());
        if (wait <= 0) throw new PcError(504, "Could not confirm that the Nutanix desktop server was deleted in Prism Central", { unconfirmed: true });
        await this.sleep(wait);
      }
    } catch (error) {
      if (error instanceof PcError && (error.taskFailed || error.unconfirmed)) throw error;
      if (error instanceof PcCertificateError) throw error;
      const status = error instanceof PcError ? error.status : 502;
      const message = error instanceof Error ? error.message : String(error);
      throw new PcError(status, message, { unconfirmed: true });
    }
  }
}

/**
 * The address IPAM assigned (`ipv4Config.ipAddress`), else the one the guest reported (`ipv4Info.learnedIpAddresses`).
 * Security: only an IPv4 literal, because it is written into ~/.ssh/config.
 */
export function vmAddress(vm: Json): string | null {
  for (const nic of Array.isArray(vm.nics) ? vm.nics as Json[] : []) {
    const info = nic.nicNetworkInfo ?? nic.networkInfo ?? {};
    for (const candidate of [info.ipv4Config?.ipAddress?.value, info.ipv4Info?.learnedIpAddresses?.[0]?.value]) {
      if (typeof candidate === "string" && isIP(candidate) === 4) return candidate;
    }
  }
  return null;
}

function taskVmId(data: Json, vmName?: string): string | null {
  const affected = Array.isArray(data?.entitiesAffected) ? data.entitiesAffected as Json[] : [];
  const found = affected.find((entity) => entity.rel === VM_REL && (!vmName || !entity.name || entity.name === vmName))?.extId;
  return typeof found === "string" ? found : null;
}

function vmFrom(item: Json, etag: string | null): PcVm {
  return { extId: String(item.extId ?? ""), name: String(item.name ?? ""), powerState: String(item.powerState ?? "UNDETERMINED"), ip: vmAddress(item), etag };
}

function ipamManaged(subnet: Json): boolean {
  return (Array.isArray(subnet.ipConfig) ? subnet.ipConfig as Json[] : []).some((config) => (config.ipv4?.poolList?.length ?? 0) > 0);
}

function freeAddresses(subnet: Json): number | null {
  const usage = subnet.ipUsage;
  if (typeof usage?.numFreeIPs === "number") return usage.numFreeIPs;
  const pools = Array.isArray(usage?.ipPoolUsages) ? usage.ipPoolUsages as Json[] : [];
  const counts = pools.map((pool) => pool.numFreeIPs).filter((count): count is number => typeof count === "number");
  return counts.length ? counts.reduce((sum, count) => sum + count, 0) : null;
}

export interface SubnetChoice { extId: string; name: string; clusterExtId: string; clusterName: string | null; free: number }

/**
 * Subnets a desktop server may use: Nutanix hands out the address (IPAM pool), at least one is free, and the subnet names
 * its cluster. With a project, only that project's subnets. A subnet whose free count is not reported is left out.
 */
export function usableSubnets(subnets: readonly Json[], projectExtId: string | null): SubnetChoice[] {
  const choices: SubnetChoice[] = [];
  for (const subnet of subnets) {
    if (typeof subnet.extId !== "string" || subnet.isExternal === true || !ipamManaged(subnet)) continue;
    const clusterExtId = subnet.clusterReference ?? subnet.clusterReferenceList?.[0];
    if (typeof clusterExtId !== "string") continue;
    const free = freeAddresses(subnet);
    if (free === null || free < 1) continue;
    if (projectExtId !== null && subnet.metadata?.projectReferenceId !== projectExtId) continue;
    choices.push({ extId: subnet.extId, name: String(subnet.name ?? subnet.extId), clusterExtId, clusterName: subnet.clusterName ?? subnet.clusterNameList?.[0] ?? null, free });
  }
  return choices.sort((a, b) => a.name.localeCompare(b.name));
}

export type SourceChoice =
  | { kind: "template"; extId: string; name: string; vcpus: number | null; memoryGb: number | null; canInjectKey: boolean }
  | { kind: "image"; extId: string; name: string };

const WINDOWS_NAME = /(?<![a-z0-9])win(?:dows|\d+)?(?![a-z0-9])/i;
const WINDOWS_META = /sysprep|mswin|windows|(?<![a-z0-9])win\d*(?![a-z0-9])/i;

function osMetadata(item: Json): unknown[] {
  const spec = item.templateVersionSpec ?? {};
  const vm = spec.vmSpec ?? {};
  const categories = [...(Array.isArray(item.categories) ? item.categories : []), ...(Array.isArray(vm.categories) ? vm.categories : [])];
  const categoryLabels = categories.flatMap((entry: Json) => [entry?.key, entry?.value, entry?.name]);
  return [
    vm.guestCustomization?.config?.$objectType,
    item.osType, item.guestOs, item.guestOsName, item.operatingSystem,
    spec.osType, spec.guestOs, spec.guestOsName, spec.operatingSystem,
    vm.osType, vm.guestOs, vm.guestOsName, vm.operatingSystem,
    vm.guestInfo?.guestOsName, vm.guestInfo?.osType,
    vm.guestTools?.guestOsVersion, vm.guestTools?.guestOsType, vm.guestTools?.guestOs,
    ...categoryLabels,
  ];
}

/** Prism v4 does not guarantee a dedicated OS field on every image, so Windows is excluded by OS/guest metadata when present and by name/description as fallback (unverified heuristic). */
function looksWindows(item: Json, name: unknown): boolean {
  if (osMetadata(item).some((value) => typeof value === "string" && WINDOWS_META.test(value))) return true;
  return [name, item.description, item.templateVersionSpec?.versionDescription].some((text) => typeof text === "string" && WINDOWS_NAME.test(text));
}

/**
 * Templates first, then disk images, each by name; Windows is left out. A deployed template keeps its own project, so with
 * a project only that project's templates. A template without explicit guest-customization override permission cannot take the SSH key.
 */
export function sourceChoices(images: readonly Json[], templates: readonly Json[], projectExtId: string | null): SourceChoice[] {
  const imageInProject = (item: Json) => projectExtId === null || !item.projectExtId || item.projectExtId === projectExtId || item.isSharedWithAllProjects === true;
  const templateInProject = (item: Json) => projectExtId === null || item.projectExtId === projectExtId;
  const fromTemplates: SourceChoice[] = templates.filter((item) => typeof item.extId === "string" && templateInProject(item) && !looksWindows(item, item.templateName)).map((item) => {
    const spec = item.templateVersionSpec ?? {};
    const vm = spec.vmSpec ?? {};
    const vcpus = typeof vm.numSockets === "number" ? vm.numSockets * (vm.numCoresPerSocket ?? 1) * (vm.numThreadsPerCore ?? 1) : null;
    return { kind: "template" as const, extId: item.extId, name: String(item.templateName ?? item.extId),
      vcpus, memoryGb: typeof vm.memorySizeBytes === "number" ? Math.round(vm.memorySizeBytes / GIB) : null,
      canInjectKey: spec.isGcOverrideEnabled === true };
  });
  const fromImages: SourceChoice[] = images.filter((item) => typeof item.extId === "string" && item.type === "DISK_IMAGE" && imageInProject(item) && !looksWindows(item, item.name))
    .map((item) => ({ kind: "image" as const, extId: item.extId, name: String(item.name ?? item.extId) }));
  const byName = (a: SourceChoice, b: SourceChoice) => a.name.localeCompare(b.name);
  return [...fromTemplates.sort(byName), ...fromImages.sort(byName)];
}

/**
 * An image-based server sized from MausBot's own desktop options: `desktops` (the Max desktops setting, 1 to 8) times each
 * desktop's CPUs and memory, plus 2 GB for the host. No option sets disk, so it is 60 GB plus 20 GB per desktop.
 */
export function serverShape(desktops: number, perDesktop: DesktopResources): { desktops: number; vcpus: number; memoryGb: number; diskGb: number } {
  return { desktops, vcpus: desktops * perDesktop.cpus, memoryGb: desktops * perDesktop.memoryGb + 2, diskGb: 60 + desktops * 20 };
}
