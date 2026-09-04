"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Input, Select, Field } from "@/components/ui/Field";
import { Combobox, type ComboItem } from "@/components/ui/Combobox";
import { DataTable } from "@/components/ui/DataTable";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { Modal } from "@/components/Modal";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import type { Vlan, BranchOpt } from "@/lib/network";
import { listaJson, mensajeDeError } from "@/lib/errores";

type Draft = { branchId: string; vlan: string; detail: string; olt: string; tray: string; oltPort: string };

const EMPTY: Draft = { branchId: "", vlan: "", detail: "", olt: "", tray: "", oltPort: "" };

/**
 * Clave con la que se agrupa un texto del legacy: en mayúsculas y sin espacios
 * de sobra. Sin esto "Rosales" y "ROSALES" son dos opciones distintas del mismo
 * barrio. Es la misma normalización que hace Postgres en `/network/nap-addresses`.
 */
const norm = (t: string) => t.trim().toUpperCase();

/**
 * Administración de VLANs (legacy `vlans`). Es el catálogo del que tira el alta
 * de caja NAP: hasta ahora sólo se podían ELEGIR las 153 importadas del legacy,
 * no crear una nueva. Ojo: esta tabla NO viaja en el sync con el legacy (igual
 * que NAPs y puertos), así que lo que se cree aquí vive sólo en nexus.
 */
