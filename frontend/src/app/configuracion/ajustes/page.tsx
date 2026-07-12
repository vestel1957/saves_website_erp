"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Icon } from "@/components/Icon";
import { AuthNotice } from "@/components/inventory/DataTable";
import { Button } from "@/components/ui/Button";
import { Field, Input, Textarea } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";

type GoalField = { key: string; label: string; value: number };
type GoalsResp = { updatedAt: string | null; updatedBy: string | null; fields: GoalField[] };

type SettingItem = {
  key: string; group: string; label: string;
  secret: boolean; multiline: boolean; placeholder: string;
  value: string; hasValue: boolean;
};
type SettingsResp = { groups: { group: string; title: string; items: SettingItem[] }[] };

const fmt = new Intl.NumberFormat("es-CO");

export default function AjustesPage() {
  const { user, can, authFetch } = useAuth();
  const allowed = can(PERM.AREA_SISTEMAS) || can(PERM.AREA_GERENCIA) || can(PERM.SYSTEM_ADMIN);

  const [goals, setGoals] = useState<GoalsResp | null>(null);
  const [goalDraft, setGoalDraft] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState<SettingsResp | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [savingGoals, setSavingGoals] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [g, s] = await Promise.all([authFetch("/settings/goals"), authFetch("/settings")]);
      if (g.ok) {
        const data: GoalsResp = await g.json();
        setGoals(data);
        setGoalDraft(Object.fromEntries(data.fields.map((f) => [f.key, String(f.value)])));
      }
      if (s.ok) {
        const data: SettingsResp = await s.json();
        setSettings(data);
        const d: Record<string, string> = {};
        for (const grp of data.groups) for (const it of grp.items) d[it.key] = it.value;
        setDraft(d);
      }
    } catch { /* best-effort */ }
  }, [authFetch]);

  useEffect(() => { if (user && allowed) void refresh(); }, [user, allowed, refresh]);

  async function saveGoals(e: React.FormEvent) {
    e.preventDefault();
    setSavingGoals(true);
    const payload: Record<string, number> = {};
    for (const [k, v] of Object.entries(goalDraft)) payload[k] = Number(v.replace(/[^\d]/g, "")) || 0;
    const res = await authFetch("/settings/goals", { method: "PUT", body: JSON.stringify(payload) });
    setSavingGoals(false);
    if (res.ok) { toast("Metas guardadas"); void refresh(); }
    else toast("No se pudieron guardar las metas", "x");
  }

  async function saveSettings(e: React.FormEvent) {
    e.preventDefault();
    setSavingSettings(true);
    // Solo mandamos lo que cambió respecto al valor mostrado (evita reenviar la máscara).
    const values: Record<string, string> = {};
    for (const grp of settings?.groups ?? [])
      for (const it of grp.items)
        if (draft[it.key] !== undefined && draft[it.key] !== it.value) values[it.key] = draft[it.key];
    const res = await authFetch("/settings", { method: "PUT", body: JSON.stringify({ values }) });
    setSavingSettings(false);
    if (res.ok) { toast("Ajustes guardados"); void refresh(); }
    else toast("No se pudieron guardar los ajustes", "x");
  }

  if (!user) return <AuthNotice />;
  if (!allowed)
    return (
      <>
        <PageHeading icon="sliders-horizontal" title="Ajustes globales" />
        <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center text-[13px] text-text-tertiary">
          Solo Sistemas o Gerencia pueden ver los ajustes globales.
        </div>
      </>
    );

  return (
    <>
      <PageHeading icon="sliders-horizontal" title="Ajustes globales"
        subtitle="Metas del negocio, moneda, correo saliente y textos de facturación." />

      {/* ---- Metas ---- */}
      <form onSubmit={saveGoals} className="mt-4 rounded-xl border border-border-subtle bg-surface p-5">
        <div className="mb-3 flex items-center justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-[14px] font-semibold text-text-primary">
              <Icon name="target" className="h-4 w-4 text-brand" /> Metas anuales
            </h2>
            <p className="text-[12px] text-text-tertiary">
              Objetivos por rubro (COP). Alimentan la comparación real vs meta del tablero.
            </p>
          </div>
          <Button type="submit" size="sm" disabled={savingGoals}>
            {savingGoals ? "Guardando…" : "Guardar metas"}
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {goals?.fields.map((f) => (
            <Field key={f.key} label={f.label}
              hint={goalDraft[f.key] ? `$ ${fmt.format(Number(goalDraft[f.key].replace(/[^\d]/g, "")) || 0)}` : undefined}>
              <Input inputMode="numeric" value={goalDraft[f.key] ?? ""}
                onChange={(e) => setGoalDraft((d) => ({ ...d, [f.key]: e.target.value }))} />
            </Field>
          ))}
        </div>
        {goals?.updatedAt && (
          <p className="mt-3 text-[11px] text-text-tertiary">
            Última edición: {new Date(goals.updatedAt).toLocaleString("es-CO")}
            {goals.updatedBy ? ` · ${goals.updatedBy}` : ""}
          </p>
        )}
      </form>

      {/* ---- Moneda / SMTP / Términos ---- */}
      <form onSubmit={saveSettings} className="mt-4 space-y-4">
        {settings?.groups.map((grp) => (
          <div key={grp.group} className="rounded-xl border border-border-subtle bg-surface p-5">
            <h2 className="mb-3 flex items-center gap-2 text-[14px] font-semibold text-text-primary">
              <Icon name={grp.group === "smtp" ? "mail" : grp.group === "moneda" ? "circle-dollar-sign" : "file-text"}
                className="h-4 w-4 text-brand" />
              {grp.title}
              {grp.group === "smtp" && (
                <span className="ml-1 text-[11px] font-normal text-text-tertiary">
                  (se guarda; el envío real aún no está cableado)
                </span>
              )}
            </h2>
            <div className={grp.group === "billing" ? "space-y-3" : "grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3"}>
              {grp.items.map((it) => (
                <Field key={it.key} label={it.label}
                  hint={it.secret && it.hasValue ? "Escribe una nueva para reemplazarla" : undefined}>
                  {it.multiline ? (
                    <Textarea rows={3} placeholder={it.placeholder} value={draft[it.key] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [it.key]: e.target.value }))} />
                  ) : (
                    <Input type={it.secret ? "password" : "text"} placeholder={it.placeholder}
                      value={draft[it.key] ?? ""}
                      onChange={(e) => setDraft((d) => ({ ...d, [it.key]: e.target.value }))} />
                  )}
                </Field>
              ))}
            </div>
          </div>
        ))}
        <div className="flex justify-end">
          <Button type="submit" disabled={savingSettings}>
            {savingSettings ? "Guardando…" : "Guardar ajustes"}
          </Button>
        </div>
      </form>
    </>
  );
}
