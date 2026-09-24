import Link from "next/link";
import { ChartCard, HBarList, TrendStat } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { nfmt } from "@/lib/reportes";
import { fechaHora } from "@/components/afiliados/comun";
import { Section } from "./Section";

/**
 * Afiliados por funcionario: qué clientes quedaron a nombre de cada uno en el alta.
 * La fecha es la del alta; "Registró el alta" es quién la digitó, que no siempre es
 * el funcionario que trajo al cliente.
 */
export function Afiliados({ data }: { data: any }) {
  const funcionarios = data.funcionarios ?? [];
  const clientes = data.clientes ?? [];
  const top = funcionarios[0];

  return (
    <>
      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <TrendStat label="Clientes afiliados" value={nfmt(data.total ?? 0)} icon="user-plus"
            hint={`${nfmt(data.activos ?? 0)} activos hoy`} />
          <TrendStat label="Funcionarios con afiliados" value={nfmt(funcionarios.length)} icon="contact" />
          <TrendStat label="Más afiliados" value={top?.nombre ?? "—"} icon="user"
            hint={top ? `${nfmt(top.clientes)} clientes` : ""} />
        </div>
      </Section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ChartCard title="Clientes por funcionario" subtitle="Altas a su nombre en el periodo" icon="contact">
          <HBarList valueFormat={(n: number) => nfmt(n)}
            rows={funcionarios.slice(0, 12).map((f: any) => ({ label: f.nombre, value: f.clientes }))} />
        </ChartCard>
        <ChartCard title="Resumen por funcionario" icon="list-tree">
          <DataTable rows={funcionarios} empty="Nadie trajo clientes en este periodo." columns={[
            { key: "n", header: "Funcionario", render: (r: any) => (
              <span className="font-medium text-text-primary">
                {r.nombre}{r.inhabilitado && <span className="ml-1 text-[11px] text-text-tertiary">(inhabilitado)</span>}
              </span>
            ) },
            { key: "k", header: "Clientes", align: "right", render: (r: any) => <span className="font-semibold">{nfmt(r.clientes)}</span> },
            { key: "a", header: "Activos hoy", align: "right", render: (r: any) => nfmt(r.activos) },
          ]} />
        </ChartCard>
      </div>

      <ChartCard title="Clientes afiliados" subtitle="Cada cliente y el funcionario al que pertenece" icon="users">
        <DataTable rows={clientes} empty="No hay clientes afiliados en este periodo." columns={[
          { key: "f", header: "Fecha y hora del alta", render: (r: any) => fechaHora(r.fecha) },
          { key: "c", header: "Cliente", render: (r: any) => (
            <Link href={`/clientes/${r.id}`} className="text-brand hover:underline">
              {r.nombre ?? "Sin nombre"} <span className="text-text-tertiary">· {r.abonado}</span>
            </Link>
          ) },
          { key: "s", header: "Sede", render: (r: any) => r.sede ?? "—" },
          { key: "e", header: "Estado", render: (r: any) => r.estado ?? "—" },
          { key: "u", header: "Funcionario", render: (r: any) => <span className="font-medium text-text-primary">{r.funcionario ?? "—"}</span> },
          { key: "r", header: "Registró el alta", render: (r: any) => r.registradoPor ?? "—" },
        ]} />
      </ChartCard>
    </>
  );
}
