"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Input, Select } from "@/components/ui/Field";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { LoadError } from "@/components/ui/LoadError";
import { useAuth } from "@/context/AuthProvider";
import { useRequest } from "@/lib/useRequest";
import { PERM } from "@/lib/auth";
import type { BranchOpt } from "@/lib/network";
import { COLOR_ESTADO, type PuntoMapa } from "@/components/map/Mapa";
import { CENTRO_POR_DEFECTO } from "@/lib/geo";
import {
  COLOR_TECNICO_FRIO,
  COLOR_TECNICO_VIVO,
  MOTIVO_PING,
  TECNICO_EN_VIVO_MIN,
  haceCuanto,
  type CoberturaGeo,
  type PuntoTecnico,
  type PuntosMapa,
} from "@/lib/mapa";

// Leaflet toca `window` al importarse: fuera del render del servidor.
const Mapa = dynamic(() => import("@/components/map/Mapa").then((m) => m.Mapa), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-xl bg-surface-2" />,
});

type Capa = "abonados" | "naps" | "tecnicos";

/** Cada cuánto se vuelve a pedir la posición de los técnicos (ellos laten cada minuto). */
const REFRESCO_TECNICOS_MS = 30_000;

function Chip({
  activo,
  onClick,
  color,
  children,
  n,
}: {
  activo: boolean;
  onClick: () => void;
  color: string;
  children: React.ReactNode;
  n?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-semibold transition-colors ${
        activo
          ? "border-border-default bg-surface text-text-primary"
          : "border-border-subtle bg-surface-2 text-text-tertiary"
      }`}
    >
      <span
        className="h-2.5 w-2.5 rounded-full"
        style={{ background: color, opacity: activo ? 1 : 0.35 }}
      />
      {children}
      {n != null && <span className="text-text-tertiary">{n.toLocaleString("es-CO")}</span>}
    </button>
  );
}

export default function MapaPage() {
  const router = useRouter();
  const { loading: authLoading, can, sedeScoped } = useAuth();
  const verTecnicos = can([PERM.AREA_GERENCIA, PERM.AREA_ADMINISTRACION, PERM.AREA_SISTEMAS]);

  const [q, setQ] = useState("");
  const [sede, setSede] = useState("");
  const [capas, setCapas] = useState<Record<Capa, boolean>>({
    abonados: true,
    naps: true,
    tecnicos: true,
  });

  const alternar = (c: Capa) => setCapas((v) => ({ ...v, [c]: !v[c] }));

  const branches = useRequest<BranchOpt[]>(() => "/network/branches", [], { saltar: authLoading });

  const puntos = useRequest<PuntosMapa>(
    () => {
      const p = new URLSearchParams();
      if (q.trim()) p.set("q", q.trim());
      if (sede) p.set("sede", sede);
      p.set("subs", capas.abonados ? "1" : "0");
      p.set("naps", capas.naps ? "1" : "0");
      return `/geo/points?${p}`;
    },
    [q, sede, capas.abonados, capas.naps],
    { debounceMs: 350, saltar: authLoading },
  );

  const tecnicos = useRequest<PuntoTecnico[]>(() => "/geo/technicians", [], {
    saltar: authLoading || !verTecnicos,
  });

  // Los técnicos se mueven; los abonados y las NAPs no. Solo esta capa se vuelve
  // a pedir sola, y solo mientras alguien está mirando de verdad la pestaña —
  // dejar el mapa abierto en una pantalla de la oficina no debe estar pegándole
  // a la API toda la tarde. Al volver a la pestaña se refresca al momento.
  const refrescarTecnicos = tecnicos.refrescar;
  useEffect(() => {
    if (!verTecnicos || !capas.tecnicos) return;
    const tic = () => {
      if (document.visibilityState === "visible") refrescarTecnicos();
    };
    const id = setInterval(tic, REFRESCO_TECNICOS_MS);
    document.addEventListener("visibilitychange", tic);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tic);
    };
  }, [verTecnicos, capas.tecnicos, refrescarTecnicos]);

  const cobertura = useRequest<CoberturaGeo>(() => "/geo/coverage", [], { saltar: authLoading });

  const marcadores = useMemo<PuntoMapa[]>(() => {
    const out: PuntoMapa[] = [];
    if (capas.abonados) {
      for (const s of puntos.data?.subscribers ?? []) {
        out.push({
          id: `s-${s.id}`,
          tipo: "abonado",
          lat: s.lat,
          lng: s.lng,
          titulo: `${s.name} · #${s.abonado}`,
          color: COLOR_ESTADO[s.status ?? ""] ?? "#64748b",
          href: `/clientes/${s.id}`,
          rutaHasta: true,
          detalles: [
            { label: "Estado", valor: s.status },
            { label: "Dirección", valor: s.address },
            { label: "Teléfono", valor: s.phone },
            { label: "Sede", valor: s.sede },
          ],
        });
      }
    }
    if (capas.naps) {
      for (const n of puntos.data?.naps ?? []) {
        out.push({
          id: `n-${n.id}`,
          tipo: "nap",
          lat: n.lat,
          lng: n.lng,
          titulo: `NAP ${n.name}`,
          href: `/red/naps/${n.id}`,
          rutaHasta: true,
          detalles: [
            { label: "Dirección", valor: n.address },
            { label: "Puertos", valor: `${n.ports} de ${n.portCount}` },
            { label: "Sede", valor: n.sede },
          ],
        });
      }
    }
    if (capas.tecnicos && verTecnicos) {
      for (const t of tecnicos.data ?? []) {
        // Un pin no distingue "está ahí" de "estuvo ahí esta mañana", y esa
        // diferencia es justo la que se mira. El color la dice sin abrir nada.
        const enVivo = t.minutosDesde <= TECNICO_EN_VIVO_MIN;
        out.push({
          id: `t-${t.userId}`,
          tipo: "tecnico",
          lat: t.lat,
          lng: t.lng,
          titulo: t.userName,
          color: enVivo ? COLOR_TECNICO_VIVO : COLOR_TECNICO_FRIO,
          // Con precisión mala el pin miente; el círculo enseña el margen real.
          radioM: t.accuracy && t.accuracy > 60 ? t.accuracy : undefined,
          detalles: [
            {
              label: "Visto",
              valor: enVivo
                ? `en vivo · ${haceCuanto(t.minutosDesde)}`
                : haceCuanto(t.minutosDesde),
            },
            { label: "Al", valor: MOTIVO_PING[t.reason] ?? t.reason },
            { label: "Precisión", valor: t.accuracy ? `±${Math.round(t.accuracy)} m` : null },
          ],
          href: t.refType === "subscriber" && t.refId ? `/clientes/${t.refId}` : undefined,
        });
      }
    }
    return out;
  }, [puntos.data, tecnicos.data, capas, verTecnicos]);

  if (authLoading) return <PageSkeleton />;

  const cob = cobertura.data;
  const pctActivos = cob?.totalActivos ? Math.round((cob.conGpsActivos / cob.totalActivos) * 100) : null;

  return (
    <div className="flex h-[calc(100vh-7rem)] min-h-[520px] flex-col">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <PageHeading
          icon="map-pin"
          title="Mapa"
          subtitle="Abonados, cajas NAP y última posición de los técnicos"
        />
        {pctActivos != null && (
          <div className="rounded-lg border border-border-subtle bg-surface px-3 py-1.5 text-right">
            <p className="text-[11px] text-text-tertiary">Abonados activos con GPS</p>
            <p className="text-[15px] font-bold text-text-primary">
              {pctActivos}%{" "}
              <span className="text-[11px] font-medium text-text-tertiary">
                ({cob!.conGpsActivos.toLocaleString("es-CO")} de{" "}
                {cob!.totalActivos.toLocaleString("es-CO")})
              </span>
            </p>
          </div>
        )}
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative w-64">
          <Icon
            name="search"
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
          />
          <Input
            className="pl-9"
            placeholder="Nombre, nº de abonado o dirección…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {/* Quien está acotado a su sede no la elige: el mapa ya le llega recortado. */}
        {!sedeScoped && (
          <Select value={sede} onChange={(e) => setSede(e.target.value)} className="w-44">
            <option value="">Todas las sedes</option>
            {(branches.data ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        )}
        <Chip
          activo={capas.abonados}
          onClick={() => alternar("abonados")}
          color={COLOR_ESTADO.ACTIVO}
          n={puntos.data?.subscribers.length}
        >
          Abonados
        </Chip>
        <Chip
          activo={capas.naps}
          onClick={() => alternar("naps")}
          color="#0e7490"
          n={puntos.data?.naps.length}
        >
          Cajas NAP
        </Chip>
        {verTecnicos && (
          <Chip
            activo={capas.tecnicos}
            onClick={() => alternar("tecnicos")}
            color={COLOR_TECNICO_VIVO}
            n={tecnicos.data?.length}
          >
            Técnicos
          </Chip>
        )}
        {puntos.cargando && (
          <span className="text-[12px] text-text-tertiary">Cargando puntos…</span>
        )}
      </div>

      {puntos.data?.truncated && (
        <p className="mb-2 rounded-lg border border-warning bg-warning-soft px-3 py-1.5 text-[12px] text-text-secondary">
          Hay más puntos de los que el mapa dibuja de una vez. Filtra por sede o busca para verlos
          todos.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border-subtle">
        {puntos.error ? (
          <LoadError message={puntos.error} onRetry={puntos.refrescar} />
        ) : (
          <Mapa
            puntos={marcadores}
            centro={CENTRO_POR_DEFECTO}
            onAbrir={(href) => router.push(href)}
            onComoLlegar={(d) => router.push(`/mapa/ruta?lat=${d.lat}&lng=${d.lng}&volver=${encodeURIComponent("/mapa")}`)}
          />
        )}
      </div>

      {!puntos.cargando && marcadores.length === 0 && (
        <p className="mt-2 text-center text-[12.5px] text-text-tertiary">
          Ningún punto que mostrar. Solo aparecen en el mapa los abonados que tienen coordenadas
          guardadas — se capturan desde la ficha del cliente con el botón “Capturar GPS aquí”.
        </p>
      )}
    </div>
  );
}
