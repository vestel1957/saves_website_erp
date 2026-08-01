"use client";

import { useState } from "react";
import { ChartCard, HBarList, TrendStat } from "@/components/charts";
import { DataTable } from "@/components/ui/DataTable";
import { Icon } from "@/components/Icon";
import { useAuth } from "@/context/AuthProvider";
import { nfmt } from "@/lib/reportes";
import { Section } from "./Section";
import { DetalleTecnico, nivelRevisita, pctTxt, type CasoRevisita, type FilaPorTipo, type NivelRevisita } from "./DetalleTecnico";

type Tecnico = {
  staffId: string; nombre: string;
  asignadas: number; cerradas: number; anuladas: number; abiertas: number;
  revisitas: number; revisitaPct: number | null;
  cicloHoras: number | null; cicloMedidas: number;
  evidenciaPct: number | null; firmaPct: number | null;
  geoOk: number; geoFuera: number; muestraSuficiente: boolean;
  vencidas: number; antiguedadDias: number | null;
};

/** El nivel compartido, pintado como clases de texto para la tabla. */
const CLASE_REVISITA: Record<NivelRevisita, string> = {
  malo: "text-error-text font-semibold",
  regular: "text-warning-text font-semibold",
  bueno: "text-success-text font-semibold",
  neutro: "text-text-secondary",
};

/**
 * Ficha desplegable de un técnico. Carga bajo demanda (son dos consultas caras)
 * y delega el pintado en `DetalleTecnico`, que comparte con la ficha del empleado.
 */
function Ficha({ staffId, from, to, filtros, ventanaDias }: { staffId: string; from: string; to: string; filtros: Record<string, string>; ventanaDias?: number }) {
  const { authFetch } = useAuth();
  const [detalle, setDetalle] = useState<{ casos: CasoRevisita[]; porTipo: FilaPorTipo[] } | null>(null);
  const [cargando, setCargando] = useState(false);

  const cargar = async () => {
    setCargando(true);
    try {
      const qs = new URLSearchParams();
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      // Los filtros del tablero viajan a la ficha: si se está mirando Yopal, el
      // detalle también tiene que ser de Yopal o los números no cuadran.
      for (const [k, v] of Object.entries(filtros ?? {})) if (v) qs.set(k, v);
      const d = await (await authFetch(`/reports/tecnicos/${staffId}?${qs}`)).json();
      setDetalle({ casos: d.casos ?? [], porTipo: d.porTipo ?? [] });
    } finally {
      setCargando(false);
    }
  };

  if (detalle === null) {
    return (
      <button onClick={cargar} disabled={cargando}
        className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-brand hover:underline disabled:opacity-50">
        <Icon name="list-tree" size={13} /> {cargando ? "Buscando…" : "Ver en qué falla y qué órdenes volvieron"}
      </button>
    );
  }

  return <DetalleTecnico porTipo={detalle.porTipo} casos={detalle.casos} ventanaDias={ventanaDias} />;
}

