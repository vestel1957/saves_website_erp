"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Field";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { accountingApi } from "@/lib/accounting";
import type { CostCenterBranch, CostCenterRow } from "@/lib/accounting-types";

/**
 * Centros de costo (contabilidad de gestión, docs/centros-de-costo/PLAN.md).
 *
 * Cada sede tiene su centro (`CC-<SEDE>`) y lo compartido va a «Administración general».
 * Aquí se ven, se crean y se editan: nombre, activo y la sede vinculada. El código no se
 * edita (es la llave con la que el sembrado los reconoce). Gerencia sólo mira: crear y
 * editar son de contabilidad y administración, igual que en la API.
 */

const TIPO: Record<CostCenterRow["kind"], string> = {
  SEDE: "Sede",
  GENERAL: "Administración general",
  OTRO: "Otro",
};

type Edicion = { id: string | null; code: string; name: string; parentId: string; sede: string; isActive: boolean };

export default function CentrosDeCostoPage() {
  const { authFetch, can } = useAuth();
  const api = useMemo(() => accountingApi(authFetch), [authFetch]);
  const puedeEditar = can(["area.contabilidad", "area.administracion"]);
  const [centros, setCentros] = useState<CostCenterRow[]>([]);
  const [sedes, setSedes] = useState<CostCenterBranch[]>([]);
  const [loading, setLoading] = useState(true);
  const [edicion, setEdicion] = useState<Edicion | null>(null);
  const [guardando, setGuardando] = useState(false);

  const cargar = useCallback(async () => {
    const [c, s] = await Promise.all([api.getCostCenters(true), api.getCostCenterBranches()]);
    setCentros(c);
    setSedes(s);
  }, [api]);

  useEffect(() => {
    let alive = true;
    cargar()
      .catch((e: Error) => toast(e.message, "alert-triangle"))
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [cargar]);

  const porId = useMemo(() => new Map(centros.map((c) => [c.id, c])), [centros]);
  // Orden de árbol: cada centro debajo de su padre, con sangría por nivel.
  const filas = useMemo(() => {
    const hijos = new Map<string | null, CostCenterRow[]>();
    for (const c of centros) {
      const p = c.parentId && porId.has(c.parentId) ? c.parentId : null;
      hijos.set(p, [...(hijos.get(p) ?? []), c]);
    }
    const orden = (a: CostCenterRow, b: CostCenterRow) =>
      (a.kind === "GENERAL" ? -1 : 0) - (b.kind === "GENERAL" ? -1 : 0)
      || (a.branch?.legacyId ?? 999) - (b.branch?.legacyId ?? 999)
      || a.code.localeCompare(b.code);
    const out: { c: CostCenterRow; nivel: number }[] = [];
    const visitar = (p: string | null, nivel: number, vistos: Set<string>) => {
      for (const c of (hijos.get(p) ?? []).sort(orden)) {
        if (vistos.has(c.id)) continue;
        vistos.add(c.id);
        out.push({ c, nivel });
        visitar(c.id, nivel + 1, vistos);
      }
    };
    visitar(null, 0, new Set());
    return out;
  }, [centros, porId]);

  const sinCentro = sedes.filter((s) => !s.costCenter);

  async function guardar() {
    if (!edicion) return;
    const name = edicion.name.trim();
    if (!name) { toast("El nombre es obligatorio", "alert-triangle"); return; }
    setGuardando(true);
    try {
      const branchLegacyId = edicion.sede ? Number(edicion.sede) : null;
      if (edicion.id) {
        await api.updateCostCenter(edicion.id, { name, isActive: edicion.isActive, branchLegacyId });
      } else {
        const code = edicion.code.trim().toUpperCase();
        if (!code) { toast("El código es obligatorio", "alert-triangle"); return; }
        const creado = await api.createCostCenter({ code, name, parentId: edicion.parentId || null });
        if (branchLegacyId) await api.updateCostCenter(creado.id, { branchLegacyId });
      }
      toast(edicion.id ? "Centro de costo actualizado" : "Centro de costo creado", "check");
      setEdicion(null);
      await cargar();
    } catch (e) {
      toast((e as Error).message, "alert-triangle");
    } finally {
      setGuardando(false);
    }
  }

  if (loading) return <PageSkeleton />;

  const editando = edicion?.id ? porId.get(edicion.id) : null;
  // Sedes elegibles: las libres y la que ya tenga este centro.
  const sedesElegibles = sedes.filter((s) => !s.costCenter || s.costCenter.id === edicion?.id);
  const raiz = centros.find((c) => c.code === "VESTEL");

  return (
    <div className="flex flex-col gap-4">
      <PageHeading
        icon="list-tree"
        title="Centros de costo"
        subtitle="Un centro por sede y «Administración general» para lo compartido. Alimentan el informe de resultados por sede."
      />

      {puedeEditar && (
        <div className="flex justify-end">
          <Button
            onClick={() => setEdicion({ id: null, code: "", name: "", parentId: raiz?.id ?? "", sede: "", isActive: true })}
          >
            <Icon name="plus" size={14} /> Nuevo centro
          </Button>
        </div>
      )}

      {sinCentro.length > 0 && (
        <div className="flex items-center gap-2 rounded-xl border border-warning-subtle bg-warning-soft p-3 text-[12.5px] text-warning-text">
          <Icon name="alert-triangle" size={15} className="shrink-0" />
          Sede(s) sin centro de costo: {sinCentro.map((s) => s.name).join(", ")}. Sus asientos quedarán «Sin asignar».
        </div>
      )}

      <div className="shrink-0 overflow-x-auto rounded-xl border border-border-subtle bg-surface">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead>
            <tr className="border-b border-border-subtle bg-surface-2 text-left text-[11px] font-bold uppercase tracking-wider text-text-secondary">
              <th className="px-4 py-2.5">Código</th>
              <th className="px-4 py-2.5">Nombre</th>
              <th className="px-4 py-2.5">Tipo</th>
              <th className="px-4 py-2.5">Sede vinculada</th>
              <th className="px-4 py-2.5">Estado</th>
              {puedeEditar && <th className="px-4 py-2.5" />}
            </tr>
          </thead>
          <tbody>
            {filas.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-3 text-text-tertiary">No hay centros de costo.</td></tr>
            )}
            {filas.map(({ c, nivel }) => (
              <tr key={c.id} className={`border-b border-border-subtle last:border-0 ${c.isActive ? "" : "opacity-60"}`}>
                <td className="px-4 py-2 font-mono text-[12px] text-text-tertiary" style={{ paddingLeft: `${16 + nivel * 18}px` }}>{c.code}</td>
                <td className="px-4 py-2 text-text-primary">{c.name}</td>
                <td className="px-4 py-2 text-text-secondary">{TIPO[c.kind] ?? c.kind}</td>
                <td className="px-4 py-2 text-text-secondary">{c.branch?.name ?? "—"}</td>
                <td className="px-4 py-2">
                  <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${c.isActive ? "bg-success-soft text-success-text" : "bg-surface-2 text-text-tertiary"}`}>
                    {c.isActive ? "Activo" : "Inactivo"}
                  </span>
                </td>
                {puedeEditar && (
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setEdicion({
                        id: c.id, code: c.code, name: c.name, parentId: c.parentId ?? "",
                        sede: c.branch ? String(c.branch.legacyId) : "", isActive: c.isActive,
                      })}
                    >
                      <Icon name="pencil" size={13} /> Editar
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={!!edicion}
        onClose={() => setEdicion(null)}
        title={edicion?.id ? `Editar ${edicion.code}` : "Nuevo centro de costo"}
      >
        {edicion && (
          <div className="flex flex-col gap-3">
            {!edicion.id && (
              <Field label="Código" required hint="Único; no se puede cambiar después.">
                <Input value={edicion.code} onChange={(e) => setEdicion({ ...edicion, code: e.target.value })} placeholder="CC-…" />
              </Field>
            )}
            <Field label="Nombre" required>
              <Input value={edicion.name} onChange={(e) => setEdicion({ ...edicion, name: e.target.value })} />
            </Field>
            {!edicion.id && (
              <Field label="Depende de">
                <Select value={edicion.parentId} onChange={(e) => setEdicion({ ...edicion, parentId: e.target.value })}>
                  <option value="">— Ninguno —</option>
                  {centros.filter((c) => c.isActive).map((c) => (
                    <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                  ))}
                </Select>
              </Field>
            )}
            {editando?.kind !== "GENERAL" && (
              <Field
                label="Sede vinculada"
                hint="Los asientos de esa sede (facturas, pagos, caja) irán a este centro. Una sede tiene un solo centro."
              >
                <Select value={edicion.sede} onChange={(e) => setEdicion({ ...edicion, sede: e.target.value })}>
                  <option value="">— Sin sede —</option>
                  {sedesElegibles.map((s) => (
                    <option key={s.legacyId} value={s.legacyId}>{s.name}</option>
                  ))}
                </Select>
              </Field>
            )}
            {edicion.id && (
              <label className="flex items-center gap-2 text-[13px] text-text-secondary">
                <input
                  type="checkbox"
                  checked={edicion.isActive}
                  onChange={(e) => setEdicion({ ...edicion, isActive: e.target.checked })}
                />
                Activo (a un centro inactivo no le caen asientos nuevos automáticamente)
              </label>
            )}
            <div className="mt-2 flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setEdicion(null)}>Cancelar</Button>
              <Button onClick={guardar} disabled={guardando}>{guardando ? "Guardando…" : "Guardar"}</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
