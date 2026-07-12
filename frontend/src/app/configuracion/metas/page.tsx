"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Button } from "@/components/ui/Button";
import { Input, Field } from "@/components/ui/Field";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";

type GoalField = { key: string; label: string; value: number };
type Goals = { updatedAt: string | null; updatedBy: string | null; fields: GoalField[] };

export default function MetasPage() {
  const { loading: authLoading, authFetch } = useAuth();
  const [goals, setGoals] = useState<Goals | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const g: Goals = await (await authFetch("/settings/goals")).json();
    setGoals(g);
    setForm(Object.fromEntries(g.fields.map((f) => [f.key, String(f.value)])));
  }, [authFetch]);

  useEffect(() => { if (!authLoading) void load(); }, [authLoading, load]);

  async function save() {
    setSaving(true);
    try {
      const payload = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, Number(v) || 0]));
      const res = await authFetch("/settings/goals", { method: "PUT", body: JSON.stringify(payload) });
      if (!res.ok) throw new Error((await res.json())?.message || "No se pudieron guardar las metas");
      const g: Goals = await res.json();
      setGoals(g);
      setForm(Object.fromEntries(g.fields.map((f) => [f.key, String(f.value)])));
      toast("Metas guardadas", "check");
    } catch (e: any) { toast(e.message, "alert-triangle"); } finally { setSaving(false); }
  }

  if (authLoading || !goals) return <PageSkeleton />;

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <PageHeading icon="target" title="Metas" subtitle={goals.updatedBy ? `Última actualización por ${goals.updatedBy}` : "Metas anuales de negocio"} />
        <Button onClick={save} disabled={saving}>{saving ? "Guardando…" : "Guardar metas"}</Button>
      </div>

      <div className="rounded-2xl border border-border-subtle bg-surface p-5 shadow-sm">
        <div className="grid grid-cols-1 gap-x-5 gap-y-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {goals.fields.map((f) => (
            <Field key={f.key} label={f.label}>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[13px] text-text-tertiary">$</span>
                <Input
                  type="number"
                  min={0}
                  className="pl-6"
                  value={form[f.key] ?? ""}
                  onChange={(e) => setForm((prev) => ({ ...prev, [f.key]: e.target.value }))}
                  placeholder="0"
                />
              </div>
            </Field>
          ))}
        </div>
      </div>
    </>
  );
}
