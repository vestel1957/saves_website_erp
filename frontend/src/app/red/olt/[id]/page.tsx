"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/accounting/PageHeading";
import { DataTable } from "@/components/inventory/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { AutenticarOnuModal } from "@/components/network/AutenticarOnuModal";
import { rxTone, runTone } from "@/lib/olt";
import type { OltRow, OltMode, Board, LiveOnu, AutofindOnu, SystemInfo, OltLog } from "@/lib/olt";

type Tab = "resumen" | "tableros" | "onus" | "autofind" | "buscar" | "sync" | "historial";
const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: "resumen", label: "Resumen", icon: "router" },
  { key: "tableros", label: "Tableros", icon: "layers" },
  { key: "onus", label: "ONUs por puerto", icon: "wand-sparkles" },
  { key: "autofind", label: "Autofind", icon: "search" },
  { key: "buscar", label: "Buscar SN", icon: "search" },
  { key: "sync", label: "Sincronizar", icon: "refresh-cw" },
  { key: "historial", label: "Historial", icon: "clock" },
];

function parseFsp(fsp: string): { frame: number; slot: number; port: number } {
  const [f, s, p] = (fsp || "0/0/0").split("/").map((x) => Number(x) || 0);
  return { frame: f, slot: s, port: p };
}

export default function OperarOltPage() {
  const { id } = useParams<{ id: string }>();
  const { loading: authLoading, authFetch } = useAuth();
  const [olt, setOlt] = useState<OltRow | null>(null);
  const [mode, setMode] = useState<OltMode | null>(null);
  const [tab, setTab] = useState<Tab>("resumen");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>("");

  // Datos por pestaña
  const [sys, setSys] = useState<SystemInfo | null>(null);
  const [boards, setBoards] = useState<Board[] | null>(null);
  const [onus, setOnus] = useState<LiveOnu[] | null>(null);
  const [onuForm, setOnuForm] = useState({ frame: "0", slot: "", port: "" });
  const [autofind, setAutofind] = useState<AutofindOnu[] | null>(null);
  const [snQuery, setSnQuery] = useState("");
  const [snResult, setSnResult] = useState<Record<string, unknown> | null>(null);
  const [syncSlot, setSyncSlot] = useState("");
  const [syncMsg, setSyncMsg] = useState("");
  const [history, setHistory] = useState<OltLog[]>([]);

  // Modal autenticar
  const [authModal, setAuthModal] = useState<{ sn?: string; frame?: string; slot?: string; port?: string } | null>(null);

  const live = !!mode?.live;

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/network/olt/mode").then((r) => r.json()).then(setMode).catch(() => {});
    void authFetch("/network/olt/olts").then((r) => r.json()).then((list: OltRow[]) => setOlt(list.find((o) => o.id === id) ?? null)).catch(() => {});
  }, [authLoading, authFetch, id]);

  // Cargar automáticamente lecturas ligeras al abrir su pestaña.
  const loadSystem = useCallback(async () => {
    setBusy(true); setErr("");
    try { const r = await authFetch(`/network/olt/${id}/system`).then((x) => x.json()); setSys(r.info ?? null); if (!r.ok) setErr(r.error || "Sin respuesta del equipo."); }
    finally { setBusy(false); }
  }, [authFetch, id]);

  const loadBoards = useCallback(async () => {
    setBusy(true); setErr("");
    try { const r = await authFetch(`/network/olt/${id}/boards`).then((x) => x.json()); setBoards(r.boards ?? []); if (!r.ok) setErr(r.error || "Sin respuesta del equipo."); }
    finally { setBusy(false); }
  }, [authFetch, id]);

  const loadAutofind = useCallback(async () => {
    setBusy(true); setErr("");
    try { const r = await authFetch(`/network/olt/${id}/autofind`).then((x) => x.json()); setAutofind(r.onus ?? []); if (!r.ok) setErr(r.error || "Sin respuesta del equipo."); }
    finally { setBusy(false); }
  }, [authFetch, id]);

  const loadHistory = useCallback(async () => {
    const r = await authFetch(`/network/olt/history?oltId=${id}&limit=100`).then((x) => x.json());
    setHistory(Array.isArray(r) ? r : []);
  }, [authFetch, id]);

  useEffect(() => {
    if (!olt) return;
    if (tab === "resumen" && sys === null) void loadSystem();
    if (tab === "tableros" && boards === null) void loadBoards();
    if (tab === "autofind" && autofind === null) void loadAutofind();
    if (tab === "historial") void loadHistory();
  }, [tab, olt]); // eslint-disable-line react-hooks/exhaustive-deps

  const listOnus = async (frame: string, slot: string, port: string) => {
    if (slot === "" || port === "") { toast("Indique slot y puerto", "x"); return; }
    setOnuForm({ frame, slot, port });
    setBusy(true); setErr("");
    try {
      const r = await authFetch(`/network/olt/${id}/onus`, { method: "POST", body: JSON.stringify({ frame: Number(frame) || 0, slot, port }) }).then((x) => x.json());
      setOnus(r.onus ?? []);
      if (!r.ok) setErr(r.error || "Sin respuesta del equipo.");
    } finally { setBusy(false); }
  };

  const onuAction = async (action: "reboot" | "delete", o: LiveOnu) => {
    const { frame, slot, port } = parseFsp(o.fsp);
    if (live && !confirm(`¿Confirmar ${action === "delete" ? "ELIMINAR" : "reiniciar"} la ONU ${o.fsp}:${o.ont_id} (SN ${o.sn}) en la OLT REAL?`)) return;
    setBusy(true);
    try {
      const r = await authFetch(`/network/olt/${id}/onu/${action}`, {
        method: "POST", body: JSON.stringify({ frame, slot, port, ont_id: o.ont_id, sn: o.sn }),
      }).then((x) => x.json());
      if (r.ok) toast(r.dryRun ? `Plan generado (dry-run): ${(r.commands || []).join(" · ")}` : (r.message || "OK"), "check");
      else toast(r.error || "Error", "x");
    } finally { setBusy(false); }
  };

  const detalle = async (o: LiveOnu) => {
    const { frame, slot, port } = parseFsp(o.fsp);
    setBusy(true);
    try {
      const r = await authFetch(`/network/olt/${id}/onu/detail`, { method: "POST", body: JSON.stringify({ frame, slot, port, ont_id: o.ont_id }) }).then((x) => x.json());
      setSnResult(r.ok ? (r.detail ?? {}) : { error: r.error });
    } finally { setBusy(false); }
  };

  const buscarSn = async () => {
    if (!snQuery.trim()) return;
    setBusy(true); setSnResult(null);
    try {
      const r = await authFetch(`/network/olt/${id}/onu/find`, { method: "POST", body: JSON.stringify({ sn: snQuery.trim() }) }).then((x) => x.json());
      setSnResult(r.ok ? (r.onu ?? {}) : { error: r.error });
    } finally { setBusy(false); }
  };

  const doSync = async () => {
    if (syncSlot === "") { toast("Indique el slot", "x"); return; }
    setBusy(true); setSyncMsg("");
    try {
      const r = await authFetch(`/network/olt/${id}/sync`, { method: "POST", body: JSON.stringify({ frame: 0, slot: syncSlot }) }).then((x) => x.json());
      if (r.ok) { setSyncMsg(`Sincronizadas ${r.synced} ONUs del slot ${syncSlot} al inventario.`); toast(`Sync OK: ${r.synced} ONUs`, "check"); }
      else { setSyncMsg(r.error || "Error de sincronización."); toast(r.error || "Error", "x"); }
    } finally { setBusy(false); }
  };

  if (authLoading || !olt) return <PageSkeleton />;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-col items-start gap-1">
          <PageHeading icon="radio-tower" title={`OLT ${olt.name}`} />
          <h1 className="flex items-center gap-1.5 text-[16px] font-bold text-text-primary">
            <Icon name="radio-tower" size={17} className="text-brand" />OLT {olt.name}
          </h1>
        </div>
        <div className="flex items-center gap-2 text-[12px] text-text-tertiary">
          <span className="font-mono">{olt.brand} · {olt.ip}:{olt.port}</span>
          {mode && <Badge label={live ? "MODO LIVE" : "DRY-RUN"} tone={live ? "error" : "info"} />}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-1 border-b border-border-subtle">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 rounded-t-md px-3 py-2 text-[13px] font-medium ${tab === t.key ? "border-b-2 border-brand text-brand" : "text-text-tertiary hover:text-text-secondary"}`}>
            <Icon name={t.icon} size={14} />{t.label}
          </button>
        ))}
      </div>

      {err && <div className="mb-3 rounded-lg border border-border-subtle bg-error-soft p-2 text-[12px] text-error-text">{err}</div>}
      {busy && <div className="mb-2 flex items-center gap-2 text-[12px] text-text-tertiary"><Icon name="loader" size={14} className="animate-spin" />Consultando la OLT por SSH…</div>}

      {/* RESUMEN */}
      {tab === "resumen" && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[["Modelo", sys?.model], ["Versión", sys?.version], ["Parche", sys?.patch], ["Uptime", sys?.uptime]].map(([k, v]) => (
            <div key={k} className="rounded-xl border border-border-subtle bg-surface p-3">
              <div className="text-[11px] text-text-tertiary">{k}</div>
              <div className="mt-0.5 truncate font-mono text-[13px] text-text-primary">{v || "—"}</div>
            </div>
          ))}
          <div className="col-span-2 sm:col-span-4"><Button variant="secondary" onClick={loadSystem}><Icon name="refresh-cw" size={14} className="mr-1" />Refrescar</Button></div>
        </div>
      )}

      {/* TABLEROS */}
      {tab === "tableros" && (
        <>
          <div className="mb-2"><Button variant="secondary" onClick={loadBoards}><Icon name="refresh-cw" size={14} className="mr-1" />Refrescar tableros</Button></div>
          <DataTable rows={boards ?? []} empty="No se leyeron tableros." columns={[
            { key: "slot", header: "Slot", render: (b) => <span className="font-mono">{b.slot}</span> },
            { key: "board", header: "Tarjeta", render: (b) => b.board },
            { key: "status", header: "Estado", render: (b) => <Badge label={b.status} tone={/normal/i.test(b.status) ? "success" : "default"} /> },
            { key: "tipo", header: "Tipo", render: (b) => b.gpon ? <Badge label="GPON" tone="brand" /> : b.epon ? <Badge label="EPON" tone="info" /> : "—" },
            { key: "acc", header: "", render: (b) => b.gpon ? <Button size="sm" variant="secondary" onClick={() => { setTab("onus"); void listOnus("0", b.slot, "0"); }}>Ver ONUs →</Button> : null },
          ]} />
        </>
      )}

      {/* ONUs POR PUERTO */}
      {tab === "onus" && (
        <>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <label className="text-[12px] text-text-secondary">Frame<Input value={onuForm.frame} onChange={(e) => setOnuForm((f) => ({ ...f, frame: e.target.value }))} className="mt-0.5 w-20" /></label>
            <label className="text-[12px] text-text-secondary">Slot<Input value={onuForm.slot} onChange={(e) => setOnuForm((f) => ({ ...f, slot: e.target.value }))} className="mt-0.5 w-20" /></label>
            <label className="text-[12px] text-text-secondary">Puerto<Input value={onuForm.port} onChange={(e) => setOnuForm((f) => ({ ...f, port: e.target.value }))} className="mt-0.5 w-20" /></label>
            <Button onClick={() => listOnus(onuForm.frame, onuForm.slot, onuForm.port)}><Icon name="search" size={14} className="mr-1" />Listar ONUs</Button>
          </div>
          <DataTable rows={onus ?? []} empty="Indique slot/puerto y liste las ONUs." columns={[
            { key: "ont", header: "ONT", render: (o) => <span className="font-mono">{o.fsp}:{o.ont_id}</span> },
            { key: "sn", header: "Serial", render: (o) => <span className="font-mono text-text-secondary">{o.sn}</span> },
            { key: "run", header: "Estado", render: (o) => <Badge label={o.run_state} tone={runTone(o.run_state)} /> },
            { key: "cfg", header: "Config", render: (o) => o.config_state },
            { key: "rx", header: "RX (dBm)", render: (o) => <Badge label={o.rx_power || "—"} tone={rxTone(o.rx_power)} /> },
            { key: "acc", header: "Acciones", render: (o) => (
              <div className="flex gap-1">
                <button title="Detalle" onClick={() => detalle(o)} className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-brand"><Icon name="eye" size={15} /></button>
                <button title="Reiniciar" onClick={() => onuAction("reboot", o)} className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-warning-text"><Icon name="rotate-cw" size={15} /></button>
                <button title="Eliminar" onClick={() => onuAction("delete", o)} className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-error-text"><Icon name="trash" size={15} /></button>
              </div>
            ) },
          ]} />
          {snResult && <DetalleBox data={snResult} onClose={() => setSnResult(null)} />}
        </>
      )}

      {/* AUTOFIND */}
      {tab === "autofind" && (
        <>
          <div className="mb-2 flex items-center justify-between gap-2">
            <p className="text-[12px] text-text-tertiary">ONUs detectadas sin aprovisionar. Pulse <b>Autenticar</b> para darlas de alta.</p>
            <Button variant="secondary" onClick={loadAutofind}><Icon name="refresh-cw" size={14} className="mr-1" />Buscar</Button>
          </div>
          <DataTable rows={autofind ?? []} empty="No hay ONUs esperando autenticación." columns={[
            { key: "sn", header: "Serial (SN)", render: (o) => <span className="font-mono text-text-secondary">{o.sn}</span> },
            { key: "fsp", header: "F/S/P", render: (o) => <span className="font-mono">{o.fsp || "—"}</span> },
            { key: "loid", header: "LOID", render: (o) => o.loid || "—" },
            { key: "acc", header: "", render: (o) => {
              const { frame, slot, port } = parseFsp(o.fsp);
              return <Button size="sm" onClick={() => setAuthModal({ sn: o.sn, frame: String(frame), slot: o.fsp ? String(slot) : "", port: o.fsp ? String(port) : "" })}><Icon name="wand-sparkles" size={14} className="mr-1" />Autenticar</Button>;
            } },
          ]} />
        </>
      )}

      {/* BUSCAR SN */}
      {tab === "buscar" && (
        <div className="max-w-xl">
          <div className="mb-3 flex gap-2">
            <Input value={snQuery} onChange={(e) => setSnQuery(e.target.value)} placeholder="Serial de la ONU (SN)…" className="font-mono" onKeyDown={(e) => e.key === "Enter" && buscarSn()} />
            <Button onClick={buscarSn}><Icon name="search" size={14} className="mr-1" />Buscar</Button>
          </div>
          {snResult && <DetalleBox data={snResult} onClose={() => setSnResult(null)} />}
        </div>
      )}

      {/* SYNC */}
      {tab === "sync" && (
        <div className="max-w-xl">
          <p className="mb-2 text-[12px] text-text-tertiary">Recorre los puertos del slot indicado y actualiza el inventario local de ONUs (visible en <Link href="/red/onus" className="text-brand hover:underline">Inventario</Link>).</p>
          <div className="flex items-end gap-2">
            <label className="text-[12px] text-text-secondary">Slot GPON<Input value={syncSlot} onChange={(e) => setSyncSlot(e.target.value)} className="mt-0.5 w-24" /></label>
            <Button onClick={doSync}><Icon name="refresh-cw" size={14} className="mr-1" />Sincronizar slot</Button>
          </div>
          {syncMsg && <div className="mt-3 rounded-lg border border-border-subtle bg-surface-2 p-2 text-[12px]">{syncMsg}</div>}
        </div>
      )}

      {/* HISTORIAL */}
      {tab === "historial" && (
        <DataTable rows={history} empty="Sin acciones registradas." columns={[
          { key: "date", header: "Fecha", render: (l) => new Date(l.createdAt).toLocaleString("es-CO") },
          { key: "action", header: "Acción", render: (l) => <Badge label={l.action} tone={l.ok ? "success" : "error"} /> },
          { key: "mode", header: "Modo", render: (l) => <Badge label={l.dryRun ? "dry-run" : "live"} tone={l.dryRun ? "info" : "warning"} /> },
          { key: "sn", header: "ONU", render: (l) => <span className="font-mono text-[12px]">{l.sn || l.fsp || "—"}</span> },
          { key: "detail", header: "Detalle", render: (l) => <span className="text-[12px] text-text-tertiary">{l.detail}</span> },
          { key: "user", header: "Usuario", render: (l) => l.userName || "—" },
        ]} />
      )}

      {authModal && (
        <AutenticarOnuModal open onClose={() => setAuthModal(null)} oltId={id} olt={olt} live={live}
          preset={authModal} onDone={() => { if (tab === "autofind") void loadAutofind(); }} />
      )}
    </>
  );
}

function DetalleBox({ data, onClose }: { data: Record<string, unknown>; onClose: () => void }) {
  const entries = Object.entries(data).filter(([, v]) => typeof v !== "object");
  return (
    <div className="mt-3 rounded-xl border border-border-subtle bg-surface p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[13px] font-semibold text-text-primary">Detalle de ONU</span>
        <button onClick={onClose} className="text-text-tertiary hover:text-text-primary"><Icon name="x" size={15} /></button>
      </div>
      {data.error ? <p className="text-[12px] text-error-text">{String(data.error)}</p> : (
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-[12px] sm:grid-cols-3">
          {entries.map(([k, v]) => (
            <div key={k} className="flex justify-between gap-2 border-b border-border-subtle py-0.5">
              <span className="text-text-tertiary">{k}</span>
              <span className="truncate font-mono text-text-primary">{String(v)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
