import { describe, expect, it, vi } from "vitest";
import { PcClient, PcError, pcBaseUrl, pcSupportsProjects, prismConsoleUrl, serverShape, sourceChoices, usableSubnets, vmAddress, type PcRequest, type PcResponse } from "./pc.ts";

type Handler = (request: PcRequest) => PcResponse | undefined;

/** A fake Prism Central: each route is `METHOD /api/...` without the query; anything unrouted answers 404. */
function fakePc(routes: Record<string, unknown | Handler>) {
  const calls: PcRequest[] = [];
  const transport = async (request: PcRequest): Promise<PcResponse> => {
    calls.push(request);
    const route = routes[`${request.method} ${request.path.split("?")[0]}`];
    if (route === undefined) return { status: 404, etag: null, body: null };
    if (typeof route === "function") return (route as Handler)(request) ?? { status: 404, etag: null, body: null };
    return { status: 200, etag: null, body: route };
  };
  return { client: new PcClient(transport, async () => {}), calls };
}

const status = (code: number, message = "denied"): Handler => () => ({ status: code, etag: null, body: { data: { error: [{ message }] } } });

describe("Prism Central version and project path", () => {
  it("reads pc.7.6 from the domain manager and takes the project path", async () => {
    const { client } = fakePc({ "GET /api/prism/v4.4/config/domain-managers": { data: [{ config: { buildInfo: { version: "pc.7.6" } } }] } });
    expect(await client.connect()).toEqual({ version: "pc.7.6", projects: true });
  });

  it("takes the non-project path below 7.6, including year-numbered builds", async () => {
    const { client } = fakePc({ "GET /api/prism/v4.0/config/domain-managers": { data: [{ config: { buildInfo: { version: "pc.2024.3" } } }] } });
    expect(await client.connect()).toEqual({ version: "pc.2024.3", projects: false });
    expect(pcSupportsProjects("7.5.1")).toBe(false);
    expect(pcSupportsProjects("pc.7.6.0.2")).toBe(true);
    expect(pcSupportsProjects("8.0")).toBe(true);
    expect(pcSupportsProjects("unknown")).toBe(false);
  });

  it("without permission to read the version, probes the projects API instead", async () => {
    const withProjects = fakePc({
      "GET /api/prism/v4.4/config/domain-managers": status(403),
      "GET /api/multidomain/v4.4.b1/config/projects": { data: [] },
    });
    expect(await withProjects.client.connect()).toEqual({ version: null, projects: true });
    const without = fakePc({ "GET /api/prism/v4.4/config/domain-managers": status(403) });
    expect(await without.client.connect()).toEqual({ version: null, projects: false });
  });

  it("a projects API that refuses this account still exists, so the PC is not taken for one older than 7.6", async () => {
    const { client } = fakePc({
      "GET /api/prism/v4.4/config/domain-managers": status(403),
      "GET /api/multidomain/v4.4/config/projects": status(403),
    });
    expect(await client.connect()).toEqual({ version: null, projects: true });
  });

  it("a wrong password is a 401, not a missing version", async () => {
    const { client } = fakePc({ "GET /api/prism/v4.4/config/domain-managers": status(401, "Authentication required") });
    await expect(client.connect()).rejects.toMatchObject({ status: 401 });
  });

  it("lists active projects by name across pages", async () => {
    const page = (start: number, count: number) => Array.from({ length: count }, (_, i) => ({ extId: `p${start + i}`, name: `Project ${String(start + i).padStart(3, "0")}` }));
    const { client, calls } = fakePc({
      "GET /api/multidomain/v4.4/config/projects": (request: PcRequest) => {
        const pageNumber = Number(new URLSearchParams(request.path.split("?")[1]).get("$page"));
        const data = pageNumber === 0 ? page(0, 100) : [...page(100, 2), { extId: "gone", name: "Gone", state: "DELETING" }];
        return { status: 200, etag: null, body: { data } };
      },
    });
    const projects = await client.projects();
    expect(projects).toHaveLength(102);
    expect(projects[0]).toEqual({ extId: "p0", name: "Project 000", isDefault: false });
    expect(calls.map((call) => call.path)).toEqual([
      "/api/multidomain/v4.4/config/projects?$page=0&$limit=100",
      "/api/multidomain/v4.4/config/projects?$page=1&$limit=100",
    ]);
  });
});

