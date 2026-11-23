import { useCallback, useEffect, useId, useState, type ReactNode } from "react";
import { Loader2 } from "lucide-react";
import { t } from "@/lib/i18n";
import { api } from "@/state/store";
import { ConfirmDialog } from "./ConfirmDialog";
import { KEY_FIELD } from "./keys/KeyRow";
import { NutanixDesktopLinks } from "./NutanixDesktopLinks";
import { Select } from "./Select";
import { SettingsDialog } from "./settings/SettingsDialog";

type Phase = "creating" | "starting" | "address" | "installing" | "ready" | "failed";
type Shape = { desktops: number; vcpus: number; memoryGb: number; diskGb: number };
export type NutanixStatus = {
  available: boolean;
  pc: { address: string; username: string; version: string | null; projects: boolean; fingerprint: string; botsMayUse: boolean } | null;
  server: {
    name: string; alias: string; ip: string | null; ready: boolean; askDelete: boolean;
    needsCheck?: boolean; checkReason?: "create" | "delete"; canClear?: boolean;
    shutdownUnknown?: boolean; canResume?: boolean; consoleUrl?: string | null;
  } | null;
  defaultAlias: string | null;
  deploy: { phase: Phase; error: string | null } | null;
  sizes: { default: number; shapes: Shape[] };
};
type NutanixCheckResult = NutanixStatus & {
  check?: { outcome: "found" | "running" | "pending" | "failed" | "missing" | "off" | "on" | "unknown"; message: string };
};
type Source = { kind: "template"; extId: string; name: string; vcpus: number | null; memoryGb: number | null; canInjectKey: boolean } | { kind: "image"; extId: string; name: string };
type Subnet = { extId: string; name: string; clusterName: string | null; free: number };

const STEPS: Array<Exclude<Phase, "ready" | "failed">> = ["creating", "starting", "address", "installing"];

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function readNutanix(): Promise<NutanixStatus | null> {
  return await api<NutanixStatus>("/api/nutanix").catch(() => null);
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-[12px] font-medium leading-4 text-ink-secondary">{label}</label>
      {children(id)}
    </div>
  );
}

function Value({ label, value }: { label: string; value: string }) {
  return <p className="truncate text-[13px] leading-[18px] text-ink-secondary" title={value}>{label} · <span className="text-ink">{value}</span></p>;
}

function ConnectForm({ status, onDone, onCancel }: { status: NutanixStatus; onDone: (next: NutanixStatus) => void; onCancel?: () => void }) {
  const [address, setAddress] = useState(status.pc?.address ?? "");
  const [username, setUsername] = useState(status.pc?.username ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = address.trim() && username.trim() && password;
  const connect = () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    api<NutanixStatus>("/api/nutanix/connect", { method: "POST", body: JSON.stringify({ address: address.trim(), username: username.trim(), password }) })
      .then(onDone, (e) => setError(message(e)))
      .finally(() => setBusy(false));
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); connect(); }}>
      <Field label={t("settings.nutanix.address")}>{(id) => <input id={id} className={KEY_FIELD} value={address} onChange={(e) => setAddress(e.target.value)} autoComplete="off" spellCheck={false} placeholder="pc.example.com" dir="ltr" />}</Field>
      <Field label={t("settings.nutanix.username")}>{(id) => <input id={id} className={KEY_FIELD} value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" spellCheck={false} dir="ltr" />}</Field>
      <Field label={t("settings.nutanix.password")}>{(id) => <input id={id} type="password" className={KEY_FIELD} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />}</Field>
      <p className="text-[12px] leading-4 text-ink-tertiary">{t(status.pc?.botsMayUse ? "settings.nutanix.vaultShared" : "settings.nutanix.vaultLine")}</p>
      {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel && <button type="button" className="ui-button" onClick={onCancel}>{t("common.cancel")}</button>}
        <button type="submit" className="ui-button ui-button-primary" disabled={!ready || busy}>
          {busy ? <Loader2 size={13} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : t("settings.nutanix.connect")}
        </button>
      </div>
    </form>
  );
}

