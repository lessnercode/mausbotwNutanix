// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";

const fixture = vi.hoisted(() => ({ nutanix: null as unknown }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: { ...original.initialState, config: { cloudHome: false } }, dispatch: vi.fn() }) };
});
vi.mock("./NutanixSetup", () => ({ readNutanix: () => Promise.resolve(fixture.nutanix) }));
vi.mock("./NutanixDesktopLinks", () => ({ NutanixDesktopLinks: (props: { botId?: string }) => createElement("div", { "data-testid": "links" }, props.botId) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { CloudBackendPicker } = await import("./CloudBackendPicker");
let host: HTMLDivElement;
let root: Root;

beforeEach(() => { setLocale("en"); host = document.createElement("div"); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const render = async (value: "box" | "vps") => {
  await act(async () => { root.render(createElement(CloudBackendPicker, { compact: true, value, botId: "bot-1", onChange: () => {} })); });
};
const ready = { server: { name: "mausbot-desktops-abc123", ip: "10.0.0.20", ready: true, consoleUrl: "https://pc.lab.example:9440/" } };

describe("CloudBackendPicker with a Nutanix server", () => {
  it("names the Nutanix desktop and offers its two buttons for the bot, on Self-hosted VPS", async () => {
    fixture.nutanix = ready;
    await render("vps");
    expect(host.textContent).toContain("Nutanix desktop: mausbot-desktops-abc123 (10.0.0.20)");
    expect(host.querySelector("[data-testid=links]")?.textContent).toBe("bot-1");
  });

  it("says nothing of Nutanix on Boat, or while the server is not ready", async () => {
    fixture.nutanix = ready;
    await render("box");
    expect(host.textContent).not.toContain("Nutanix");
    fixture.nutanix = { server: { ...ready.server, ready: false } };
    await render("vps");
    expect(host.textContent).not.toContain("Nutanix");
    expect(host.textContent).toContain("Your own server, connected over SSH.");
  });
});
