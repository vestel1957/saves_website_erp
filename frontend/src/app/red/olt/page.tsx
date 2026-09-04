"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { PagedTable } from "@/components/ui/PagedTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { OltEditModal } from "@/components/network/OltEditModal";
import type { OltRow, OltDashboard, OltMode } from "@/lib/olt";

function Kpi({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-3">
      <div className={`text-2xl font-bold ${tone ?? "text-text-primary"}`}>{value.toLocaleString("es-CO")}</div>
      <div className="text-[12px] text-text-tertiary">{label}</div>
    </div>
  );
}

export default function OltPanelPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const nav = useRouter();
  const [mode, setMode] = useState<OltMode | null>(null);
  const [dash, setDash] = useState<OltDashboard | null>(null);
  const [olts, setOlts] = useState<OltRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);
  const [editOlt, setEditOlt] = useState<OltRow | null>(null);
  /** El modal se abre con `editOlt = null` para dar de alta, y con una fila para editar.
   *  Hace falta un estado aparte porque "null" ya significaba "cerrado". */
  const [modalAbierto, setModalAbierto] = useState(false);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, d, o] = await Promise.all([
        authFetch("/network/olt/mode").then((r) => r.json()),
        authFetch("/network/olt/dashboard").then((r) => r.json()),
        authFetch("/network/olt/olts").then((r) => r.json()),
      ]);
      setMode(m); setDash(d); setOlts(o);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  const test = async (o: OltRow) => {
    setTesting(o.id);
    try {
      const r = await authFetch(`/network/olt/${o.id}/test`, { method: "POST" }).then((x) => x.json());
      if (r.ok) { toast(`${o.name}: conexión OK`, "check"); }
      else { toast(`${o.name}: ${r.error || "sin conexión"}`, "x"); }
      setOlts((prev) => prev.map((x) => (x.id === o.id ? { ...x, online: !!r.ok } : x)));
    } catch {
      toast("Error probando la conexión", "x");
    } finally {
      setTesting(null);
    }
  };

  // Filtro en cliente sobre lo ya cargado (nombre, marca, tecnología, IP, sede).
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return olts;
    return olts.filter((o) =>
      [o.name, o.brand, o.tech, o.ip, o.branch].some((v) => (v ?? "").toLowerCase().includes(q)),
    );
  }, [olts, search]);

  if (authLoading || (loading && !dash)) return <PageSkeleton />;

  return (
    <>
      <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading icon="router" title="Gestión OLT" />
        <div className="flex items-center gap-2">
          {mode && (
            <Badge label={mode.live ? "MODO LIVE" : "DRY-RUN (simulación)"} tone={mode.live ? "error" : "info"} />
          )}
          <Link href="/red/onus"><Button variant="secondary"><Icon name="wand-sparkles" size={15} className="mr-1" />Inventario de ONUs</Button></Link>
          <Button onClick={() => { setEditOlt(null); setModalAbierto(true); }}>
            <Icon name="plus" size={15} className="mr-1" />Nueva OLT
          </Button>
        </div>
      </div>

      {dash && (
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          <Kpi label="ONUs totales" value={dash.total} />
          <Kpi label="Online" value={dash.online} tone="text-success-text" />
          <Kpi label="Offline" value={dash.offline} tone="text-error-text" />
          <Kpi label="Señal débil" value={dash.debil} tone="text-warning-text" />
          <Kpi label="Señal crítica" value={dash.critica} tone="text-error-text" />
          <Kpi label="Sin cliente" value={dash.sinCliente} tone="text-text-secondary" />
        </div>
      )}

      <ListToolbar search={search} onSearch={setSearch} searchPlaceholder="Buscar por nombre, marca, IP o sede…" />

      <PagedTable
        rows={shown}
        empty={search ? "Ninguna OLT coincide con la búsqueda." : "No hay OLTs registradas. Use «Nueva OLT» para dar de alta un equipo."}
        rowHref={(o) => `/red/olt/${o.id}`}
        columns={[
          { key: "name", header: "Nombre", render: (o) => (
            <span className="flex items-center gap-1.5 font-medium text-text-primary">
              <Icon name="radio-tower" size={14} className="text-brand" />
              {o.name}
              {o.isDefault && <Icon name="flag" size={13} className="text-success-text" />}
            </span>
          ) },
          { key: "brand", header: "Marca / Tec.", render: (o) => <span className="text-text-secondary">{o.brand} · {o.tech}</span> },
          { key: "ip", header: "IP:Puerto", render: (o) => (
            <span className="font-mono text-text-secondary">
              {o.ip}:{o.port}
              {/* El transporte se ve en la lista: un "sin conexión" se explica muchas
                  veces porque el equipo habla telnet y la ficha dice SSH. */}
              <span className="ml-1.5 font-sans text-[11px] uppercase text-text-tertiary">{o.transport}</span>
            </span>
          ) },
          { key: "branch", header: "Sede", render: (o) => o.branch ?? "—" },
          { key: "onus", header: "ONUs", align: "right", render: (o) => o.onus.toLocaleString("es-CO") },
          { key: "online", header: "Online", align: "right", render: (o) => <span className="text-success-text">{(dash?.porOlt.find((p) => p.oltId === o.id)?.online ?? 0).toLocaleString("es-CO")}</span> },
          { key: "critica", header: "Críticas", align: "right", render: (o) => <span className="text-error-text">{(dash?.porOlt.find((p) => p.oltId === o.id)?.critica ?? 0).toLocaleString("es-CO")}</span> },
          { key: "st", header: "Estado", render: (o) => <Badge label={o.online ? "En línea" : "Desconocido"} tone={o.online ? "success" : "default"} /> },
          { key: "acc", header: "Acciones", align: "right", render: (o) => (
            <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
              <button title="Probar conexión" disabled={testing === o.id} onClick={() => test(o)}
                className="tap rounded p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-brand disabled:opacity-50">
                <Icon name={testing === o.id ? "loader" : "zap"} size={15} className={testing === o.id ? "animate-spin" : ""} />
              </button>
              <button title="Editar / configurar defaults" onClick={() => { setEditOlt(o); setModalAbierto(true); }}
                className="tap rounded p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-brand"><Icon name="pencil" size={15} /></button>
              <button title="Operar" onClick={() => nav.push(`/red/olt/${o.id}`)}
                className="tap rounded p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-brand"><Icon name="play" size={15} /></button>
            </div>
          ) },
        ]}
      />

      <OltEditModal
        open={modalAbierto}
        onClose={() => { setModalAbierto(false); setEditOlt(null); }}
        onSaved={load}
        olt={editOlt}
        brands={mode?.brands ?? ["Huawei", "ZTE", "Fiberhome", "V-SOL", "BDCOM", "Otra"]}
      />
    </>
  );
}
