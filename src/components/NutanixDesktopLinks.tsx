import { useState } from "react";
import { ExternalLink, Monitor } from "lucide-react";
import { openExternalLink } from "@/lib/app-links";
import { t } from "@/lib/i18n";
import { sameFields, useStoreSelector } from "@/state/store-select";
import { useOpenComputer } from "./bot-panel/ComputerTab";

/** Two ways in once the Nutanix server is ready: the live desktop of the bot using it, and Prism Central for the VM itself.
 * `botId` is the bot whose panel is open; elsewhere it is the first bot on the server, or the first bot. */
export function NutanixDesktopLinks({ consoleUrl, botId }: { consoleUrl: string | null; botId?: string }) {
  const bots = useStoreSelector((s) => ({ bots: s.bots }), sameFields).bots;
  const bot = (botId ? bots.find((one) => one.id === botId) : undefined) ?? bots.find((one) => one.cloudBackend === "vps") ?? bots[0] ?? null;
  const openComputer = useOpenComputer(bot ?? { id: "" });
  const [failed, setFailed] = useState(false);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap gap-2">
        <button type="button" className="ui-button ui-button-primary" disabled={!bot} onClick={() => openComputer("computer")}>
          <Monitor size={13} aria-hidden="true" />{t("settings.nutanix.openDesktop")}
        </button>
        {consoleUrl && (
          <button type="button" className="ui-button" onClick={() => { setFailed(false); void openExternalLink(consoleUrl).catch(() => setFailed(true)); }}>
            <ExternalLink size={13} aria-hidden="true" />{t("settings.nutanix.openPrism")}
          </button>
        )}
      </div>
      {failed && <p role="alert" className="text-[12px] leading-4 text-danger">{t("settings.nutanix.openPrismFailed")}</p>}
    </div>
  );
}
