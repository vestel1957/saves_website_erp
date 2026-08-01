"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { TrendStat } from "@/components/charts";
import { useAuth } from "@/context/AuthProvider";
import { nfmt } from "@/lib/reportes";
import {
  DetalleTecnico,
  nivelRevisita,
  pctTxt,
  type CasoRevisita,
  type FilaPorTipo,
  type NivelRevisita,
} from "@/components/reportes/DetalleTecnico";

/**
 * Rendimiento del funcionario dentro de su ficha.
 *
 * Reemplaza al bloque "Actividad", que solo sabía contar plata y por eso salía en
 * ceros para los doce técnicos del área Operativa — justo las personas cuyo
 * trabajo sí está registrado orden por orden.
 *
 * Los números salen de `/staff/:id/rendimiento`, que es el mismo cálculo del
 * tablero de /reportes (ver `backend/src/reports/performance.service.ts`). No se
 * duplica ninguna métrica: si allá cambia la definición de re-visita, aquí cambia
 * sola.
 */

/** Nivel compartido, pintado como `tone` de tarjeta. */
const TONO_REVISITA: Record<NivelRevisita, "default" | "success" | "error" | "warning"> = {
  malo: "error",
  regular: "warning",
  bueno: "success",
  neutro: "default",
};

/**
 * Periodos ofrecidos. 90 días es el que trae el servicio por defecto y el
 * horizonte en que una conversación de desempeño todavía sirve; los otros dos
 * están para mirar la racha corta o el año.
 */
const PERIODOS = [
  { key: "30", label: "30 días", dias: 30 },
  { key: "90", label: "90 días", dias: 90 },
  { key: "365", label: "12 meses", dias: 365 },
] as const;

const iso = (d: Date) => d.toISOString().slice(0, 10);

type Resumen = {
  asignadas: number;
  cerradas: number;
  anuladas: number;
  abiertas: number;
  revisitas: number;
  revisitaPct: number | null;
  cicloHoras: number | null;
  cicloMedidas: number;
  firmaPct: number | null;
  vencidas: number;
  antiguedadDias: number | null;
  muestraSuficiente: boolean;
};

type Equipo = {
  medianaRevisita: number | null;
  ventanaRevisitaDias: number;
  muestraMinima: number;
  diasVencimiento: number;
};

type Datos = {
  resumen: Resumen | null;
  equipo: Equipo | null;
  porTipo: FilaPorTipo[];
  casos: CasoRevisita[];
};

