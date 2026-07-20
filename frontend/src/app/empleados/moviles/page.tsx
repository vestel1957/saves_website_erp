"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";

type Movil = { id: string; name: string | null; status: string; memberCount: number; members: string[]; createdBy: string | null };
type Member = { id: string; employeeId: string; name: string | null; position: string | null; role: string | null };
type Emp = { id: string; name: string; position: string | null };

/** Modal para gestionar los técnicos de una móvil. */
function MembersModal({ movil, onClose, onChanged }: { movil: Movil | null; onClose: () => void; onChanged: () => void }) {
  const { authFetch } = useAuth();
  const [members, setMembers] = useState<Member[]>([]);
  const [emps, setEmps] = useState<Emp[]>([]);
  const [pick, setPick] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    if (!movil) return;
    setLoading(true);
    try {
      const [d, e] = await Promise.all([
        authFetch(`/moviles/${movil.id}`).then((r) => (r.ok ? r.json() : null)),
        authFetch(`/moviles/employees?movilId=${movil.id}`).then((r) => (r.ok ? r.json() : [])),
      ]);
      setMembers(d?.members ?? []); setEmps(e);
    } finally { setLoading(false); }
  }, [authFetch, movil]);
  useEffect(() => { void load(); }, [load]);

  async function add() {
    if (!pick || !movil) return;
    try {
      const res = await authFetch(`/moviles/${movil.id}/members`, { method: "POST", body: JSON.stringify({ employeeId: pick }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo agregar");
      setPick(""); toast("Técnico agregado", "check"); await load(); onChanged();
    } catch (e: any) { toast(e.message, "alert-triangle"); }
  }
  async function remove(employeeId: string) {
    if (!movil) return;
    try {
      const res = await authFetch(`/moviles/${movil.id}/members/${employeeId}`, { method: "DELETE" });
      if (!res.ok) throw new Error("No se pudo quitar");
      toast("Técnico quitado", "check"); await load(); onChanged();
    } catch (e: any) { toast(e.message, "alert-triangle"); }
  }

  return (
    <Modal open={!!movil} onClose={onClose} title={`Técnicos · ${movil?.name ?? ""}`} maxWidth="max-w-lg">
      {loading ? <p className="py-4 text-center text-[12px] text-text-tertiary">Cargando…</p> : (
        <div className="flex flex-col gap-3">
          <div className="flex items-end gap-2">
            <div className="flex-1"><Field label="Agregar técnico"><Select value={pick} onChange={(e) => setPick(e.target.value)}><option value="">— Elegir —</option>{emps.map((e) => <option key={e.id} value={e.id}>{e.name}{e.position ? ` · ${e.position}` : ""}</option>)}</Select></Field></div>
            <Button size="sm" onClick={add} disabled={!pick}><Icon name="plus" size={13} /> Agregar</Button>
          </div>
          <div className="flex flex-col gap-1">
            {members.length === 0 && <p className="text-[12px] text-text-tertiary">Sin técnicos en la móvil.</p>}
            {members.map((m) => (
              <div key={m.id} className="flex items-center justify-between rounded-lg border border-border-subtle bg-surface px-3 py-2">
                <div><span className="text-[13px] font-medium text-text-primary">{m.name}</span>{m.position && <span className="ml-2 text-[11px] text-text-tertiary">{m.position}</span>}</div>
                <button type="button" onClick={() => remove(m.employeeId)} className="text-text-tertiary hover:text-error-text"><Icon name="x" size={14} /></button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

export default function MovilesPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [rows, setRows] = useState<Movil[]>([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<Movil | "new" | null>(null);
  const [name, setName] = useState("");
  const [status, setStatus] = useState("Activa");
  const [members, setMembers] = useState<Movil | null>(null);
  const [toDelete, setToDelete] = useState<Movil | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await authFetch("/moviles"); setRows(r.ok ? await r.json() : []); }
    finally { setLoading(false); }
  }, [authFetch]);
  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  function openNew() { setName(""); setStatus("Activa"); setEdit("new"); }
  function openEdit(m: Movil) { setName(m.name ?? ""); setStatus(m.status); setEdit(m); }

  async function save() {
    try {
      const editing = edit && edit !== "new";
      const res = await authFetch(editing ? `/moviles/${(edit as Movil).id}` : "/moviles", { method: editing ? "PATCH" : "POST", body: JSON.stringify({ name, status }) });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(editing ? "Móvil actualizada" : "Móvil creada", "check"); setEdit(null); void load();
    } catch (e: any) { toast(e.message, "alert-triangle"); }
  }

  async function doDelete() {
    if (!toDelete) return;
    try {
      const res = await authFetch(`/moviles/${toDelete.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("No se pudo eliminar");
      toast("Móvil eliminada", "check"); setToDelete(null); void load();
    } catch (e: any) { toast(e.message, "alert-triangle"); setToDelete(null); }
  }

  if (authLoading || loading) return <PageSkeleton />;

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <PageHeading icon="truck" title="Móviles / cuadrillas" subtitle="Agrupa técnicos para asignar órdenes y agenda" />
        <Button size="sm" onClick={openNew}><Icon name="plus" size={14} /> Nueva móvil</Button>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {rows.length === 0 && <p className="text-[13px] text-text-tertiary">No hay móviles. Crea la primera.</p>}
        {rows.map((m) => (
          <div key={m.id} className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="text-[14px] font-bold text-text-primary">{m.name || "(sin nombre)"}</div>
                <Badge label={m.status} tone={m.status === "Activa" ? "success" : "default"} />
              </div>
              <div className="flex gap-1">
                <button type="button" title="Editar" onClick={() => openEdit(m)} className="text-text-tertiary hover:text-brand"><Icon name="pencil" size={14} /></button>
                <button type="button" title="Eliminar" onClick={() => setToDelete(m)} className="text-text-tertiary hover:text-error-text"><Icon name="trash" size={14} /></button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-1">
              {m.members.length === 0 ? <span className="text-[12px] text-text-tertiary">Sin técnicos</span>
                : m.members.map((n, i) => <span key={i} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] text-text-secondary">{n}</span>)}
            </div>
            <Button variant="secondary" size="sm" className="mt-3 w-full" onClick={() => setMembers(m)}><Icon name="users" size={13} /> Gestionar técnicos ({m.memberCount})</Button>
          </div>
        ))}
      </div>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === "new" ? "Nueva móvil" : "Editar móvil"} maxWidth="max-w-md">
        <div className="flex flex-col gap-3">
          <Field label="Nombre"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej: Móvil 1 · Yopal" autoFocus /></Field>
          <Field label="Estado"><Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="Activa">Activa</option><option value="Inactiva">Inactiva</option></Select></Field>
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setEdit(null)}>Cancelar</Button>
            <Button onClick={save}>Guardar</Button>
          </div>
        </div>
      </Modal>

      <MembersModal movil={members} onClose={() => setMembers(null)} onChanged={load} />
      <ConfirmDialog open={!!toDelete} title="Eliminar móvil" message={<>¿Eliminar la móvil <b>{toDelete?.name}</b>?</>} confirmLabel="Eliminar" onConfirm={doDelete} onClose={() => setToDelete(null)} />
    </>
  );
}
