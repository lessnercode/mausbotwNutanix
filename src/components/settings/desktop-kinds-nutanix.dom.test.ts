// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { api } from "@/state/store";
import { DesktopKinds } from "./DesktopKinds";

vi.mock("@/state/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/state/store")>()), api: vi.fn() }));
vi.mock("@/state/store-select", () => ({ useStoreSelector: (select: (state: { config: object }) => unknown) => select({ config: {} }) }));
vi.mock("./settings-shell", () => ({ useSettingsShell: () => ({ ctx: { advanced: false, plan: null }, place: { name: "This computer" }, go: () => {} }) }));
vi.mock("./settings-context", () => ({ useOtherPlaces: () => [] }));
vi.mock("./account-summary", () => ({ useAccountSummary: () => ({ paid: false }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("fetch", vi.fn(async () => new Response("null", { status: 404 })));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.mocked(api).mockReset();
});

describe("the Nutanix desktops row", () => {
  it("shows in Simple mode before anything is connected, so setup can start there", async () => {
    vi.mocked(api).mockResolvedValue({ available: true, pc: null, server: null, defaultAlias: null, deploy: null, sizes: { default: 2, shapes: [] } });
    await act(async () => root.render(createElement(DesktopKinds)));
    expect(document.body.querySelector("[data-desktop-kind=nutanix]")).not.toBeNull();
  });

  it("stays hidden where Nutanix desktops are not available", async () => {
    vi.mocked(api).mockResolvedValue({ available: false, pc: null, server: null, defaultAlias: null, deploy: null, sizes: { default: 2, shapes: [] } });
    await act(async () => root.render(createElement(DesktopKinds)));
    expect(document.body.querySelector("[data-desktop-kind=nutanix]")).toBeNull();
  });
});