describe("API generations", () => {
  it("falls back to an older generation once, then keeps it", async () => {
    const { client, calls } = fakePc({ "GET /api/vmm/v4.0/content/images": { data: [{ extId: "i1", name: "Ubuntu", type: "DISK_IMAGE" }] } });
    await client.images();
    await client.images();
    expect(calls.map((call) => call.path.split("?")[0])).toEqual([
      "/api/vmm/v4.3/content/images", "/api/vmm/v4.1/content/images", "/api/vmm/v4.0/content/images", "/api/vmm/v4.0/content/images",
    ]);
  });

  it("templates the account may not see leave images only", async () => {
    const { client } = fakePc({ "GET /api/vmm/v4.3/content/templates": status(403) });
    expect(await client.templates(null)).toEqual([]);
  });

  it("an older VMM generation without templates still lists its images", async () => {
    const { client } = fakePc({ "GET /api/vmm/v4.1/content/images": { data: [{ extId: "i1", name: "Ubuntu", type: "DISK_IMAGE" }] } });
    expect(await client.images()).toHaveLength(1);
    expect(await client.templates(null)).toEqual([]);
  });

  it("asks for the chosen project's templates", async () => {
    const { client, calls } = fakePc({ "GET /api/vmm/v4.3/content/templates": { data: [] } });
    await client.templates("proj-a");
    expect(decodeURIComponent(calls[0]!.path)).toContain("$filter=projectExtId eq 'proj-a'");
  });
});

describe("subnets offered for a desktop server", () => {
  const pool = [{ ipv4: { ipSubnet: { ip: { value: "10.0.0.0" }, prefixLength: 24 }, poolList: [{ startIp: { value: "10.0.0.10" }, endIp: { value: "10.0.0.200" } }] } }];
  const subnets = [
    { extId: "s-ok", name: "Lab", clusterReference: "c1", clusterName: "Cluster 1", ipConfig: pool, ipUsage: { numFreeIPs: 12 }, metadata: { projectReferenceId: "proj-a" } },
    { extId: "s-full", name: "Full", clusterReference: "c1", ipConfig: pool, ipUsage: { numFreeIPs: 0 }, metadata: { projectReferenceId: "proj-a" } },
    { extId: "s-dhcp", name: "Outside DHCP", clusterReference: "c1", ipConfig: [], ipUsage: { numFreeIPs: 50 } },
    { extId: "s-external", name: "External", clusterReference: "c1", isExternal: true, ipConfig: pool, ipUsage: { numFreeIPs: 5 } },
    { extId: "s-overlay", name: "VPC subnet", subnetType: "OVERLAY", ipConfig: pool, ipUsage: { numFreeIPs: 5 } },
    { extId: "s-unknown", name: "No usage", clusterReference: "c1", ipConfig: pool },
    { extId: "s-pools", name: "Pools", clusterReferenceList: ["c2"], ipConfig: pool, ipUsage: { ipPoolUsages: [{ numFreeIPs: 2 }, { numFreeIPs: 3 }] }, metadata: { projectReferenceId: "proj-b" } },
  ];

  it("without projects: Nutanix-managed, has free addresses, names its cluster", () => {
    expect(usableSubnets(subnets, null)).toEqual([
      { extId: "s-ok", name: "Lab", clusterExtId: "c1", clusterName: "Cluster 1", free: 12 },
      { extId: "s-pools", name: "Pools", clusterExtId: "c2", clusterName: null, free: 5 },
    ]);
  });

  it("with a project: only that project's subnets", () => {
    expect(usableSubnets(subnets, "proj-a").map((one) => one.extId)).toEqual(["s-ok"]);
    expect(usableSubnets(subnets, "proj-b").map((one) => one.extId)).toEqual(["s-pools"]);
    expect(usableSubnets(subnets, "proj-c")).toEqual([]);
  });

  it("reads a managed subnet on its own when the list leaves out its usage", async () => {
    const { client, calls } = fakePc({
      "GET /api/networking/v4.2/config/subnets": { data: [{ extId: "s1", name: "Lab", clusterReference: "c1", ipConfig: pool }, { extId: "s2", name: "Plain", clusterReference: "c1" }] },
      "GET /api/networking/v4.2/config/subnets/s1": { data: { extId: "s1", ipUsage: { numFreeIPs: 4 } } },
    });
    const listed = await client.subnets();
    expect(usableSubnets(listed, null).map((one) => [one.extId, one.free])).toEqual([["s1", 4]]);
    expect(calls.filter((call) => call.path.startsWith("/api/networking/v4.2/config/subnets/"))).toHaveLength(1);
  });
});

