"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { Input, Select, Field } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { fullCurrency } from "@/lib/format";
import { type Plan, type ServiceKind, SERVICE_KIND_LABEL } from "@/lib/plans";

type Draft = {
  name: string;
  kind: ServiceKind;
  pppProfile: string;
  price: string;
  taxRate: string;
  megas: string;
  active: boolean;
};

const EMPTY: Draft = { name: "", kind: "INTERNET", pppProfile: "", price: "", taxRate: "0", megas: "", active: true };

export default function PlanesPage() {
  const { authFetch } = useAuth();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void authFetch(`/plans`).then((r) => (r.ok ? r.json() : [])).then(setPlans).catch(() => setPlans([]));
  }, [authFetch]);
  useEffect(() => { load(); }, [load]);

  function openNew() {
    setEditing(null);
    setDraft({ ...EMPTY });
  }
  function openEdit(p: Plan) {
    setEditing(p);
    setDraft({
      name: p.name, kind: p.kind, pppProfile: p.pppProfile ?? "",
      price: String(p.price), taxRate: String(p.taxRate ?? 0),
      megas: p.megas == null ? "" : String(p.megas), active: p.active,
    });
  }

  async function save() {
    if (!draft) return;
    if (!draft.name.trim()) { toast("El plan necesita un nombre", "alert-circle"); return; }
    const price = Number(draft.price);
    if (!Number.isFinite(price) || price < 0) { toast("Precio inválido", "alert-circle"); return; }
    setBusy(true);
    try {
      const body = JSON.stringify({
        name: draft.name.trim(),
        kind: draft.kind,
        pppProfile: draft.pppProfile.trim() || undefined,
        price,
        taxRate: draft.taxRate.trim() ? Number(draft.taxRate) : 0,
        megas: draft.megas.trim() ? Number(draft.megas) : undefined,
        active: draft.active,
      });
      const res = editing
        ? await authFetch(`/plans/${editing.id}`, { method: "PATCH", body })
        : await authFetch(`/plans`, { method: "POST", body });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo guardar");
      toast(editing ? "Plan actualizado" : "Plan creado", "check");
      setDraft(null);
      setEditing(null);
      load();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: Plan) {
    if (!confirm(`¿Eliminar el plan "${p.name}"?`)) return;
    try {
      const res = await authFetch(`/plans/${p.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo eliminar");
      toast(data?.deactivated ? "Plan desactivado (está en uso)" : "Plan eliminado", "check");
      load();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <PageHeading
          icon="gauge"
          title="Planes"
          subtitle="Catálogo de planes de servicio. Es la fuente del precio de la mensualidad recurrente y del perfil que se empuja al router."
        />
        <Button onClick={openNew}><Icon name="plus" size={15} /> Nuevo plan</Button>
      </div>

      <div className="space-y-2">
        {!plans ? (
          <p className="text-[13px] text-text-tertiary">Cargando…</p>
        ) : plans.length === 0 ? (
          <p className="text-[13px] text-text-tertiary">Aún no hay planes. Crea el primero con “Nuevo plan”.</p>
        ) : plans.map((p) => (
          <div key={p.id} className="flex items-center justify-between gap-3 rounded-xl border border-border-subtle bg-surface p-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-[14px] font-semibold text-text-primary">{p.name}</span>
                <Badge tone="info" label={SERVICE_KIND_LABEL[p.kind]} />
                {!p.active && <Badge tone="default" label="Inactivo" />}
              </div>
              <div className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-text-tertiary">
                <span className="font-mono">{p.pppProfile || "sin perfil"}</span>
                {p.taxRate > 0 && <span>IVA {p.taxRate}%</span>}
                {p.megas != null && <span>{p.megas} Mbps</span>}
                <span>{p.subscribers} abonado(s)</span>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-[14px] font-bold text-text-primary">{fullCurrency(p.price)}<span className="text-[11px] font-normal text-text-tertiary">/mes</span></span>
              <button type="button" onClick={() => openEdit(p)} className="rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary" title="Editar">
                <Icon name="pencil" size={15} />
              </button>
              <button type="button" onClick={() => remove(p)} className="rounded-md p-1.5 text-text-tertiary hover:bg-error-soft hover:text-error-text" title="Eliminar">
                <Icon name="trash" size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>

      {draft && (
        <Modal open onClose={() => setDraft(null)} title={editing ? "Editar plan" : "Nuevo plan"}>
          <div className="flex flex-col gap-3">
            <Field label="Nombre">
              <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="300 Megas ST" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Tipo de servicio">
                <Select value={draft.kind} onChange={(e) => setDraft({ ...draft, kind: e.target.value as ServiceKind })}>
                  {(Object.keys(SERVICE_KIND_LABEL) as ServiceKind[]).map((k) => (
                    <option key={k} value={k}>{SERVICE_KIND_LABEL[k]}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Precio mensual (COP)" hint="Base sin IVA">
                <Input type="number" min={0} value={draft.price} onChange={(e) => setDraft({ ...draft, price: e.target.value })} placeholder="60000" />
              </Field>
            </div>
            <Field label="IVA (%)" hint="Internet 0 · Televisión 19">
              <Input type="number" min={0} value={draft.taxRate} onChange={(e) => setDraft({ ...draft, taxRate: e.target.value })} placeholder="0" />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Perfil PPP (router)" hint="Vacío = no se empuja al router">
                <Input value={draft.pppProfile} onChange={(e) => setDraft({ ...draft, pppProfile: e.target.value })} placeholder="300M" />
              </Field>
              <Field label="Velocidad (Mbps)" hint="Informativo">
                <Input type="number" min={0} value={draft.megas} onChange={(e) => setDraft({ ...draft, megas: e.target.value })} placeholder="300" />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-[13px] text-text-secondary">
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />
              Activo (disponible para asignar a abonados)
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setDraft(null)}>Cancelar</Button>
              <Button onClick={save} disabled={busy}>{busy ? "Guardando…" : "Guardar"}</Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
