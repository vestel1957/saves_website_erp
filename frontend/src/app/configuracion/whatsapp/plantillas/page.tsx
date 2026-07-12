"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { DataTable } from "@/components/inventory/DataTable";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import { type WaTemplate, type WaTemplateVar, WA_VAR_SOURCES } from "@/lib/whatsapp";

const LANGS = [
  { value: "es", label: "Español" },
  { value: "es_CO", label: "Español (Colombia)" },
  { value: "en", label: "Inglés" },
];
const CATEGORIES = ["UTILITY", "MARKETING", "AUTHENTICATION"];

function TemplateModal({ tpl, onClose, onDone }: { tpl: WaTemplate | "new" | null; onClose: () => void; onDone: () => void }) {
  const { authFetch } = useAuth();
  const editing = tpl && tpl !== "new";
  const [name, setName] = useState("");
  const [language, setLanguage] = useState("es");
  const [category, setCategory] = useState("UTILITY");
  const [bodyText, setBodyText] = useState("");
  const [headerText, setHeaderText] = useState("");
  const [variables, setVariables] = useState<WaTemplateVar[]>([]);
  const [active, setActive] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (tpl && tpl !== "new") {
      setName(tpl.name); setLanguage(tpl.language); setCategory(tpl.category ?? "UTILITY");
      setBodyText(tpl.bodyText); setHeaderText(tpl.headerText ?? "");
      setVariables(tpl.variables ?? []); setActive(tpl.active); setErr(null);
    } else if (tpl === "new") {
      setName(""); setLanguage("es"); setCategory("UTILITY"); setBodyText(""); setHeaderText("");
      setVariables([]); setActive(true); setErr(null);
    }
  }, [tpl]);

  function addVar() { setVariables((v) => [...v, { index: v.length + 1, label: "", source: "name" }]); }
  function updVar(i: number, patch: Partial<WaTemplateVar>) { setVariables((v) => v.map((x, idx) => idx === i ? { ...x, ...patch } : x)); }
  function delVar(i: number) { setVariables((v) => v.filter((_, idx) => idx !== i).map((x, idx) => ({ ...x, index: idx + 1 }))); }

  async function submit() {
    setErr(null);
    if (!name.trim()) { setErr("El nombre exacto de la plantilla (Meta) es obligatorio."); return; }
    if (!bodyText.trim()) { setErr("El cuerpo de la plantilla es obligatorio."); return; }
    setSaving(true);
    try {
      const body = { name: name.trim(), language, category, bodyText, headerText: headerText || undefined, variables, active };
      const url = editing ? `/admin/whatsapp/templates/${(tpl as WaTemplate).id}` : `/admin/whatsapp/templates`;
      const res = await authFetch(url, { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo guardar");
      toast(editing ? "Plantilla actualizada" : "Plantilla creada", "check");
      onDone(); onClose();
    } catch (e: any) { setErr(e.message); } finally { setSaving(false); }
  }

  return (
    <Modal open={!!tpl} onClose={onClose} title={editing ? "Editar plantilla" : "Nueva plantilla"} maxWidth="max-w-2xl">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Nombre exacto (Meta)" required hint="Debe coincidir con el aprobado en Meta"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="factura_disponible" autoFocus /></Field>
        <Field label="Idioma"><Select value={language} onChange={(e) => setLanguage(e.target.value)}>{LANGS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}</Select></Field>
        <Field label="Categoría"><Select value={category} onChange={(e) => setCategory(e.target.value)}>{CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</Select></Field>
        <Field label="Encabezado (opcional)"><Input value={headerText} onChange={(e) => setHeaderText(e.target.value)} /></Field>
        <div className="sm:col-span-2"><Field label="Cuerpo" required hint="Usa {{1}}, {{2}}… para las variables"><Textarea rows={3} value={bodyText} onChange={(e) => setBodyText(e.target.value)} placeholder="Hola {{1}}, tu factura por {{2}} ya está disponible." /></Field></div>
        <div className="sm:col-span-2">
          <div className="mb-1 flex items-center justify-between">
            <span className="text-[12px] font-semibold text-text-secondary">Variables</span>
            <Button size="sm" variant="secondary" onClick={addVar}><Icon name="plus" size={13} /> Añadir variable</Button>
          </div>
          <div className="flex flex-col gap-2">
            {variables.length === 0 && <p className="text-[12px] text-text-tertiary">Sin variables. El cuerpo se envía tal cual.</p>}
            {variables.map((v, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-10 shrink-0 text-center font-mono text-[12px] text-text-tertiary">{`{{${v.index}}}`}</span>
                <Input className="flex-1" placeholder="Etiqueta" value={v.label} onChange={(e) => updVar(i, { label: e.target.value })} />
                <Select value={v.source} onChange={(e) => updVar(i, { source: e.target.value })}>{WA_VAR_SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}</Select>
                {v.source === "custom" && <Input className="flex-1" placeholder="Valor fijo" value={v.value ?? ""} onChange={(e) => updVar(i, { value: e.target.value })} />}
                <button type="button" onClick={() => delVar(i)} className="text-text-tertiary hover:text-error-text"><Icon name="x" size={14} /></button>
              </div>
            ))}
          </div>
        </div>
        <label className="flex items-center gap-2 text-[13px] text-text-secondary sm:col-span-2"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Activa</label>
      </div>
      {err && <p className="mt-2 text-[12px] text-error-text">{err}</p>}
      <div className="mt-3 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <Button onClick={submit} disabled={saving}>{saving ? "Guardando…" : editing ? "Guardar" : "Crear plantilla"}</Button>
      </div>
    </Modal>
  );
}

export default function PlantillasPage() {
  const { loading: authLoading, authFetch, can } = useAuth();
  const isAdmin = can(PERM.WHATSAPP_MANAGE);
  const [templates, setTemplates] = useState<WaTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState<WaTemplate | "new" | null>(null);
  const [toDelete, setToDelete] = useState<WaTemplate | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try { const r = await authFetch("/admin/whatsapp/templates"); setTemplates(r.ok ? await r.json() : []); }
    finally { setLoading(false); }
  }, [authFetch]);
  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  async function doDelete() {
    if (!toDelete) return;
    try {
      const res = await authFetch(`/admin/whatsapp/templates/${toDelete.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error((await res.json().catch(() => null))?.message || "No se pudo eliminar");
      toast("Plantilla eliminada", "check"); setToDelete(null); void load();
    } catch (e: any) { toast(e.message, "alert-triangle"); setToDelete(null); }
  }

  if (authLoading || loading) return <PageSkeleton />;

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <PageHeading icon="file-text" title="Plantillas de WhatsApp" subtitle="Referencia a las plantillas aprobadas en Meta + mapeo de variables" />
        {isAdmin && <Button size="sm" onClick={() => setModal("new")}><Icon name="plus" size={14} /> Nueva plantilla</Button>}
      </div>

      <div className="mt-4">
        <DataTable
          autoHeight
          rows={templates}
          empty="No hay plantillas. Créalas para poder enviar mensajes masivos."
          columns={[
            { key: "name", header: "Nombre", render: (t: WaTemplate) => <span className="font-mono text-[13px] text-text-primary">{t.name}</span> },
            { key: "lang", header: "Idioma", render: (t: WaTemplate) => t.language },
            { key: "cat", header: "Categoría", render: (t: WaTemplate) => t.category || "—" },
            { key: "vars", header: "Variables", render: (t: WaTemplate) => (t.variables?.length ?? 0) },
            { key: "active", header: "Estado", render: (t: WaTemplate) => <Badge label={t.active ? "Activa" : "Inactiva"} tone={t.active ? "success" : "default"} /> },
            ...(isAdmin ? [{ key: "acc", header: "", align: "right" as const, render: (t: WaTemplate) => (
              <div className="flex justify-end gap-2">
                <button type="button" title="Editar" onClick={() => setModal(t)} className="text-text-tertiary hover:text-brand"><Icon name="pencil" size={14} /></button>
                <button type="button" title="Eliminar" onClick={() => setToDelete(t)} className="text-text-tertiary hover:text-error-text"><Icon name="trash" size={14} /></button>
              </div>
            ) }] : []),
          ]}
        />
      </div>

      <TemplateModal tpl={modal} onClose={() => setModal(null)} onDone={load} />
      <ConfirmDialog
        open={!!toDelete}
        title="Eliminar plantilla"
        message={<>¿Eliminar la plantilla <b>{toDelete?.name}</b>?</>}
        confirmLabel="Eliminar"
        onConfirm={doDelete}
        onClose={() => setToDelete(null)}
      />
    </>
  );
}