describe("images and templates", () => {
  const templates = [
    { extId: "t-docker", templateName: "Ubuntu with Docker", projectExtId: "proj-a", templateVersionSpec: { isGcOverrideEnabled: true, vmSpec: { numSockets: 2, numCoresPerSocket: 2, memorySizeBytes: 16 * 1024 ** 3 } } },
    { extId: "t-locked", templateName: "Appliance", projectExtId: "proj-a", templateVersionSpec: { isGcOverrideEnabled: false, vmSpec: { numSockets: 1 } } },
    { extId: "t-other", templateName: "Other project", projectExtId: "proj-b" },
    { extId: "t-shared", templateName: "Shared", isSharedWithAllProjects: true },
    { extId: "t-sysprep", templateName: "Desktop", projectExtId: "proj-a", templateVersionSpec: { vmSpec: { guestCustomization: { config: { $objectType: "vmm.v4.ahv.config.Sysprep" } } } } },
    { extId: "t-win", templateName: "Windows Server 2022", projectExtId: "proj-a" },
  ];
  const images = [
    { extId: "i-ubuntu", name: "Ubuntu 24.04", type: "DISK_IMAGE", projectExtId: "proj-a" },
    { extId: "i-alma", name: "AlmaLinux 9", type: "DISK_IMAGE", isSharedWithAllProjects: true, projectExtId: "proj-z" },
    { extId: "i-iso", name: "Installer", type: "ISO_IMAGE" },
    { extId: "i-other", name: "Other", type: "DISK_IMAGE", projectExtId: "proj-b" },
    { extId: "i-win11", name: "win11-golden", type: "DISK_IMAGE" },
    { extId: "i-win-desc", name: "Golden", description: "Windows 10 Enterprise", type: "DISK_IMAGE" },
  ];

  it("puts templates first with their own size, then disk images, each by name", () => {
    expect(sourceChoices(images, templates, "proj-a")).toEqual([
      { kind: "template", extId: "t-locked", name: "Appliance", vcpus: 1, memoryGb: null, canInjectKey: false },
      { kind: "template", extId: "t-docker", name: "Ubuntu with Docker", vcpus: 4, memoryGb: 16, canInjectKey: true },
      { kind: "image", extId: "i-alma", name: "AlmaLinux 9" },
      { kind: "image", extId: "i-ubuntu", name: "Ubuntu 24.04" },
    ]);
  });

  it("without projects, every disk image and template", () => {
    expect(sourceChoices(images, templates, null).map((one) => one.extId)).toEqual(["t-locked", "t-other", "t-shared", "t-docker", "i-alma", "i-other", "i-ubuntu"]);
  });

  it("with a project, only templates that belong to it: a deployed template keeps its own project", () => {
    expect(sourceChoices([], templates, "proj-a").map((one) => one.extId)).toEqual(["t-locked", "t-docker"]);
  });

  it("leaves Windows out, by OS metadata, Sysprep customization or name", () => {
    const ids = sourceChoices(images, templates, null).map((one) => one.extId);
    expect(ids).not.toContain("t-sysprep");
    expect(ids).not.toContain("t-win");
    expect(ids).not.toContain("i-win11");
    expect(ids).not.toContain("i-win-desc");
    expect(sourceChoices(
      [
        { extId: "i-darwin", name: "Darwin winston", type: "DISK_IMAGE" },
        { extId: "i-os-meta", name: "Golden Base", type: "DISK_IMAGE", osType: "WINDOWS_SERVER" },
        { extId: "i-guest-os", name: "Corporate Base", type: "DISK_IMAGE", guestOs: "Microsoft Windows 11" },
        { extId: "i-cat", name: "Standard Image", type: "DISK_IMAGE", categories: [{ key: "OSType", value: "Windows" }] },
        { extId: "i-under", name: "windows_server_2022", type: "DISK_IMAGE" },
      ],
      [
        { extId: "t-guest-info", templateName: "Neutral Template", templateVersionSpec: { isGcOverrideEnabled: true, vmSpec: { guestInfo: { guestOsName: "Windows Server 2022" } } } },
        { extId: "t-guest-tools", templateName: "Base Template", templateVersionSpec: { isGcOverrideEnabled: true, vmSpec: { guestTools: { guestOsVersion: "Microsoft Windows 10" } } } },
      ],
      null,
    ).map((one) => one.extId)).toEqual(["i-darwin"]);
  });

  it("treats a template without override metadata as unable to take the sign-in key", () => {
    const listed = sourceChoices([], [
      { extId: "t-no-spec", templateName: "No Spec" },
      { extId: "t-no-flag", templateName: "No Flag", templateVersionSpec: { vmSpec: { numSockets: 2 } } },
      { extId: "t-allowed", templateName: "Allowed", templateVersionSpec: { isGcOverrideEnabled: true } },
    ], null);
    expect(listed).toEqual([
      { kind: "template", extId: "t-allowed", name: "Allowed", vcpus: null, memoryGb: null, canInjectKey: true },
      { kind: "template", extId: "t-no-flag", name: "No Flag", vcpus: 2, memoryGb: null, canInjectKey: false },
      { kind: "template", extId: "t-no-spec", name: "No Spec", vcpus: null, memoryGb: null, canInjectKey: false },
    ]);
  });

  it("sizes the server from the desktop count and each desktop's own CPUs and memory", () => {
    expect(serverShape(2, { cpus: 2, memoryGb: 4 })).toEqual({ desktops: 2, vcpus: 4, memoryGb: 10, diskGb: 100 });
    expect(serverShape(3, { cpus: 4, memoryGb: 8 })).toEqual({ desktops: 3, vcpus: 12, memoryGb: 26, diskGb: 120 });
  });
});

