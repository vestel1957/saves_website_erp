"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/accounting/PageHeading";
import { Select } from "@/components/ui/Field";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { accountingApi, type AccountMappingRow } from "@/lib/accounting";
import type { Account } from "@/lib/accounting-types";

/** Etiquetas legibles para las claves de mapeo. */
const KEY_LABELS: Record<string, { label: string; desc: string }> = {
  SALES_AR: { label: "Cartera clientes (CxC)", desc: "Cuenta por cobrar al facturar una venta" },
  SALES_REVENUE: { label: "Ingreso por ventas", desc: "Ingreso operacional al facturar" },
  SALES_TAX: { label: "IVA generado", desc: "IVA por pagar de las ventas" },
  PURCHASE_AP: { label: "Proveedores (CxP)", desc: "Cuenta por pagar al recibir una compra" },
  PURCHASE_EXPENSE: { label: "Gasto / compra", desc: "Gasto o costo por defecto de las compras" },
  PURCHASE_TAX: { label: "IVA descontable", desc: "IVA a favor de las compras" },
  BANK_DEFAULT: { label: "Banco por defecto", desc: "Cuenta de banco para recaudos y pagos" },
  CASH_DEFAULT: { label: "Caja por defecto", desc: "Cuenta de caja para movimientos de efectivo" },
  COGS: { label: "Costo de ventas", desc: "Costo de la mercancía/servicio vendido" },
  INVENTORY: { label: "Inventario", desc: "Inventario de mercancías" },
  RETAINED_EARNINGS: { label: "Utilidades acumuladas", desc: "Resultados de ejercicios anteriores" },
  INCOME_SUMMARY: { label: "Utilidad del ejercicio", desc: "Resultado del periodo en el cierre" },
};

export default function MapeoCuentasPage() {
  const { authFetch } = useAuth();
  const api = useMemo(() => accountingApi(authFetch), [authFetch]);
  const [rows, setRows] = useState<AccountMappingRow[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState("");

  const postable = useMemo(() => accounts.filter((a) => a.isPostable), [accounts]);

  const load = useCallback(async () => {
    const [m, a] = await Promise.all([api.getMappings(), api.getAccounts()]);
    setRows(m);
    setAccounts(a);
  }, [api]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try { await load(); } finally { if (alive) setLoading(false); }
    })();
    return () => { alive = false; };
  }, [load]);

  async function assign(key: string, accountId: string) {
    if (!accountId) return;
    setSaving(key);
    try {
      await api.upsertMapping({ key, accountId });
      toast("Mapeo actualizado", "check");
      await load();
    } catch (e) {
      toast((e as Error).message, "alert-triangle");
    } finally {
      setSaving("");
    }
  }

  if (loading) return <PageSkeleton />;

  const missing = rows.filter((r) => !r.accountId).length;

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeading icon="settings" title="Mapeo de cuentas" subtitle="Cuentas que usa la contabilización automática de facturas, compras y pagos" />

      {missing > 0 && (
        <div className="mb-4 rounded-xl border border-warning-subtle bg-warning-soft p-3 text-[12.5px] text-warning-text">
          Faltan {missing} mapeo(s) por configurar. Los documentos sin mapeo no se contabilizarán automáticamente.
        </div>
      )}

      <div className="flex flex-col divide-y divide-border-subtle overflow-hidden rounded-xl border border-border-subtle bg-surface">
        {rows.map((r) => {
          const meta = KEY_LABELS[r.key] ?? { label: r.key, desc: "" };
          return (
            <div key={r.key} className="flex flex-col gap-2 p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-[13.5px] font-semibold text-text-primary">{meta.label}</p>
                <p className="text-[12px] text-text-tertiary">{meta.desc}</p>
              </div>
              <div className="w-full sm:w-72">
                <Select
                  value={r.accountId ?? ""}
                  disabled={saving === r.key}
                  onChange={(e) => assign(r.key, e.target.value)}
                >
                  <option value="">Sin asignar…</option>
                  {postable.map((a) => (
                    <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
                  ))}
                </Select>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
