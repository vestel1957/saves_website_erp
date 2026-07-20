"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/Icon";
import { PageHeading } from "@/components/ui/PageHeading";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { MikrotikRouterModal } from "@/components/network/MikrotikRouterModal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import type { MkRouter, MkMode, MkBranch } from "@/lib/mikrotik";

export default function MikrotikPanelPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const nav = useRouter();
  const [mode, setMode] = useState<MkMode | null>(null);
  const [routers, setRouters] = useState<MkRouter[]>([]);
  const [branches, setBranches] = useState<MkBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [modal, setModal] = useState<{ router: MkRouter | null } | null>(null);
  const [toDelete, setToDelete] = useState<MkRouter | null>(null);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, r, b] = await Promise.all([
        authFetch("/network/mikrotik/mode").then((x) => x.json()),
        authFetch("/network/mikrotik/routers").then((x) => x.json()),
        authFetch("/network/mikrotik/branches").then((x) => x.json()),
      ]);
      setMode(m); setRouters(Array.isArray(r) ? r : []); setBranches(Array.isArray(b) ? b : []);
    } finally {
      setLoading(false);
    }
  }, [authFetch]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  const test = useCallback(async (r: MkRouter): Promise<boolean> => {
    setTesting(r.id);
    try {
      const res = await authFetch(`/network/mikrotik/${r.id}/test`, { method: "POST" }).then((x) => x.json());
      if (res.ok) toast(`${r.name}: conexión OK${res.identity ? ` (${res.identity})` : ""}`, "check");
      else toast(`${r.name}: ${res.error || "sin conexión"}`, "x");
      setRouters((prev) => prev.map((x) => (x.id === r.id ? { ...x, online: !!res.ok } : x)));
      return !!res.ok;
    } catch {
      toast("Error probando la conexión", "x");
      return false;
    } finally {
      setTesting(null);
    }
  }, [authFetch]);

  // "Validar Conexion de Todas las Mikrotiks" — secuencial, como el legacy.
  const testAll = async () => {
    setTestingAll(true);
    try {
      for (const r of routers) await test(r);
      toast("Validación de todas las Mikrotiks completada", "check");
    } finally {
      setTestingAll(false);
    }
  };

  const setDefault = async (r: MkRouter) => {
    const res = await authFetch(`/network/mikrotik/routers/${r.id}/default`, { method: "POST" }).then((x) => x.json());
    if (res.ok) { toast(`${r.name} marcado por defecto de la sede`, "check"); void load(); }
    else toast("No se pudo marcar por defecto", "x");
  };

  const remove = async () => {
    if (!toDelete) return;
    setDeleting(true);
    try {
      const res = await authFetch(`/network/mikrotik/routers/${toDelete.id}`, { method: "DELETE" }).then((x) => x.json());
      if (res.ok) { toast("Mikrotik eliminado", "check"); void load(); }
      else toast("No se pudo eliminar", "x");
      setToDelete(null);
    } finally {
      setDeleting(false);
    }
  };

  if (authLoading || (loading && !routers.length)) return <PageSkeleton />;

  const online = routers.filter((r) => r.online).length;

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <PageHeading
          icon="router"
          title="Gestión Mikrotik"
          subtitle={`${routers.length} router(es) · ${online} en línea · ${new Set(routers.map((r) => r.sedeLegacy)).size} sede(s)`}
        />
        <div className="flex items-center gap-2">
          {mode && <Badge label={mode.live ? "MODO LIVE" : "DRY-RUN (simulación)"} tone={mode.live ? "error" : "info"} />}
          <Button variant="secondary" disabled={testingAll || !routers.length} onClick={testAll}>
            <Icon name={testingAll ? "loader" : "zap"} size={15} className={`mr-1 ${testingAll ? "animate-spin" : ""}`} />
            {testingAll ? "Validando…" : "Validar todas"}
          </Button>
          <Button onClick={() => setModal({ router: null })}><Icon name="plus" size={15} className="mr-1" />Agregar Mikrotik</Button>
        </div>
      </div>

      <DataTable
        rows={routers}
        empty="No hay Mikrotiks registrados. Pulse «Agregar Mikrotik» para crear el primero."
        onRowClick={(r) => nav.push(`/mikrotik/${r.id}`)}
        columns={[
          { key: "name", header: "Nombre", render: (r) => (
            <span className="flex items-center gap-1.5 font-medium text-text-primary">
              <Icon name="router" size={14} className="text-brand" />
              {r.name}
              {r.isDefault && r.sedeRouters > 1 && <Icon name="flag" size={13} className="text-success-text" />}
            </span>
          ) },
          { key: "ip", header: "IP:Puerto", render: (r) => <span className="font-mono text-text-secondary">{r.ip}:{r.port}</span> },
          { key: "tech", header: "Tecnología", render: (r) => r.tech || "—" },
          { key: "branch", header: "Sede", render: (r) => r.branch ?? "—" },
          { key: "user", header: "Usuario", render: (r) => <span className="font-mono text-[12px] text-text-tertiary">{r.username || "—"}</span> },
          { key: "st", header: "Estado", render: (r) => <Badge label={r.online ? "En línea" : "Desconocido"} tone={r.online ? "success" : "default"} /> },
          { key: "acc", header: "Acciones", align: "right", render: (r) => (
            <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
              <button title="Probar conexión" disabled={testing === r.id} onClick={() => test(r)}
                className="rounded p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-brand disabled:opacity-50">
                <Icon name={testing === r.id ? "loader" : "zap"} size={15} className={testing === r.id ? "animate-spin" : ""} />
              </button>
              <button title="Operar" onClick={() => nav.push(`/mikrotik/${r.id}`)}
                className="rounded p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-brand"><Icon name="settings" size={15} /></button>
              {r.sedeRouters > 1 && !r.isDefault && (
                <button title="Marcar por defecto de la sede" onClick={() => setDefault(r)}
                  className="rounded p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-success-text"><Icon name="flag" size={15} /></button>
              )}
              <button title="Editar" onClick={() => setModal({ router: r })}
                className="rounded p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-brand"><Icon name="pencil" size={15} /></button>
              <button title="Eliminar" onClick={() => setToDelete(r)}
                className="rounded p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-error-text"><Icon name="trash" size={15} /></button>
            </div>
          ) },
        ]}
      />

      {modal && (
        <MikrotikRouterModal open onClose={() => setModal(null)} onSaved={load} router={modal.router} branches={branches} />
      )}

      <ConfirmDialog
        open={!!toDelete}
        title="Eliminar Mikrotik"
        message={<>¿Eliminar el Mikrotik <b className="text-text-primary">{toDelete?.name}</b> ({toDelete?.ip}:{toDelete?.port})? Esta acción no se puede deshacer.</>}
        confirmLabel="Eliminar"
        icon="trash"
        busy={deleting}
        onConfirm={remove}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}
