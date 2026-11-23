import { useState } from "react";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { useStoreSelector } from "@/state/store-select";
import { ConfirmDialog } from "./ConfirmDialog";

export function NutanixDeleteAsk() {
  const name = useStoreSelector((state) => state.config?.nutanixAsk);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!name) return null;
  const settle = (path: string, method: string) => {
    setBusy(true);
    setError(null);
    api(path, { method, body: "{}" })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };
  return (
    <ConfirmDialog open title={t("settings.nutanix.emptyTitle")} body={error ?? t("settings.nutanix.emptyBody", { name })}
      confirmLabel={t("settings.nutanix.deleteConfirm")} cancelLabel={t("settings.nutanix.keep")} pending={busy}
      onCancel={() => settle("/api/nutanix/keep", "POST")} onConfirm={() => settle("/api/nutanix/server", "DELETE")} />
  );
}