export function RendimientoTecnicos({ data, from, to }: { data: any; from: string; to: string }) {
  const [abierto, setAbierto] = useState<string | null>(null);
  const eq = data.equipo;
  const tecnicos: Tecnico[] = data.tecnicos ?? [];

  if (!eq || !tecnicos.length) {
    return (
      <ChartCard title="Sin datos en el periodo" icon="users">
        <p className="p-4 text-[13px] text-text-secondary">
          No hay órdenes de campo atribuidas a ningún técnico en este rango. Prueba con un periodo más amplio.
        </p>
      </ChartCard>
    );
  }

  // Peor re-visita primero: el tablero existe para encontrar falencias, no para
  // premiar. Los de muestra baja van al final, porque su porcentaje no se puede
  // leer y encabezar la lista con ellos sería señalar a quien menos datos tiene.
  const orden = [...tecnicos].sort((a, b) => {
    if (a.muestraSuficiente !== b.muestraSuficiente) return a.muestraSuficiente ? -1 : 1;
    return (b.revisitaPct ?? -1) - (a.revisitaPct ?? -1);
  });

  return (
    <>
      {/* Qué se está midiendo. Va primero a propósito: sin esto, el lector asume
          que la tabla es todo el trabajo del equipo, y no lo es. */}
      <div className="rounded-xl border border-border-subtle bg-surface-2 p-3 text-[12px] leading-relaxed text-text-secondary">
        <div className="mb-1 flex items-center gap-1.5 font-semibold text-text-primary">
          <Icon name="info" size={14} className="text-brand" /> Qué mide este tablero
        </div>
        Solo <strong>trabajo de campo</strong> ({nfmt(data.tiposCampo?.length ?? 0)} tipos de orden: revisiones,
        instalaciones, traslados, mantenimiento de red). Los cortes y reconexiones quedan fuera porque los
        ejecuta el sistema y no miden a nadie.
        {" "}La cifra que manda es la <strong>re-visita</strong>: el cliente volvió a quejarse dentro de{" "}
        {eq.ventanaRevisitaDias} días del trabajo. Menos re-visita = trabajo que quedó bien hecho.
        {data.sinAtribuir > 0 && (
          <> {" "}<span className="text-warning-text">
            {nfmt(data.sinAtribuir)} órdenes de campo del periodo no tienen técnico asignado y no entran en ninguna fila.
          </span></>
        )}
      </div>

      <Section>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <TrendStat label="Órdenes de campo cerradas" value={nfmt(eq.cerradas)} icon="clipboard-check"
            hint={`${nfmt(eq.tecnicos)} técnicos · ${nfmt(eq.conMuestra)} con muestra suficiente`} />
          <TrendStat label="Re-visita del equipo" value={pctTxt(eq.revisitaPct)} icon="repeat"
            tone={eq.revisitaPct != null && eq.revisitaPct > 15 ? "error" : eq.revisitaPct != null && eq.revisitaPct > 10 ? "warning" : "success"}
            hint={`${nfmt(eq.revisitas)} clientes volvieron a llamar`} />
          <TrendStat label="Mediana por técnico" value={pctTxt(eq.medianaRevisita)} icon="target"
            hint="La referencia contra la que se compara cada uno" />
          <TrendStat label="Órdenes con foto" value={pctTxt(eq.medianaEvidencia)} icon="camera"
            tone={eq.medianaEvidencia != null && eq.medianaEvidencia < 50 ? "warning" : "default"}
            hint="Mediana del equipo · evidencia del trabajo" />
          <TrendStat label="Sin cerrar" value={nfmt(eq.abiertas ?? 0)} icon="hourglass"
            tone={eq.vencidas > 0 ? "warning" : "default"}
            hint={eq.vencidas ? `${nfmt(eq.vencidas)} llevan más de ${eq.diasVencimiento} días abiertas` : "Ninguna pasada de plazo"} />
        </div>
      </Section>

      <ChartCard title="Re-visita por técnico" subtitle={`Mediana del equipo: ${pctTxt(eq.medianaRevisita)} · más bajo es mejor`} icon="repeat">
        <HBarList monochrome accent="var(--color-warning)"
          valueFormat={(v: number) => `${v}%`}
          rows={orden.filter((t) => t.muestraSuficiente && t.revisitaPct != null).map((t) => ({
            label: t.nombre, value: t.revisitaPct as number, hint: `${nfmt(t.revisitas)} de ${nfmt(t.cerradas)} órdenes`,
          }))} />
      </ChartCard>

      <ChartCard title="Detalle por técnico" subtitle="Toca una fila para ver los casos concretos" icon="users">
        <DataTable rows={orden} empty="Sin técnicos con órdenes de campo."
          onRowClick={(r: Tecnico) => setAbierto(abierto === r.staffId ? null : r.staffId)}
          columns={[
            {
              key: "n", header: "Técnico", render: (r: Tecnico) => (
                <div className="flex items-center gap-1.5">
                  <Icon name={abierto === r.staffId ? "chevron-down" : "chevron-right"} size={13} className="text-text-tertiary" />
                  <span className="font-medium text-text-primary">{r.nombre}</span>
                  {!r.muestraSuficiente && (
                    <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-tertiary" title={`Menos de ${eq.muestraMinima} órdenes cerradas: los porcentajes no son interpretables`}>
                      muestra baja
                    </span>
                  )}
                </div>
              ),
            },
            { key: "cerr", header: "Cerradas", align: "right", render: (r: Tecnico) => nfmt(r.cerradas) },
            {
              key: "abie", header: "Sin cerrar", align: "right", render: (r: Tecnico) => {
                if (!r.abiertas) return <span className="text-text-tertiary">—</span>;
                // La antigüedad importa más que la cantidad: 3 órdenes de hace
                // 40 días son peor noticia que 8 de ayer.
                const viejo = (r.antiguedadDias ?? 0) >= eq.diasVencimiento;
                return (
                  <span className={viejo ? "text-warning-text font-semibold" : "text-text-secondary"}
                    title={r.antiguedadDias != null ? `Antigüedad promedio: ${r.antiguedadDias} días · ${nfmt(r.vencidas)} pasadas de plazo` : undefined}>
                    {nfmt(r.abiertas)}
                    {r.antiguedadDias != null && <span className="ml-1 text-[11px] font-normal">({r.antiguedadDias}d)</span>}
                  </span>
                );
              },
            },
            {
              key: "rev", header: "Re-visita", align: "right", render: (r: Tecnico) => (
                <span className={CLASE_REVISITA[nivelRevisita(r.revisitaPct, eq.medianaRevisita, r.muestraSuficiente)]}
                  title={`${nfmt(r.revisitas)} de ${nfmt(r.cerradas)} órdenes trajeron queja`}>
                  {pctTxt(r.revisitaPct)}
                </span>
              ),
            },
            {
              key: "vs", header: "vs. mediana", align: "right", render: (r: Tecnico) => {
                if (r.revisitaPct == null || eq.medianaRevisita == null || !r.muestraSuficiente) return "—";
                const d = Math.round((r.revisitaPct - eq.medianaRevisita) * 10) / 10;
                if (Math.abs(d) < 0.05) return <span className="text-text-tertiary">igual</span>;
                return <span className={d > 0 ? "text-error-text" : "text-success-text"}>{d > 0 ? "+" : ""}{d} pts</span>;
              },
            },
            { key: "firma", header: "Con firma", align: "right", render: (r: Tecnico) => (
              <span className={r.firmaPct != null && r.firmaPct < 90 ? "text-warning-text font-semibold" : "text-text-secondary"}>{pctTxt(r.firmaPct)}</span>
            ) },
            { key: "foto", header: "Con foto", align: "right", render: (r: Tecnico) => pctTxt(r.evidenciaPct) },
            {
              key: "ciclo", header: "Ciclo", align: "right", render: (r: Tecnico) =>
                r.cicloHoras == null
                  ? <span className="text-text-tertiary" title="Se empieza a medir con las órdenes asignadas y cerradas desde ahora: el histórico no guarda la hora.">aún no</span>
                  : <span title={`Promedio sobre ${nfmt(r.cicloMedidas)} órdenes`}>{r.cicloHoras} h</span>,
            },
          ]} />
      </ChartCard>

      {abierto && (
        <ChartCard title={`Casos de ${tecnicos.find((t) => t.staffId === abierto)?.nombre ?? ""}`}
          subtitle={`Órdenes cerradas cuyo cliente volvió a quejarse en ${eq.ventanaRevisitaDias} días`} icon="alert-triangle">
          <div className="p-3">
            <Ficha staffId={abierto} from={from} to={to} filtros={data.filtros ?? {}} ventanaDias={eq.ventanaRevisitaDias} />
          </div>
        </ChartCard>
      )}
    </>
  );
}
