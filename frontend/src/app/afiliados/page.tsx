"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { PageHeading } from "@/components/ui/PageHeading";
import { DataTable } from "@/components/ui/DataTable";
import { Input, Field } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { nfmt } from "@/lib/reportes";
import { FiltroFechas, errorDe, fechaHora, useRangoUrl } from "@/components/afiliados/comun";

type Fila = {
  id: string;
  nombre: string;
  cargo: string | null;
  area: string | null;
  clientes: number;
  clientesTotal: number;
  ultimaAfiliacion: string | null;
};

/**
 * Afiliados: cada funcionario que afilia (lista nominal del backend) y cuántos clientes
 * quedaron a su nombre en el alta. Desde aquí se entra a ver sus clientes.
 * Hasta el 2026-09-23 cada uno tenía un código; ahora el alta lo elige de una lista.
 */
function Afiliados() {
  const { authFetch } = useAuth();
  const { from, to, set, query } = useRangoUrl();
  const [filas, setFilas] = useState<Fila[]>([]);
  const [cargando, setCargando] = useState(true);
  const [buscar, setBuscar] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true);
    try {
      const res = await authFetch(`/staff/afiliados${query ? `?${query}` : ""}`);
      if (!res.ok) throw new Error(await errorDe(res, "No se pudo cargar la lista"));
      const out = await res.json();
      setFilas(out.funcionarios ?? []);
    } catch (e) {
      toast(e instanceof Error ? e.message : "No se pudo cargar la lista", "alert-circle");
    } finally {
      setCargando(false);
    }
  }, [authFetch, query]);

  useEffect(() => { void cargar(); }, [cargar]);

  const q = buscar.trim().toLowerCase();
  const visibles = q
    ? filas.filter((f) => f.nombre.toLowerCase().includes(q))
    : filas;
  const total = filas.reduce((a, f) => a + f.clientes, 0);
  const periodo = from || to ? "en el periodo" : "en total";

  return (
    <div className="flex flex-col gap-4">
      <PageHeading icon="user-plus" title="Afiliados"
        subtitle="Los clientes que quedaron a nombre de cada funcionario en el alta" />

      <div className="flex flex-col gap-3 rounded-xl border border-border-subtle bg-surface p-4 sm:flex-row sm:items-start sm:justify-between">
        <FiltroFechas from={from} to={to} set={set} />
        <div className="sm:w-72">
          <Field label="Buscar funcionario">
            <Input value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Nombre" />
          </Field>
        </div>
      </div>

      <div className="text-[13px] text-text-secondary">
        {nfmt(total)} clientes afiliados {periodo} · {nfmt(filas.filter((f) => f.clientes > 0).length)} de {nfmt(filas.length)} funcionarios con afiliados
      </div>

      <DataTable
        rows={visibles}
        loading={cargando}
        empty="No hay funcionarios activos."
        rowHref={(r: Fila) => `/afiliados/${r.id}${query ? `?${query}` : ""}`}
        columns={[
          { key: "nombre", header: "Funcionario", sortable: true, render: (r: Fila) => (
            <div className="flex flex-col">
              <span className="font-medium text-text-primary">{r.nombre}</span>
              {(r.cargo || r.area) && <span className="text-[11px] text-text-tertiary">{[r.cargo, r.area].filter(Boolean).join(" · ")}</span>}
            </div>
          ) },
          { key: "clientes", header: from || to ? "Clientes en el periodo" : "Clientes", align: "right", sortable: true,
            render: (r: Fila) => <span className="font-semibold">{nfmt(r.clientes)}</span> },
          ...(from || to
            ? [{ key: "clientesTotal", header: "Total histórico", align: "right" as const, sortable: true, render: (r: Fila) => nfmt(r.clientesTotal) }]
            : []),
          { key: "ultimaAfiliacion", header: "Última afiliación", sortable: true, render: (r: Fila) => fechaHora(r.ultimaAfiliacion) },
          { key: "acciones", header: "", render: (r: Fila) => (
            <div className="flex justify-end gap-1.5">
              <Link href={`/afiliados/${r.id}${query ? `?${query}` : ""}`}
                className="inline-flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1.5 text-[12px] text-text-secondary hover:bg-surface-2">
                <Icon name="users" size={13} /> Clientes
              </Link>
            </div>
          ) },
        ]}
      />
    </div>
  );
}

export default function Page() {
  // `useSearchParams` obliga a un límite de Suspense en el App Router.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Afiliados />
    </Suspense>
  );
}
