import { useEffect, useState } from "react";
import type { CloudBackend } from "../../shared/wire";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { sameFields, useStoreSelector } from "@/state/store-select";
import { NutanixDesktopLinks } from "./NutanixDesktopLinks";
import { readNutanix } from "./NutanixSetup";

export function CloudBackendPicker({
  value,
  compact = false,
  botId,
  onChange,
}: {
  value: CloudBackend;
  compact?: boolean;
  /** The bot whose settings these are, so Open bot desktop opens its panel. */
  botId?: string;
  onChange: (backend: CloudBackend) => void;
}) {
  const state = useStoreSelector((s) => ({ config: s.config }), sameFields);
  const nutanix = useNutanixServer(value === "vps" && !state.config?.cloudHome);
  if (state.config?.cloudHome) return null;
  return (
    <div className="mt-3 rounded-lg bg-inset p-3">
      <div className="text-[12px] font-medium text-ink">{compact ? t("botAccess.cloud.provider") : t("botAccess.cloud.backend")}</div>
      <div className="mt-0.5 text-[12px] text-ink-secondary">
        {nutanix
          ? t("botAccess.cloud.nutanixDescription", { name: nutanix.name, address: nutanix.ip ?? "" })
          : compact
          ? value === "vps" ? t("botAccess.cloud.vpsDescription") : t("botAccess.cloud.hostedDescription")
          : value === "vps"
          ? t("botAccess.cloud.vpsAutoDescription")
          : t("botAccess.cloud.hostedBackendDescription")}
      </div>
      {nutanix && <div className="mt-2"><NutanixDesktopLinks consoleUrl={nutanix.consoleUrl ?? null} botId={botId} /></div>}
      <div className="mt-2 flex overflow-hidden rounded-lg border border-hairline/40">
        {(["box", "vps"] as const).map((backend, i) => (
          <button
            key={backend}
            onClick={() => onChange(backend)}
            className={cn(
              "flex-1 py-1.5 text-[12px]",
              i > 0 && "border-l border-hairline/40",
              value === backend ? "bg-raised text-ink" : "text-ink-secondary hover:bg-raised/60 hover:text-ink",
            )}
          >
            {backend === "vps" ? t("botAccess.cloud.selfHostedVps") : t("botAccess.cloud.boat")}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The Nutanix desktop server while it is ready: every bot on "Self-hosted VPS" then works on it, so it is named here. */
function useNutanixServer(enabled: boolean) {
  const [server, setServer] = useState<{ name: string; ip: string | null; consoleUrl?: string | null } | null>(null);
  useEffect(() => {
    if (!enabled) { setServer(null); return; }
    let cancelled = false;
    void readNutanix().then((status) => {
      const ready = status?.server?.ready && !status.server.needsCheck ? status.server : null;
      if (!cancelled) setServer(ready);
    });
    return () => { cancelled = true; };
  }, [enabled]);
  return server;
}