function ChooseAndDeploy({ status, onStarted }: { status: NutanixStatus; onStarted: (next: NutanixStatus) => void }) {
  const pc = status.pc!;
  const [projects, setProjects] = useState<Array<{ extId: string; name: string }> | null>(pc.projects ? null : []);
  const [project, setProject] = useState("");
  const [choices, setChoices] = useState<{ sources: Source[]; subnets: Subnet[] } | null>(null);
  const [source, setSource] = useState("");
  const [subnet, setSubnet] = useState("");
  const [desktops, setDesktops] = useState(status.sizes.default);
  const [error, setError] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!pc.projects) return;
    let current = true;
    setListError(null);
    api<{ projects: Array<{ extId: string; name: string }> }>("/api/nutanix/projects").then(({ projects: list }) => {
      if (!current) return;
      setProjects(list);
      if (list.length === 1) setProject(list[0]!.extId);
    }, (e) => { if (current) setListError(message(e)); });
    return () => { current = false; };
  }, [pc.projects, attempt]);

  useEffect(() => {
    if (pc.projects && !project) return;
    let current = true;
    setChoices(null);
    setSource("");
    setSubnet("");
    setListError(null);
    api<{ sources: Source[]; subnets: Subnet[] }>(`/api/nutanix/choices${project ? `?project=${encodeURIComponent(project)}` : ""}`).then((next) => {
      if (!current) return;
      setChoices(next);
      const firstUsable = next.sources.find((one) => one.kind === "image" || one.canInjectKey);
      if (firstUsable) setSource(`${firstUsable.kind}:${firstUsable.extId}`);
      if (next.subnets[0]) setSubnet(next.subnets[0].extId);
    }, (e) => { if (current) setListError(message(e)); });
    return () => { current = false; };
  }, [pc.projects, project, attempt]);

  const chosen = choices?.sources.find((one) => `${one.kind}:${one.extId}` === source);
  const deploy = () => {
    if (!chosen || !subnet || busy) return;
    setBusy(true);
    setError(null);
    api<NutanixStatus>("/api/nutanix/deploy", { method: "POST", body: JSON.stringify({
      projectExtId: pc.projects ? project : null, source: { kind: chosen.kind, extId: chosen.extId }, subnetExtId: subnet, ...(chosen.kind === "image" ? { desktops } : {}),
    }) }).then(onStarted, (e) => setError(message(e))).finally(() => setBusy(false));
  };
  const sourceLabel = (one: Source) => {
    if (one.kind === "image") return t("settings.nutanix.imageOption", { name: one.name });
    if (!one.canInjectKey) return t("settings.nutanix.templateLocked", { name: one.name });
    return one.vcpus && one.memoryGb ? t("settings.nutanix.templateSized", { name: one.name, cpus: one.vcpus, memory: one.memoryGb }) : t("settings.nutanix.templateOption", { name: one.name });
  };
  const loading = !listError && ((pc.projects && projects === null) || ((!pc.projects || project) && choices === null));

  return (
    <div className="flex flex-col gap-3">
      {pc.projects && projects && projects.length > 1 && (
        <Field label={t("settings.nutanix.project")}>{(id) => (
          <Select id={id} value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="" disabled>{t("settings.nutanix.chooseProject")}</option>
            {projects.map((one) => <option key={one.extId} value={one.extId}>{one.name}</option>)}
          </Select>
        )}</Field>
      )}
      {pc.projects && projects?.length === 0 && <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.nutanix.noProjects")}</p>}
      {listError && (
        <div className="flex items-center justify-between gap-3">
          <p role="alert" className="text-[12px] leading-4 text-danger">{listError}</p>
          <button type="button" className="ui-button shrink-0" onClick={() => setAttempt((n) => n + 1)}>{t("settings.nutanix.retry")}</button>
        </div>
      )}
      {loading && <p role="status" className="flex items-center gap-2 text-[13px] leading-[18px] text-ink-secondary"><Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />{t("settings.nutanix.loading")}</p>}
      {choices && (choices.sources.length === 0
        ? <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.nutanix.noSources")}</p>
        : (
          <Field label={t("settings.nutanix.source")}>{(id) => (
            <Select id={id} value={source} onChange={(e) => setSource(e.target.value)}>
              {choices.sources.map((one) => <option key={`${one.kind}:${one.extId}`} value={`${one.kind}:${one.extId}`} disabled={one.kind === "template" && !one.canInjectKey}>{sourceLabel(one)}</option>)}
            </Select>
          )}</Field>
        ))}
      {choices && (choices.subnets.length === 0
        ? <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.nutanix.noSubnets")}</p>
        : (
          <Field label={t("settings.nutanix.subnet")}>{(id) => (
            <Select id={id} value={subnet} onChange={(e) => setSubnet(e.target.value)}>
              {choices.subnets.map((one) => <option key={one.extId} value={one.extId}>{t("settings.nutanix.subnetOption", { name: one.name, cluster: one.clusterName ?? "", free: one.free })}</option>)}
            </Select>
          )}</Field>
        ))}
      {chosen?.kind === "image" && (
        <Field label={t("settings.nutanix.size")}>{(id) => (
          <Select id={id} value={desktops} onChange={(e) => setDesktops(Number(e.target.value))}>
            {status.sizes.shapes.map((shape) => (
              <option key={shape.desktops} value={shape.desktops}>{t("settings.nutanix.sizeOption", { desktops: shape.desktops, cpus: shape.vcpus, memory: shape.memoryGb, disk: shape.diskGb })}</option>
            ))}
          </Select>
        )}</Field>
      )}
      {chosen?.kind === "template" && <p className="text-[12px] leading-4 text-ink-tertiary">{t("settings.nutanix.templateSize")}</p>}
      {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
      <div className="flex justify-end">
        <button type="button" className="ui-button ui-button-primary" disabled={!chosen || !subnet || busy} onClick={deploy}>{t("settings.nutanix.deploy")}</button>
      </div>
    </div>
  );
}

export function NutanixSetup({ initial, onClose, onChanged }: { initial: NutanixStatus; onClose: () => void; onChanged: () => void }) {
  const [status, setStatus] = useState(initial);
  const [reconnect, setReconnect] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkNote, setCheckNote] = useState<string | null>(null);
  const phase = status.deploy?.phase ?? null;
  const working = phase !== null && phase !== "ready" && phase !== "failed";

  const update = useCallback((next: NutanixStatus) => { setStatus(next); onChanged(); }, [onChanged]);
  useEffect(() => {
    if (!working) return;
    const timer = setInterval(() => { void readNutanix().then((next) => next && update(next)); }, 3_000);
    return () => clearInterval(timer);
  }, [working, update]);

  const server = status.server;

  const checkPc = () => {
    if (!server || busy) return;
    setBusy(true);
    setError(null);
    setCheckNote(null);
    api<NutanixCheckResult>("/api/nutanix/check", { method: "POST", body: "{}" })
      .then((next) => {
        setCheckNote(next.check?.message ?? null);
        update(next);
      }, (e) => {
        setError(message(e));
        void readNutanix().then((next) => next && update(next));
      })
      .finally(() => setBusy(false));
  };

  const remove = (confirmedChecked = false) => {
    if (!server) return;
    setBusy(true);
    setError(null);
    setCheckNote(null);
    api<NutanixStatus>("/api/nutanix/server", { method: "DELETE", body: JSON.stringify(confirmedChecked ? { confirmedChecked: true } : {}) })
      .then((next) => { setConfirmDelete(false); update(next); }, (e) => {
        setConfirmDelete(false);
        setError(message(e));
        void readNutanix().then((next) => next && update(next));
      })
      .finally(() => setBusy(false));
  };

  const resume = () => {
    if (!server || busy) return;
    setBusy(true);
    setError(null);
    setCheckNote(null);
    api<NutanixStatus>("/api/nutanix/resume", { method: "POST", body: "{}" })
      .then((next) => update(next), (e) => {
        setError(message(e));
        void readNutanix().then((next) => next && update(next));
      })
      .finally(() => setBusy(false));
  };

  let body: ReactNode;
  if (!status.pc || reconnect) {
    body = <ConnectForm status={status} onDone={(next) => { setReconnect(false); setCheckNote(null); update(next); }} onCancel={status.pc ? () => setReconnect(false) : undefined} />;
  } else if (server?.needsCheck && !working) {
    body = (
      <div className="flex flex-col gap-3">
        <Value label={t("settings.nutanix.server")} value={server.name} />
        <p className="text-[13px] leading-[18px] text-ink-secondary">
          {t(server.checkReason === "delete" ? "settings.nutanix.checkDeleteBody" : "settings.nutanix.checkPcBody", { name: server.name })}
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="ui-button" disabled={busy} onClick={checkPc}>{t("settings.nutanix.checkPcRetry")}</button>
          <button type="button" className="ui-button ui-button-primary" disabled={busy || !server.canClear} onClick={() => remove(true)}>{t("settings.nutanix.checkPcClear")}</button>
        </div>
      </div>
    );
  } else if (server?.shutdownUnknown && !working) {
    body = (
      <div className="flex flex-col gap-3">
        <Value label={t("settings.nutanix.server")} value={server.ip ? `${server.name} · ${server.ip}` : server.name} />
        <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.nutanix.shutdownUnknownBody", { name: server.name })}</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className="ui-button" disabled={busy} onClick={checkPc}>{t("settings.nutanix.checkPcRetry")}</button>
          <button type="button" className="ui-button ui-button-primary" disabled={busy || !server.canResume} onClick={resume}>{t("settings.nutanix.resumeConnections")}</button>
        </div>
      </div>
    );
  } else if (working || (phase === "failed" && server)) {
    const at = phase === "failed" ? -1 : STEPS.indexOf(phase as typeof STEPS[number]);
    body = (
      <div className="flex flex-col gap-3">
        <ol className="flex flex-col gap-2" aria-live="polite">
          {STEPS.map((step, index) => (
            <li key={step} data-nutanix-step={step} aria-current={index === at ? "step" : undefined} className="flex items-center gap-3 text-[13px] leading-[18px] text-ink">
              <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-full bg-ink/[0.06] text-[12px] font-medium leading-4 text-ink-secondary">
                {index < at ? "✓" : index === at ? <Loader2 size={12} className="animate-spin motion-reduce:animate-none" /> : index + 1}
              </span>
              {t(`settings.nutanix.step.${step}`)}
            </li>
          ))}
        </ol>
        {phase === "failed" && <p role="alert" className="whitespace-pre-wrap text-[12px] leading-4 text-danger">{status.deploy?.error}</p>}
      </div>
    );
  } else if (server) {
    body = (
      <div className="flex flex-col gap-2">
        <Value label={t("settings.nutanix.server")} value={server.ip ? `${server.name} · ${server.ip}` : server.name} />
        <p className="text-[13px] leading-[18px] text-ink-secondary">{t("settings.nutanix.everyBot")}</p>
        <p className="text-[12px] leading-4 text-ink-tertiary">{t("settings.nutanix.sleeps")}</p>
        {server.ready && !server.needsCheck && <NutanixDesktopLinks consoleUrl={server.consoleUrl ?? null} />}
      </div>
    );
  } else {
    body = (
      <>
        {phase === "failed" && <p role="alert" className="whitespace-pre-wrap text-[12px] leading-4 text-danger">{status.deploy?.error}</p>}
        <ChooseAndDeploy status={status} onStarted={update} />
      </>
    );
  }

  return (
    <SettingsDialog title={t("settings.nutanix.title")} onClose={onClose}
      footer={!status.pc || reconnect ? undefined : <>
        {!working && <button type="button" className={server && !server.needsCheck ? "ui-button" : "ui-button me-auto"} onClick={() => setReconnect(true)}>{t(server ? "settings.nutanix.reconnect" : "settings.nutanix.change")}</button>}
        {server && !server.needsCheck && !working && <button type="button" className="ui-button me-auto" disabled={busy} onClick={() => setConfirmDelete(true)}>{t("settings.nutanix.delete")}</button>}
        <button type="button" className="ui-button" onClick={onClose}>{t("common.close")}</button>
      </>}>
      {status.pc && !reconnect && (
        <div className="flex flex-col gap-1">
          <Value label={t("settings.nutanix.pc")} value={status.pc.version ? `${status.pc.address} · ${status.pc.version}` : status.pc.address} />
          <Value label={t("settings.nutanix.certificate")} value={status.pc.fingerprint} />
        </div>
      )}
      {body}
      {checkNote && <p role="status" className="text-[12px] leading-4 text-ink-secondary">{checkNote}</p>}
      {error && <p role="alert" className="text-[12px] leading-4 text-danger">{error}</p>}
      <ConfirmDialog open={confirmDelete} title={t("settings.nutanix.deleteTitle")} body={t("settings.nutanix.deleteBody", { name: server?.name ?? "" })}
        confirmLabel={t("settings.nutanix.deleteConfirm")} pending={busy} onCancel={() => setConfirmDelete(false)} onConfirm={() => remove(false)} />
    </SettingsDialog>
  );
}
