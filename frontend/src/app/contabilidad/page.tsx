"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/accounting/PageHeading";
import { StatCard } from "@/components/accounting/StatCard";
import { Icon } from "@/components/Icon";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { accountingApi } from "@/lib/accounting";
import type { TrialBalance, CashFlow, IncomeStatement } from "@/lib/accounting-types";
import { fullCurrency } from "@/lib/format";

const LINKS = [
  { href: "/contabilidad/plan-de-cuentas", label: "Plan de cuentas", icon: "list-tree", desc: "Estructura PUC del negocio" },
  { href: "/contabilidad/libros", label: "Libro diario y mayor", icon: "book-open", desc: "Asientos y movimientos por cuenta" },
  { href: "/contabilidad/informes", label: "Balance y estados", icon: "bar-chart-3", desc: "Comprobación, resultados y balance general" },
  { href: "/contabilidad/mapeo-cuentas", label: "Mapeo de cuentas", icon: "settings", desc: "Cuentas para la contabilización automática" },
];

export default function ContabilidadPage() {
  const { authFetch } = useAuth();
  const api = useMemo(() => accountingApi(authFetch), [authFetch]);
  const [tb, setTb] = useState<TrialBalance | null>(null);
  const [cf, setCf] = useState<CashFlow | null>(null);
  const [pyg, setPyg] = useState<IncomeStatement | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [a, b, c] = await Promise.all([api.getTrialBalance(), api.getCashFlow(), api.getIncomeStatement()]);
        if (!alive) return;
        setTb(a); setCf(b); setPyg(c);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [api]);

  if (loading) return <PageSkeleton />;

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeading icon="calculator" title="Contabilidad" subtitle="Partida doble · Plan Único de Cuentas (Colombia)" />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row">
        <StatCard label="Utilidad del ejercicio" value={fullCurrency(pyg?.totals.netIncome ?? 0)} icon="trending-up"
          tone={(pyg?.totals.netIncome ?? 0) >= 0 ? "success" : "error"} hint="Ingresos − costos − gastos" />
        <StatCard label="Disponible (caja y bancos)" value={fullCurrency(cf?.closing ?? 0)} icon="wallet" hint="Saldo de efectivo" />
        <StatCard label="Balance de comprobación" value={tb?.balanced ? "Cuadrado" : "Descuadrado"} icon="scale"
          tone={tb?.balanced ? "success" : "error"} hint={`${tb?.rows.length ?? 0} cuentas con movimiento`} />
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href}
            className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface p-4 transition-colors hover:border-brand hover:bg-surface-2">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-soft">
              <Icon name={l.icon} size={18} className="text-brand" />
            </span>
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-text-primary">{l.label}</p>
              <p className="truncate text-[12.5px] text-text-tertiary">{l.desc}</p>
            </div>
            <Icon name="chevron-right" size={16} className="ml-auto shrink-0 text-text-tertiary" />
          </Link>
        ))}
      </div>
    </div>
  );
}
