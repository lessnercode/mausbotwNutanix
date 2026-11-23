// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setLocale } from "@/lib/i18n";
import { api } from "@/state/store";
import { NutanixDeleteAsk } from "../NutanixDeleteAsk";

let config: { nutanixAsk?: string } | null = null;
vi.mock("@/state/store", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/state/store")>()), api: vi.fn() }));
vi.mock("@/state/store-select", () => ({ useStoreSelector: (select: (state: { config: typeof config }) => unknown) => select({ config }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(api).mockResolvedValue({});
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.mocked(api).mockReset();
  config = null;
});

const render = () => act(() => root.render(createElement(NutanixDeleteAsk)));
const button = (text: string) => Array.from(document.body.querySelectorAll("button")).find((one) => one.textContent === text)!;

describe("NutanixDeleteAsk", () => {
  it("says nothing while the server still has bot desktops", () => {
    render();
    expect(document.body.textContent).not.toContain("No bot uses the Nutanix server now");
  });

  it("asks, naming the server, once its last bot desktop is gone; Delete server deletes it", async () => {
    config = { nutanixAsk: "mausbot-desktops-abc123" };
    render();
    expect(document.body.textContent).toContain("The last bot desktop on mausbot-desktops-abc123 is gone");
    await act(async () => button("Delete server").click());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/nutanix/server", { method: "DELETE", body: "{}" });
  });

  it("Keep it keeps the server", async () => {
    config = { nutanixAsk: "mausbot-desktops-abc123" };
    render();
    await act(async () => button("Keep it").click());
    expect(vi.mocked(api)).toHaveBeenCalledWith("/api/nutanix/keep", { method: "POST", body: "{}" });
  });

  it("a refused delete is shown, and the question stays", async () => {
    config = { nutanixAsk: "mausbot-desktops-abc123" };
    vi.mocked(api).mockRejectedValue(new Error("1 bot desktops still run on this server. Remove them first."));
    render();
    await act(async () => button("Delete server").click());
    expect(document.body.textContent).toContain("1 bot desktops still run on this server");
  });
});