describe("creating the server", () => {
  const base = { name: "mausbot-desktops-abc123", clusterExtId: "c1", subnetExtId: "s1", userData: "#cloud-config\n" };

  it("creates from an image in the project and finds the VM in the finished task", async () => {
    const { client, calls } = fakePc({
      "POST /api/vmm/v4.3/ahv/config/vms": { data: { extId: "ZXhhbXBsZQ==:task-1" } },
      "GET /api/prism/v4.4/config/tasks/ZXhhbXBsZQ%3D%3D%3Atask-1": { data: { status: "SUCCEEDED", entitiesAffected: [{ rel: "vmm:ahv:config:vm", extId: "vm-1", name: base.name }] } },
    });
    const id = await client.createVm({ ...base, kind: "image", imageExtId: "i1", vcpus: 4, memoryGb: 10, diskGb: 100, projectExtId: "proj-a" });
    expect(id).toBe("vm-1");
    const create = calls[0]!;
    expect(create.headers?.["NTNX-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(create.body).toMatchObject({
      name: base.name, numSockets: 4, numCoresPerSocket: 1, memorySizeBytes: 10 * 1024 ** 3,
      cluster: { extId: "c1" }, projectExtId: "proj-a",
      disks: [{ backingInfo: { $objectType: "vmm.v4.ahv.config.VmDisk", diskSizeBytes: 100 * 1024 ** 3, dataSource: { reference: { $objectType: "vmm.v4.ahv.config.ImageReference", imageExtId: "i1" } } } }],
      nics: [{ nicNetworkInfo: { subnet: { extId: "s1" } } }],
      guestCustomization: { config: { $objectType: "vmm.v4.ahv.config.CloudInit", cloudInitScript: { value: Buffer.from(base.userData).toString("base64") } } },
    });
  });

  it("deploys a template with its own size and a bare cluster id", async () => {
    const { client, calls } = fakePc({
      "POST /api/vmm/v4.3/content/templates/t1/$actions/deploy": { data: { extId: "task-2" } },
      "GET /api/prism/v4.4/config/tasks/task-2": { data: { status: "SUCCEEDED", entitiesAffected: [{ rel: "vmm:content:template", extId: "t1" }, { rel: "vmm:ahv:config:vm", extId: "vm-2" }] } },
    });
    expect(await client.createVm({ ...base, kind: "template", templateExtId: "t1", projectExtId: "proj-a" })).toBe("vm-2");
    const body = calls[0]!.body as Record<string, any>;
    expect(body.clusterReference).toBe("c1");
    expect(body.numberOfVms).toBe(1);
    expect(Object.keys(body.overrideVmConfigMap[0]).sort()).toEqual(["guestCustomization", "name", "nics"]);
  });

  it("a role that can't read tasks finds the new VM by name", async () => {
    let listed = 0;
    const { client } = fakePc({
      "POST /api/vmm/v4.3/ahv/config/vms": { data: { extId: "task-3" } },
      "GET /api/prism/v4.4/config/tasks/task-3": status(403),
      "GET /api/vmm/v4.3/ahv/config/vms": () => ({ status: 200, etag: null, body: { data: listed++ ? [{ extId: "vm-3", name: base.name }] : [] } }),
    });
    expect(await client.createVm({ ...base, kind: "image", imageExtId: "i1", vcpus: 4, memoryGb: 10, diskGb: 100, projectExtId: null })).toBe("vm-3");
  });

  it("a failed task carries Prism Central's reason", async () => {
    const { client } = fakePc({
      "POST /api/vmm/v4.3/ahv/config/vms": { data: { extId: "task-4" } },
      "GET /api/prism/v4.4/config/tasks/task-4": { data: { status: "FAILED", errorMessages: [{ message: "Project quota exceeded" }] } },
    });
    await expect(client.createVm({ ...base, kind: "image", imageExtId: "i1", vcpus: 4, memoryGb: 10, diskGb: 100, projectExtId: "p" }))
      .rejects.toThrow("Project quota exceeded");
  });
});

