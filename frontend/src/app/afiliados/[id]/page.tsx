"use client";

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { DetailHeader } from "@/components/ui/DetailHeader";
import { DataTable } from "@/components/ui/DataTable";
import { Badge } from "@/components/ui/Badge";
import { toast } from "@/components/ui/Toast";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { nfmt } from "@/lib/reportes";
import { FiltroFechas, errorDe, fechaHora, useRangoUrl } from "@/components/afiliados/comun";

type Cliente = {
  id: string;
  abonado: number;
  nombre: string | null;
  documento: string | null;
  celular: string | null;
  estado: string | null;
  sede: string | null;
  fecha: string;
  registradoPor: string | null;
};

type Datos = {
  funcionario: { id: string; nombre: string; inhabilitado: boolean };
  total: number;
  activos: number;
  clientes: Cliente[];
};

/** Los clientes que quedaron a nombre de un funcionario en el alta. */
function ClientesDelFuncionario() {
  const { id } = useParams<{ id: string }>();
  const { authFetch } = useAuth();
  const { from, to, set, query } = useRangoUrl();
  const [datos, setDatos] = useState<Datos | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    let vigente = true;
    setCargando(true);
    (async () => {
      try {
        const res = await authFetch(`/staff/${id}/afiliados${query ? `?${query}` : ""}`);
        if (!res.ok) throw new Error(await errorDe(res, "No se pudieron cargar los clientes"));
        const out = await res.json();
        if (vigente) setDatos(out);
      } catch (e) {
        if (vigente) toast(e instanceof Error ? e.message : "No se pudieron cargar los clientes", "alert-circle");
      } finally {
        if (vigente) setCargando(false);
      }
    })();
    return () => { vigente = false; };
  }, [authFetch, id, query]);

  if (!datos && cargando) return <PageSkeleton />;
  const f = datos?.funcionario;

  return (
    <div className="flex flex-col gap-4">
      <DetailHeader
        backHref={`/afiliados${query ? `?${query}` : ""}`}
        backLabel="Afiliados"
        icon="user-plus"
        title={f?.nombre ?? "Funcionario"}
        badges={
          <>
            {f?.inhabilitado && <Badge label="Inhabilitado" tone="error" />}
          </>
        }
        subtitle={`${nfmt(datos?.total ?? 0)} clientes ${from || to ? "en el periodo" : "en total"} · ${nfmt(datos?.activos ?? 0)} activos hoy`}
      />

      <div className="rounded-xl border border-border-subtle bg-surface p-4">
        <FiltroFechas from={from} to={to} set={set} />
      </div>

      <DataTable
        rows={datos?.clientes ?? []}
        loading={cargando}
        empty={from || to ? "No trajo clientes en este periodo." : "Todavía no hay clientes a su nombre."}
        rowHref={(r: Cliente) => `/clientes/${r.id}`}
        columns={[
          { key: "fecha", header: "Fecha y hora del alta", sortable: true, render: (r: Cliente) => fechaHora(r.fecha) },
          { key: "nombre", header: "Cliente", sortable: true, render: (r: Cliente) => (
            <Link href={`/clientes/${r.id}`} className="font-medium text-brand hover:underline">{r.nombre ?? "Sin nombre"}</Link>
          ) },
          { key: "abonado", header: "Abonado", align: "right", sortable: true, render: (r: Cliente) => r.abonado },
          { key: "documento", header: "Documento", render: (r: Cliente) => r.documento ?? "—" },
          { key: "celular", header: "Celular", render: (r: Cliente) => r.celular ?? "—" },
          { key: "sede", header: "Sede", sortable: true, render: (r: Cliente) => r.sede ?? "—" },
          { key: "estado", header: "Estado", sortable: true, render: (r: Cliente) => r.estado ?? "—" },
          { key: "registradoPor", header: "Registró el alta", render: (r: Cliente) => r.registradoPor ?? "—" },
        ]}
      />
    </div>
  );
}

export default function Page() {
  // `useSearchParams` obliga a un límite de Suspense en el App Router.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ClientesDelFuncionario />
    </Suspense>
  );
}