export function RendimientoEmpleado({
  staffId,
  onDatos,
}: {
  staffId: string;
  /**
   * Avisa a la ficha si esta persona tiene trabajo de campo medible. Lo necesita
   * para saber si debe pintar el vacío general: el componente se borra solo
   * cuando no hay nada, y desde fuera eso no se puede ver.
   */
  onDatos?: (tiene: boolean) => void;
}) {
  const { authFetch } = useAuth();
  const [periodo, setPeriodo] = useState<string>("90");
  const [datos, setDatos] = useState<Datos | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(false);
    try {
      const dias = PERIODOS.find((p) => p.key === periodo)?.dias ?? 90;
      const hasta = new Date();
      const desde = new Date(hasta.getTime() - dias * 86400000);
      const qs = new URLSearchParams({ from: iso(desde), to: iso(hasta) });
      const r = await authFetch(`/staff/${staffId}/rendimiento?${qs}`);
      if (!r.ok) throw new Error(String(r.status));
      const d = await r.json();
      setDatos({ resumen: d.resumen ?? null, equipo: d.equipo ?? null, porTipo: d.porTipo ?? [], casos: d.casos ?? [] });
    } catch {
      setError(true);
      setDatos(null);
    } finally {
      setCargando(false);
    }
  }, [authFetch, staffId, periodo]);

  useEffect(() => { void cargar(); }, [cargar]);

  const resumen = datos?.resumen ?? null;
  const eq = datos?.equipo ?? null;
  // Sin órdenes de campo asignadas no hay rendimiento que mostrar. No es un
  // error ni un cero: es que el trabajo de esa persona no se mide por órdenes.
  const hayDatos = !!resumen && resumen.asignadas > 0;

  useEffect(() => {
    if (!cargando) onDatos?.(hayDatos && !error);
  }, [cargando, hayDatos, error, onDatos]);

  if (cargando) {
    return <div className="h-24 animate-pulse rounded-xl border border-border-subtle bg-surface-2" />;
  }
  // Un 403 (quien ve la ficha pero no tiene el permiso de RRHH) no debe gritar:
  // simplemente no se ve el bloque.
  if (error || !hayDatos || !datos || !resumen || !eq) return null;

  const nivel = nivelRevisita(resumen.revisitaPct, eq.medianaRevisita, resumen.muestraSuficiente);
  const diff =
    resumen.revisitaPct != null && eq.medianaRevisita != null && resumen.muestraSuficiente
      ? Math.round((resumen.revisitaPct - eq.medianaRevisita) * 10) / 10
      : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13px] font-bold text-text-primary">
          <Icon name="gauge" size={15} className="text-brand" />
          Rendimiento
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-surface p-0.5">
          {PERIODOS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setPeriodo(p.key)}
              className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                periodo === p.key ? "bg-brand text-on-brand" : "text-text-secondary hover:text-text-primary"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Qué se está midiendo. Sin esta línea, el lector asume que son TODAS sus
          órdenes, y los cortes y reconexiones quedan fuera a propósito. */}
      <p className="rounded-xl border border-border-subtle bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-text-secondary">
        Solo <strong>trabajo de campo</strong> (revisiones, instalaciones, traslados, mantenimiento). Los cortes y
        reconexiones no cuentan: los ejecuta el sistema y no miden a nadie. La cifra que manda es la{" "}
        <strong>re-visita</strong> — que el cliente haya vuelto a quejarse dentro de {eq.ventanaRevisitaDias} días del
        trabajo.
        {!resumen.muestraSuficiente && (
          <>
            {" "}
            <span className="text-warning-text">
              Con menos de {eq.muestraMinima} órdenes cerradas los porcentajes no son interpretables; están de contexto,
              no para calificar a nadie.
            </span>
          </>
        )}
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <TrendStat
          label="Órdenes de campo cerradas"
          value={nfmt(resumen.cerradas)}
          icon="clipboard-check"
          hint={
            resumen.anuladas
              ? `${nfmt(resumen.asignadas)} asignadas · ${nfmt(resumen.anuladas)} anuladas`
              : `${nfmt(resumen.asignadas)} asignadas en el periodo`
          }
        />
        <TrendStat
          label="Re-visita"
          value={pctTxt(resumen.revisitaPct)}
          icon="repeat"
          tone={TONO_REVISITA[nivel]}
          hint={
            diff == null
              ? `${nfmt(resumen.revisitas)} clientes volvieron a llamar`
              : `${diff > 0 ? "+" : ""}${diff} pts vs. la mediana del equipo (${pctTxt(eq.medianaRevisita)})`
          }
        />
        <TrendStat
          label="Sin cerrar"
          value={nfmt(resumen.abiertas)}
          icon="hourglass"
          tone={resumen.vencidas > 0 ? "warning" : "default"}
          hint={
            resumen.vencidas
              ? `${nfmt(resumen.vencidas)} pasan de ${eq.diasVencimiento} días${resumen.antiguedadDias != null ? ` · ${resumen.antiguedadDias}d de antigüedad promedio` : ""}`
              : "Ninguna pasada de plazo"
          }
        />
        <TrendStat
          label="Con firma del cliente"
          value={pctTxt(resumen.firmaPct)}
          icon="file-signature"
          tone={resumen.firmaPct != null && resumen.firmaPct < 90 ? "warning" : "default"}
          hint="Órdenes cerradas con quien recibió el trabajo"
        />
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <DetalleTecnico porTipo={datos.porTipo} casos={datos.casos} ventanaDias={eq.ventanaRevisitaDias} />
      </div>
    </div>
  );
}