describe("power and address", () => {
  it("powers on only when off, with the VM's ETag", async () => {
    let power = "OFF";
    const { client, calls } = fakePc({
      "GET /api/vmm/v4.3/ahv/config/vms/vm-1": () => ({ status: 200, etag: "etag-1", body: { data: { extId: "vm-1", powerState: power } } }),
      "POST /api/vmm/v4.3/ahv/config/vms/vm-1/$actions/power-on": () => { power = "ON"; return { status: 202, etag: null, body: { data: { extId: "t" } } }; },
      "GET /api/prism/v4.4/config/tasks/t": { data: { status: "SUCCEEDED" } },
    });
    await client.powerOn("vm-1");
    await client.powerOn("vm-1");
    const actions = calls.filter((call) => call.method === "POST");
    expect(actions).toHaveLength(1);
    expect(actions[0]!.headers?.["If-Match"]).toBe("etag-1");
  });

  it("waits for the power-on task no longer than the wake budget", async () => {
    const { client } = fakePc({
      "GET /api/vmm/v4.3/ahv/config/vms/vm-1": { data: { extId: "vm-1", powerState: "OFF" } },
      "POST /api/vmm/v4.3/ahv/config/vms/vm-1/$actions/power-on": () => ({ status: 202, etag: null, body: { data: { extId: "t" } } }),
      "GET /api/prism/v4.4/config/tasks/t": { data: { status: "RUNNING" } },
    });
    await expect(client.powerOn("vm-1", 0)).rejects.toMatchObject({ status: 504 });
  });

  it("bounds each Prism request and poll sleep by the power-on deadline without overshoot", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      const calls: PcRequest[] = [];
      const sleeps: number[] = [];
      const transport = async (request: PcRequest): Promise<PcResponse> => {
        calls.push(request);
        vi.advanceTimersByTime(1_000);
        if (request.path.endsWith("/vms/vm-1")) return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "OFF" } } };
        if (request.path.endsWith("/$actions/power-on")) return { status: 202, etag: null, body: { data: { extId: "t" } } };
        if (request.path.endsWith("/tasks/t")) return { status: 200, etag: null, body: { data: { status: "RUNNING" } } };
        return { status: 404, etag: null, body: null };
      };
      const client = new PcClient(transport, async (ms) => {
        sleeps.push(ms);
        vi.advanceTimersByTime(ms);
      });
      await expect(client.powerOn("vm-1", 4_200)).rejects.toMatchObject({ status: 504 });
      expect(calls.map((c) => [c.method, c.timeoutMs])).toEqual([
        ["GET", 4_200],
        ["POST", 3_200],
        ["GET", 2_200],
      ]);
      expect(sleeps).toEqual([1_200]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports task status and notifies the caller as soon as a create task id is returned", async () => {
    const seen: string[] = [];
    const { client } = fakePc({
      "POST /api/vmm/v4.3/ahv/config/vms": { data: { extId: "task-early" } },
      "GET /api/prism/v4.4/config/tasks/task-early": { data: { status: "SUCCEEDED", entitiesAffected: [{ rel: "vmm:ahv:config:vm", extId: "vm-99", name: "n" }] } },
      "GET /api/prism/v4.4/config/tasks/task-run": { data: { status: "RUNNING" } },
      "GET /api/prism/v4.4/config/tasks/task-fail": { data: { status: "FAILED" } },
      "GET /api/prism/v4.4/config/tasks/task-deny": status(403),
    });
    const vmId = await client.createVm(
      { name: "n", clusterExtId: "c1", subnetExtId: "s1", projectExtId: null, userData: "#cloud-config\n", kind: "image", imageExtId: "i1", vcpus: 2, memoryGb: 4, diskGb: 80 },
      60_000,
      (id) => seen.push(id),
    );
    expect(vmId).toBe("vm-99");
    expect(seen).toEqual(["task-early"]);
    expect(await client.taskState("task-early", "n")).toEqual({ state: "succeeded", vmExtId: "vm-99" });
    expect(await client.taskState("task-run", "n")).toEqual({ state: "running", vmExtId: null });
    expect(await client.taskState("task-fail", "n")).toEqual({ state: "failed", vmExtId: null });
    expect(await client.taskState("task-deny", "n")).toEqual({ state: "unreadable", vmExtId: null });
  });

  it("shuts down through ACPI, never the pulled-plug power-off", async () => {
    let power = "ON";
    const { client, calls } = fakePc({
      "GET /api/vmm/v4.3/ahv/config/vms/vm-1": () => ({ status: 200, etag: null, body: { data: { extId: "vm-1", powerState: power } } }),
      "POST /api/vmm/v4.3/ahv/config/vms/vm-1/$actions/shutdown": () => { power = "OFF"; return { status: 202, etag: null, body: { data: {} } }; },
    });
    await client.shutdown("vm-1");
    expect(calls.filter((call) => call.method === "POST").map((call) => call.path)).toEqual(["/api/vmm/v4.3/ahv/config/vms/vm-1/$actions/shutdown"]);
  });

  it("keeps polling VM power state during shutdown until OFF even when task polling returns 403 or no task id is returned", async () => {
    let vmGets = 0;
    const with403 = fakePc({
      "GET /api/vmm/v4.3/ahv/config/vms/vm-1": () => {
        vmGets += 1;
        return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: vmGets >= 4 ? "OFF" : "ON" } } };
      },
      "POST /api/vmm/v4.3/ahv/config/vms/vm-1/$actions/shutdown": { data: { extId: "task-403" } },
      "GET /api/prism/v4.4/config/tasks/task-403": status(403),
    });
    await with403.client.shutdown("vm-1");
    expect(vmGets).toBe(4);

    let noTaskGets = 0;
    const noTask = fakePc({
      "GET /api/vmm/v4.3/ahv/config/vms/vm-1": () => {
        noTaskGets += 1;
        return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: noTaskGets >= 3 ? "OFF" : "ON" } } };
      },
      "POST /api/vmm/v4.3/ahv/config/vms/vm-1/$actions/shutdown": { data: {} },
    });
    await noTask.client.shutdown("vm-1");
    expect(noTaskGets).toBe(3);
  });

  it("stops shutdown immediately when the shutdown task fails", async () => {
    let vmGets = 0;
    const { client } = fakePc({
      "GET /api/vmm/v4.3/ahv/config/vms/vm-1": () => {
        vmGets += 1;
        return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "ON" } } };
      },
      "POST /api/vmm/v4.3/ahv/config/vms/vm-1/$actions/shutdown": { data: { extId: "task-fail" } },
      "GET /api/prism/v4.4/config/tasks/task-fail": { data: { status: "FAILED", errorMessages: [{ message: "Guest refused ACPI" }] } },
    });
    await expect(client.shutdown("vm-1")).rejects.toMatchObject({ message: "Guest refused ACPI", taskFailed: true, unconfirmed: false });
    expect(vmGets).toBe(1);
  });

  it("never treats UNDETERMINED as off on initial or post-shutdown reads and marks polling timeouts or read errors unconfirmed", async () => {
    const initialUnknown = fakePc({
      "GET /api/vmm/v4.3/ahv/config/vms/vm-1": { data: { extId: "vm-1", powerState: "UNDETERMINED" } },
    });
    await expect(initialUnknown.client.shutdown("vm-1")).rejects.toMatchObject({ unconfirmed: true });

    let pollCount = 0;
    const postUnknown = fakePc({
      "GET /api/vmm/v4.3/ahv/config/vms/vm-1": () => {
        pollCount += 1;
        return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: pollCount === 1 ? "ON" : "UNDETERMINED" } } };
      },
      "POST /api/vmm/v4.3/ahv/config/vms/vm-1/$actions/shutdown": { data: {} },
    });
    await expect(postUnknown.client.shutdown("vm-1")).rejects.toMatchObject({ unconfirmed: true });

    let readErrCount = 0;
    const postError = fakePc({
      "GET /api/vmm/v4.3/ahv/config/vms/vm-1": () => {
        readErrCount += 1;
        if (readErrCount === 1) return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "ON" } } };
        return { status: 500, etag: null, body: { data: { error: [{ message: "PC read failed" }] } } };
      },
      "POST /api/vmm/v4.3/ahv/config/vms/vm-1/$actions/shutdown": { data: {} },
    });
    await expect(postError.client.shutdown("vm-1")).rejects.toMatchObject({ unconfirmed: true });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(100_000);
      const transport = async (request: PcRequest): Promise<PcResponse> => {
        vi.advanceTimersByTime(600);
        if (request.path.endsWith("/vms/vm-1")) return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "ON" } } };
        if (request.path.endsWith("/$actions/shutdown")) return { status: 202, etag: null, body: { data: {} } };
        return { status: 404, etag: null, body: null };
      };
      const timedOut = new PcClient(transport, async (ms) => { vi.advanceTimersByTime(ms); });
      await expect(timedOut.shutdown("vm-1", 1_500)).rejects.toMatchObject({ status: 504, unconfirmed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("deleting a VM that is already gone succeeds", async () => {
    const { client, calls } = fakePc({});
    await client.deleteVm("vm-gone");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("does not treat a 404 on delete-task polling as success until a VM lookup confirms 404, and throws unconfirmed otherwise", async () => {
    let vmGets = 0;
    const confirmed = fakePc({
      "GET /api/vmm/v4.3/ahv/config/vms/vm-1": () => {
        vmGets += 1;
        if (vmGets <= 2) return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "OFF" } } };
        return { status: 404, etag: null, body: null };
      },
      "DELETE /api/vmm/v4.3/ahv/config/vms/vm-1": { data: { extId: "task-del-404" } },
      "GET /api/prism/v4.4/config/tasks/task-del-404": status(404, "task missing"),
    });
    await confirmed.client.deleteVm("vm-1");
    expect(vmGets).toBe(3);

    let failGets = 0;
    const lookupFailed = fakePc({
      "GET /api/vmm/v4.3/ahv/config/vms/vm-1": () => {
        failGets += 1;
        if (failGets === 1) return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "OFF" } } };
        return { status: 500, etag: null, body: { data: { error: [{ message: "VMM error" }] } } };
      },
      "DELETE /api/vmm/v4.3/ahv/config/vms/vm-1": { data: { extId: "task-del-404" } },
      "GET /api/prism/v4.4/config/tasks/task-del-404": status(404, "task missing"),
    });
    await expect(lookupFailed.client.deleteVm("vm-1")).rejects.toMatchObject({ unconfirmed: true });

    vi.useFakeTimers();
    try {
      vi.setSystemTime(200_000);
      const transport = async (request: PcRequest): Promise<PcResponse> => {
        vi.advanceTimersByTime(500);
        if (request.method === "GET" && request.path.endsWith("/vms/vm-1")) {
          return { status: 200, etag: "e1", body: { data: { extId: "vm-1", powerState: "OFF" } } };
        }
        if (request.method === "DELETE" && request.path.endsWith("/vms/vm-1")) {
          return { status: 202, etag: null, body: { data: { extId: "task-del-404" } } };
        }
        return { status: 404, etag: null, body: null };
      };
      const stillPresent = new PcClient(transport, async (ms) => { vi.advanceTimersByTime(ms); });
      await expect(stillPresent.deleteVm("vm-1", 1_500)).rejects.toMatchObject({ status: 504, unconfirmed: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reads only an IPv4 literal as the address", () => {
    const nic = (value: string) => ({ nics: [{ nicNetworkInfo: { ipv4Config: { ipAddress: { value } } } }] });
    expect(vmAddress(nic("10.0.0.20\n  ProxyCommand evil"))).toBeNull();
    expect(vmAddress(nic("fe80::1"))).toBeNull();
    expect(vmAddress({ nics: [{ nicNetworkInfo: { ipv4Config: { ipAddress: { value: "bad host" } }, ipv4Info: { learnedIpAddresses: [{ value: "10.0.0.31" }] } } }] })).toBe("10.0.0.31");
  });

  it("finds a VM by name: its id, null for none, an error for two", async () => {
    const one = fakePc({ "GET /api/vmm/v4.3/ahv/config/vms": { data: [{ extId: "vm-1", name: "n" }] } });
    expect(await one.client.vmIdNamed("n")).toBe("vm-1");
    const none = fakePc({ "GET /api/vmm/v4.3/ahv/config/vms": { data: [] } });
    expect(await none.client.vmIdNamed("n")).toBeNull();
    const two = fakePc({ "GET /api/vmm/v4.3/ahv/config/vms": { data: [{ extId: "a", name: "n" }, { extId: "b", name: "n" }] } });
    await expect(two.client.vmIdNamed("n")).rejects.toMatchObject({ status: 409 });
  });

  it("prefers the IPAM address over the learned one", () => {
    const nic = (info: object) => ({ nics: [{ nicNetworkInfo: info }] });
    expect(vmAddress(nic({ ipv4Config: { ipAddress: { value: "10.0.0.20" } }, ipv4Info: { learnedIpAddresses: [{ value: "10.0.0.99" }] } }))).toBe("10.0.0.20");
    expect(vmAddress(nic({ ipv4Info: { learnedIpAddresses: [{ value: "10.0.0.99" }] } }))).toBe("10.0.0.99");
    expect(vmAddress({ nics: [{ networkInfo: { ipv4Config: { ipAddress: { value: "10.0.0.5" } } } }] })).toBe("10.0.0.5");
    expect(vmAddress({})).toBeNull();
  });
});

describe("addresses", () => {
  it("defaults to port 9440 over https", () => {
    expect(pcBaseUrl("pc.lab.example").href).toBe("https://pc.lab.example:9440/");
    expect(pcBaseUrl(" https://10.0.0.5:9440/console ").href).toBe("https://10.0.0.5:9440/");
    expect(() => pcBaseUrl("http://pc.lab.example")).toThrow();
  });

  it("sends a person to the Prism Central sign-in on the address they connected with", () => {
    expect(prismConsoleUrl("pc.lab.example")).toBe("https://pc.lab.example:9440/");
    expect(prismConsoleUrl("https://10.0.0.5:9440/console")).toBe("https://10.0.0.5:9440/");
    expect(() => prismConsoleUrl("http://pc.lab.example")).toThrow();
  });

  it("an error body's message reaches the caller", async () => {
    const { client } = fakePc({ "GET /api/vmm/v4.3/content/images": status(500, "Internal error") });
    await expect(client.images()).rejects.toEqual(new PcError(500, "Internal error"));
  });
});