export default function VlansPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [vlans, setVlans] = useState<Vlan[] | null>(null);
  const [branches, setBranches] = useState<BranchOpt[]>([]);
  const [err, setErr] = useState(false);
  const [search, setSearch] = useState("");
  const [branchId, setBranchId] = useState("");
  const [detalle, setDetalle] = useState("");
  const [olt, setOlt] = useState("");
  const [editing, setEditing] = useState<Vlan | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [confirmar, setConfirmar] = useState<Vlan | null>(null);
  const [borrando, setBorrando] = useState(false);

  const load = useCallback(() => {
    setErr(false);
    void authFetch("/network/vlans").then(listaJson).then(setVlans).catch(() => setErr(true));
  }, [authFetch]);

  useEffect(() => {
    if (authLoading) return;
    load();
    void authFetch("/network/branches").then(listaJson).then(setBranches).catch(() => setBranches([]));
  }, [authLoading, load, authFetch]);

  // Las 153 caben en memoria: el filtro va en el cliente (el endpoint no pagina
  // ni busca) y así el buscador responde sin viaje al servidor.

  /** VLANs de la sede elegida: la base de la que salen las demás opciones. */
  const deLaSede = useMemo(
    () => (vlans ?? []).filter((v) => !branchId || v.branchId === branchId),
    [vlans, branchId],
  );

  // El detalle de la VLAN es el BARRIO, y viene del legacy escrito de varias
  // formas (mayúsculas y espacios sueltos). Se agrupa normalizado, igual que las
  // direcciones de las NAPs, para que un barrio sea UNA opción y no tres.
  const barrios = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of deLaSede) {
      const k = norm(v.detail);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [deLaSede]);

  const itemsBarrio = useMemo<ComboItem[]>(
    () => [
      { value: "", label: "Todos los barrios" },
      ...barrios.map(([value, n]) => ({ value, label: value, sublabel: `${n} VLAN${n === 1 ? "" : "s"}` })),
    ],
    [barrios],
  );

  /** OLTs presentes, más la opción de pescar las que no tienen ninguna puesta. */
  const olts = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of deLaSede) {
      const k = norm(v.olt ?? "");
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [deLaSede]);

  const filtradas = useMemo(() => {
    const q = search.trim().toLowerCase();
    return deLaSede.filter((v) =>
      (!detalle || norm(v.detail) === detalle) &&
      (!olt || (olt === "none" ? !norm(v.olt ?? "") : norm(v.olt ?? "") === olt)) &&
      (!q || String(v.vlan).includes(q) || v.detail.toLowerCase().includes(q) || (v.olt ?? "").toLowerCase().includes(q) || (v.branch ?? "").toLowerCase().includes(q)),
    );
  }, [deLaSede, search, detalle, olt]);

  const filtrosActivos = useMemo(
    () => [branchId, detalle, olt].filter(Boolean).length + (search.trim() ? 1 : 0),
    [branchId, detalle, olt, search],
  );

  function limpiar() {
    setSearch(""); setBranchId(""); setDetalle(""); setOlt("");
  }

  // Cambiar de sede invalida barrio y OLT: son opciones de la sede anterior y
  // dejarían el listado vacío sin que se vea por qué.
  useEffect(() => { setDetalle(""); setOlt(""); }, [branchId]);

  function openNew() {
    setEditing(null);
    // Si hay una sede filtrada, la nueva VLAN nace ahí: es lo que se está mirando.
    setDraft({ ...EMPTY, branchId: branchId || branches[0]?.id || "" });
  }

  function openEdit(v: Vlan) {
    setEditing(v);
    setDraft({
      branchId: v.branchId ?? "", vlan: String(v.vlan), detail: v.detail,
      olt: v.olt ?? "", tray: v.tray != null ? String(v.tray) : "", oltPort: v.oltPort != null ? String(v.oltPort) : "",
    });
  }

  async function remove(v: Vlan) {
    setBorrando(true);
    try {
      const res = await authFetch(`/network/vlans/${v.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo eliminar la VLAN");
      toast(`VLAN ${v.vlan} eliminada`, "check");
      load();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo eliminar la VLAN"), "alert-circle");
    } finally {
      setBorrando(false);
      setConfirmar(null);
    }
  }

  if (authLoading || (!vlans && !err)) return <PageSkeleton />;

  const total = vlans?.length ?? 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <PageHeading
          icon="network"
          title="VLANs"
          subtitle="Catálogo de VLANs por sede. De aquí salen las opciones al crear una caja NAP; una VLAN con NAPs colgando no se puede eliminar."
        />
        <Button onClick={openNew}><Icon name="plus" size={15} /> Nueva VLAN</Button>
      </div>

      {err && !vlans ? (
        <LoadError message="No se pudieron cargar las VLANs." onRetry={load} />
      ) : (
        <>
          <ListToolbar
            search={search}
            onSearch={setSearch}
            searchPlaceholder="Buscar por VLAN, detalle, OLT o sede…"
            actions={filtrosActivos > 0 ? (
              <Button variant="ghost" size="sm" onClick={limpiar} title="Quitar todos los filtros">
                <Icon name="x" size={14} /> Limpiar ({filtrosActivos})
              </Button>
            ) : undefined}
          >
            <Select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="w-full sm:w-44" aria-label="Filtrar por sede">
              <option value="">Todas las sedes</option>
              {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
            {/* El detalle ES el barrio: en combobox porque son ~100 y lo que se
                hace es teclear tres letras, no bajar por la lista. */}
            <Combobox
              items={itemsBarrio}
              value={detalle}
              onChange={setDetalle}
              placeholder="Todos los barrios"
              emptyText="Ningún barrio coincide."
              icon="map-pin"
              className="w-full sm:w-52"
            />
            <Select value={olt} onChange={(e) => setOlt(e.target.value)} className="w-full sm:w-44" aria-label="Filtrar por OLT">
              <option value="">Todas las OLT</option>
              <option value="none">Sin OLT asignada</option>
              {olts.map(([v, n]) => <option key={v} value={v}>{v} ({n})</option>)}
            </Select>
          </ListToolbar>

          <p className="text-[12px] text-text-tertiary">
            {filtradas.length.toLocaleString("es-CO")} de {total.toLocaleString("es-CO")} VLANs
          </p>

          <DataTable
            rows={filtradas}
            empty={filtrosActivos > 0 ? "Ninguna VLAN coincide con los filtros." : "Aún no hay VLANs."}
            columns={[
              { key: "vlan", header: "VLAN", sortable: true, align: "right", render: (v) => <span className="font-mono font-semibold text-text-primary">{v.vlan}</span> },
              { key: "detail", header: "Detalle", sortable: true, render: (v) => <span className="text-text-primary">{v.detail || <span className="text-text-tertiary">Sin detalle</span>}</span> },
              { key: "branch", header: "Sede", sortable: true, render: (v) => <span className="text-text-secondary">{v.branch ?? "—"}</span> },
              { key: "olt", header: "OLT", sortable: true, render: (v) => <span className="text-text-secondary">{v.olt || "—"}</span> },
              { key: "tray", header: "Bandeja", sortable: true, align: "right", render: (v) => <span className="font-mono text-text-secondary">{v.tray ?? "—"}</span> },
              { key: "oltPort", header: "Puerto OLT", sortable: true, align: "right", render: (v) => <span className="font-mono text-text-secondary">{v.oltPort ?? "—"}</span> },
              { key: "naps", header: "NAPs", sortable: true, align: "right", render: (v) => v.naps > 0 ? <Badge tone="info" label={String(v.naps)} /> : <span className="text-text-tertiary">0</span> },
              {
                key: "acciones", header: "", align: "right", render: (v) => (
                  <div className="flex items-center justify-end gap-1">
                    <button type="button" onClick={() => openEdit(v)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
                      <Icon name="pencil" size={15} />
                    </button>
                    <button type="button" onClick={() => setConfirmar(v)} className="tap rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text" title="Eliminar">
                      <Icon name="trash" size={15} />
                    </button>
                  </div>
                ),
              },
            ]}
          />
        </>
      )}

      {draft && (
        <VlanModal
          draft={draft}
          setDraft={setDraft}
          editing={editing}
          branches={branches}
          vlans={vlans ?? []}
          onClose={() => { setDraft(null); setEditing(null); }}
          onSaved={() => { setDraft(null); setEditing(null); load(); }}
        />
      )}

      {confirmar && (
        <ConfirmDialog
          open
          busy={borrando}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void remove(confirmar)}
          tone="danger"
          icon="trash"
          title={`Eliminar VLAN ${confirmar.vlan}`}
          confirmLabel="Eliminar VLAN"
          message={
            confirmar.naps > 0 ? (
              <>
                Esta VLAN todavía tiene <b>{confirmar.naps} caja(s) NAP</b> colgando,
                así que el sistema rechazará el borrado. Mueve esas NAPs a otra VLAN antes de eliminarla.
              </>
            ) : (
              <>
                La VLAN <b>{confirmar.vlan}{confirmar.detail ? ` · ${confirmar.detail}` : ""}</b> desaparece del
                catálogo y dejará de poder elegirse al crear cajas NAP. No se puede deshacer.
              </>
            )
          }
        />
      )}
    </div>
  );
}

function VlanModal({
  draft, setDraft, editing, branches, vlans, onClose, onSaved,
}: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  editing: Vlan | null;
  branches: BranchOpt[];
  vlans: Vlan[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const { authFetch } = useAuth();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // La sede sólo se puede mover mientras la VLAN esté vacía (el backend lo
  // rechaza igual): con NAPs colgando quedarían apuntando a otra sede.
  const sedeBloqueada = !!editing && editing.naps > 0;

  // Aviso, no bloqueo: en los datos importados hay números repetidos dentro de
  // una misma sede (Monterrey tiene dos veces la 60 y la 120), así que se avisa
  // y decide quien opera.
  const num = Number(draft.vlan);
  const repetida = Number.isInteger(num) && draft.branchId
    ? vlans.find((v) => v.id !== editing?.id && v.branchId === draft.branchId && v.vlan === num)
    : undefined;

  async function save() {
    setErr(null);
    if (!draft.branchId) { setErr("Elige la sede a la que pertenece la VLAN."); return; }
    if (!Number.isInteger(num) || num < 1 || num > 4094) { setErr("El número de VLAN debe estar entre 1 y 4094."); return; }
    if (!draft.detail.trim()) { setErr("Escribe un detalle (el barrio o sector que atiende)."); return; }
    const tray = draft.tray.trim() ? Number(draft.tray) : undefined;
    const oltPort = draft.oltPort.trim() ? Number(draft.oltPort) : undefined;
    if (tray !== undefined && !Number.isInteger(tray)) { setErr("La bandeja debe ser un número entero."); return; }
    if (oltPort !== undefined && !Number.isInteger(oltPort)) { setErr("El puerto de OLT debe ser un número entero."); return; }

    setBusy(true);
    try {
      const body = JSON.stringify({
        branchId: draft.branchId, vlan: num, detail: draft.detail.trim(),
        olt: draft.olt.trim() || undefined, tray, oltPort,
      });
      const res = editing
        ? await authFetch(`/network/vlans/${editing.id}`, { method: "PATCH", body })
        : await authFetch("/network/vlans", { method: "POST", body });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo guardar la VLAN");
      toast(editing ? `VLAN ${num} actualizada` : `VLAN ${num} creada`, "check");
      onSaved();
    } catch (e) {
      setErr(mensajeDeError(e, "No se pudo guardar la VLAN"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={editing ? `Editar VLAN ${editing.vlan}` : "Nueva VLAN"}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Sede" required hint={sedeBloqueada ? "No se puede cambiar: la VLAN tiene NAPs" : undefined}>
          <Select value={draft.branchId} disabled={sedeBloqueada} onChange={(e) => setDraft({ ...draft, branchId: e.target.value })}>
            <option value="">Elige una sede…</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </Select>
        </Field>
        <Field label="Número de VLAN" required hint="Entre 1 y 4094">
          <Input type="number" min={1} max={4094} value={draft.vlan} onChange={(e) => setDraft({ ...draft, vlan: e.target.value })} placeholder="330" autoFocus />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Detalle" required hint="Barrio o sector que atiende">
            <Input value={draft.detail} onChange={(e) => setDraft({ ...draft, detail: e.target.value })} placeholder="PRIMAVERA" />
          </Field>
        </div>
        <Field label="OLT" hint="Opcional">
          <Input value={draft.olt} onChange={(e) => setDraft({ ...draft, olt: e.target.value })} placeholder="YOPAL" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Bandeja" hint="Opcional">
            <Input type="number" value={draft.tray} onChange={(e) => setDraft({ ...draft, tray: e.target.value })} placeholder="0" />
          </Field>
          <Field label="Puerto OLT" hint="Opcional">
            <Input type="number" value={draft.oltPort} onChange={(e) => setDraft({ ...draft, oltPort: e.target.value })} placeholder="3" />
          </Field>
        </div>
      </div>

      {repetida && (
        <p className="mt-2 flex items-start gap-1.5 text-[12px] text-warning-text">
          <Icon name="alert-triangle" size={14} className="mt-px shrink-0" />
          Esa sede ya tiene una VLAN {num}{repetida.detail ? ` (${repetida.detail})` : ""}. Se puede guardar igual, pero revisa que no sea un duplicado.
        </p>
      )}
      {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}

      <div className="mt-4 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void save()}>
          <Icon name="check" size={13} /> {busy ? "Guardando…" : editing ? "Guardar cambios" : "Crear VLAN"}
        </Button>
      </div>
    </Modal>
  );
}
