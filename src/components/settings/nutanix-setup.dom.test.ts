// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openExternalLink } from "@/lib/app-links";
import { setLocale } from "@/lib/i18n";
import { api } from "@/state/store";
import { NutanixSetup, type NutanixStatus } from "../NutanixSetup";

const openComputer = vi.fn();
const bots = [{ id: "bot-plain" }, { id: "bot-vps", cloudBackend: "vps" }];
vi.mock("@/lib/app-links", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/app-links")>()), openExternalLink: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/state/store-select", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/state/store-select")>()), useStoreSelector: () => ({ bots }) }));
vi.mock("../bot-panel/ComputerTab", () => ({ useOpenComputer: (bot: { id: string }) => (view: string) => openComputer(bot.id, view) }));
vi.mock("@/state/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/state/store")>()), api: vi.fn() }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.mocked(api).mockReset();
});

const pc = { address: "pc.lab.example:9440", username: "admin", version: "pc.7.6", projects: true, fingerprint: "AB:CD", botsMayUse: false };
const status = (over: Partial<NutanixStatus> = {}): NutanixStatus => ({
  available: true, pc, server: null, defaultAlias: null, deploy: null,
  sizes: { default: 2, shapes: [1, 2, 3].map((desktops) => ({ desktops, vcpus: desktops * 2, memoryGb: desktops * 4 + 2, diskGb: 60 + desktops * 20 })) },
  ...over,
});
const choices = (subnet: string) => ({ sources: [{ kind: "image", extId: "img", name: "Ubuntu" }], subnets: [{ extId: subnet, name: subnet, clusterName: "C1", free: 3 }] });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const render = (initial: NutanixStatus) => act(() => root.render(createElement(NutanixSetup, { initial, onClose: () => {}, onChanged: () => {} })));
const selects = () => Array.from(document.body.querySelectorAll("select"));
const subnetSelect = () => selects().find((one) => Array.from(one.options).some((option) => option.value.startsWith("subnet")))!;
function choose(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  setter.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
const buttons = () => Array.from(document.body.querySelectorAll("button")).map((one) => one.textContent);

describe("NutanixSetup", () => {
  it("a late answer for the project left behind never replaces the one chosen now", async () => {
    const forA = deferred<unknown>();
    const forB = deferred<unknown>();
    vi.mocked(api).mockImplementation(async (path: string) => {
      if (path === "/api/nutanix/projects") return { projects: [{ extId: "a", name: "A" }, { extId: "b", name: "B" }] };
      if (path.endsWith("project=a")) return await forA.promise;
      if (path.endsWith("project=b")) return await forB.promise;
      throw new Error(path);
    });
    render(status());
    await act(async () => {});
    await act(async () => choose(selects()[0]!, "a"));
    await act(async () => choose(selects()[0]!, "b"));
    await act(async () => forB.resolve(choices("subnet-b")));
    await act(async () => forA.resolve(choices("subnet-a")));
    const subnet = subnetSelect();
    expect(subnet.value).toBe("subnet-b");
    expect(Array.from(subnet.options).map((one) => one.value)).toEqual(["subnet-b"]);
  });

  it("a list that failed to load can be tried again in place", async () => {
    let attempts = 0;
    vi.mocked(api).mockImplementation(async () => {
      attempts++;
      if (attempts === 1) throw new Error("Prism Central refused: busy");
      return choices("subnet-1");
    });
    render(status({ pc: { ...pc, projects: false } }));
    await act(async () => {});
    expect(document.body.querySelector("[role=alert]")?.textContent).toBe("Prism Central refused: busy");
    const retry = Array.from(document.body.querySelectorAll("button")).find((one) => one.textContent === "Try again")!;
    await act(async () => retry.click());
    expect(document.body.querySelector("[role=alert]")).toBeNull();
    expect(subnetSelect().value).toBe("subnet-1");
  });

  it("sizes an image by how many desktops it holds, starting at the Max desktops setting", async () => {
    vi.mocked(api).mockResolvedValue(choices("subnet-1"));
    render(status({ pc: { ...pc, projects: false } }));
    await act(async () => {});
    const size = selects().find((one) => Array.from(one.options).some((option) => option.textContent?.includes("GB disk")))!;
    expect(size.value).toBe("2");
    expect(Array.from(size.options).map((one) => one.textContent)).toEqual([
      "1 · 2 CPUs, 6 GB memory, 80 GB disk", "2 · 4 CPUs, 10 GB memory, 100 GB disk", "3 · 6 CPUs, 14 GB memory, 120 GB disk",
    ]);
  });

  it("can connect again while the server exists, as the certificate error asks", () => {
    vi.mocked(api).mockResolvedValue({ projects: [] });
    render(status({ server: { name: "mausbot-desktops-abc123", alias: "mausbot-desktops-abc123", ip: "10.0.0.20", ready: true, askDelete: false } }));
    expect(buttons()).toContain("Connect again…");
    expect(buttons()).toContain("Delete server…");
  });

  it("says plainly when the Vault login is one bots may already use", () => {
    vi.mocked(api).mockResolvedValue({ projects: [] });
    render(status({ pc: { ...pc, botsMayUse: true } }));
    const change = Array.from(document.body.querySelectorAll("button")).find((one) => one.textContent === "Change Prism Central")!;
    act(() => change.click());
    expect(document.body.textContent).toContain("in a login you already had");
  });

  it("Check Prism Central again calls POST /api/nutanix/check, never DELETE, and keeps deleting as a separate confirmed action", async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/nutanix/check" && init?.method === "POST") {
        return {
          ...status({
            pc: { ...pc, projects: false },
            server: { name: "mausbot-desktops-abc123", alias: "mausbot-desktops-abc123", ip: null, ready: false, askDelete: false, needsCheck: false, canClear: false },
            deploy: { phase: "failed", error: "Setup didn't finish. Delete the server and deploy again." },
          }),
          check: { outcome: "found", message: "Found mausbot-desktops-abc123 in Prism Central. Delete it if you want to start over." },
        };
      }
      if (path === "/api/nutanix/server" && init?.method === "DELETE") {
        return status({ pc: { ...pc, projects: false }, server: null, deploy: null });
      }
      if (path === "/api/nutanix/choices") return choices("subnet-1");
      return { projects: [] };
    });
    render(status({
      pc: { ...pc, projects: false },
      server: { name: "mausbot-desktops-abc123", alias: "mausbot-desktops-abc123", ip: null, ready: false, askDelete: false, needsCheck: true, canClear: false },
      deploy: { phase: "failed", error: "Couldn't confirm" },
    }));
    const clear = Array.from(document.body.querySelectorAll("button")).find((one) => one.textContent === "Clear server record") as HTMLButtonElement;
    expect(clear.disabled).toBe(true);

    const retry = Array.from(document.body.querySelectorAll("button")).find((one) => one.textContent === "Check Prism Central again")!;
    await act(async () => retry.click());

    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/nutanix/check", { method: "POST", body: "{}" });
    expect(vi.mocked(api).mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
    expect(document.body.textContent).toContain("Found mausbot-desktops-abc123 in Prism Central.");
    expect(buttons()).toContain("Delete server…");

    const del = Array.from(document.body.querySelectorAll("button")).find((one) => one.textContent === "Delete server…")!;
    act(() => del.click());
    const confirm = Array.from(document.body.querySelectorAll("button")).find((one) => one.textContent === "Delete server")!;
    await act(async () => confirm.click());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/nutanix/server", { method: "DELETE", body: "{}" });
  });

  it("lets the user explicitly clear the server record only after a check confirms no VM exists", async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/nutanix/check" && init?.method === "POST") {
        return {
          ...status({
            pc: { ...pc, projects: false },
            server: { name: "mausbot-desktops-abc123", alias: "mausbot-desktops-abc123", ip: null, ready: false, askDelete: false, needsCheck: true, canClear: true },
            deploy: { phase: "failed", error: "Couldn't confirm" },
          }),
          check: { outcome: "missing", message: "mausbot-desktops-abc123 wasn't found in Prism Central." },
        };
      }
      if (path === "/api/nutanix/server" && init?.method === "DELETE") {
        return status({ pc: { ...pc, projects: false }, server: null, deploy: null });
      }
      if (path === "/api/nutanix/choices") return choices("subnet-1");
      return { projects: [] };
    });
    render(status({
      pc: { ...pc, projects: false },
      server: { name: "mausbot-desktops-abc123", alias: "mausbot-desktops-abc123", ip: null, ready: false, askDelete: false, needsCheck: true, canClear: false },
      deploy: { phase: "failed", error: "Couldn't confirm" },
    }));
    const retry = Array.from(document.body.querySelectorAll("button")).find((one) => one.textContent === "Check Prism Central again")!;
    await act(async () => retry.click());
    const clear = Array.from(document.body.querySelectorAll("button")).find((one) => one.textContent === "Clear server record") as HTMLButtonElement;
    expect(clear.disabled).toBe(false);
    await act(async () => clear.click());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/nutanix/server", { method: "DELETE", body: JSON.stringify({ confirmedChecked: true }) });
  });

  it("surfaces uncertain shutdown state, keeps Resume connections disabled until check sees ON, and calls POST /api/nutanix/resume", async () => {
    vi.mocked(api).mockImplementation(async (path: string, init?: RequestInit) => {
      if (path === "/api/nutanix/check" && init?.method === "POST") {
        return {
          ...status({
            pc: { ...pc, projects: false },
            server: { name: "mausbot-desktops-abc123", alias: "mausbot-desktops-abc123", ip: "10.0.0.20", ready: true, askDelete: false, shutdownUnknown: true, canResume: true },
          }),
          check: { outcome: "on", message: "mausbot-desktops-abc123 is still powered on in Prism Central." },
        };
      }
      if (path === "/api/nutanix/resume" && init?.method === "POST") {
        return status({
          pc: { ...pc, projects: false },
          server: { name: "mausbot-desktops-abc123", alias: "mausbot-desktops-abc123", ip: "10.0.0.20", ready: true, askDelete: false, shutdownUnknown: false, canResume: false },
        });
      }
      return { projects: [] };
    });
    render(status({
      pc: { ...pc, projects: false },
      server: { name: "mausbot-desktops-abc123", alias: "mausbot-desktops-abc123", ip: "10.0.0.20", ready: true, askDelete: false, shutdownUnknown: true, canResume: false },
    }));
    expect(document.body.textContent).toContain("Connections are paused");
    const resumeBefore = Array.from(document.body.querySelectorAll("button")).find((one) => one.textContent === "Resume connections") as HTMLButtonElement;
    expect(resumeBefore.disabled).toBe(true);

    const checkBtn = Array.from(document.body.querySelectorAll("button")).find((one) => one.textContent === "Check Prism Central again")!;
    await act(async () => checkBtn.click());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/nutanix/check", { method: "POST", body: "{}" });

    const resumeAfter = Array.from(document.body.querySelectorAll("button")).find((one) => one.textContent === "Resume connections") as HTMLButtonElement;
    expect(resumeAfter.disabled).toBe(false);
    await act(async () => resumeAfter.click());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/nutanix/resume", { method: "POST", body: "{}" });
    expect(document.body.textContent).toContain("Every bot's desktop runs here.");
  });

  it("a ready server offers the bot's live desktop and Prism Central", async () => {
    vi.mocked(api).mockResolvedValue({ projects: [] });
    openComputer.mockClear();
    render(status({ server: { name: "mausbot-desktops-abc123", alias: "mausbot-desktops-abc123", ip: "10.0.0.20", ready: true, askDelete: false, consoleUrl: "https://pc.lab.example:9440/" } }));
    const button = (label: string) => [...host.ownerDocument.querySelectorAll("button")].find((one) => one.textContent?.includes(label));
    await act(async () => { button("Open bot desktop")!.click(); });
    expect(openComputer).toHaveBeenCalledWith("bot-vps", "computer");
    await act(async () => { button("Open in Prism Central")!.click(); });
    expect(vi.mocked(openExternalLink)).toHaveBeenCalledWith("https://pc.lab.example:9440/");
  });

  it("offers neither while the server is still being built", () => {
    vi.mocked(api).mockResolvedValue({ projects: [] });
    render(status({ server: { name: "mausbot-desktops-abc123", alias: "mausbot-desktops-abc123", ip: null, ready: false, askDelete: false } }));
    expect(host.ownerDocument.body.textContent).not.toContain("Open bot desktop");
  });
});
