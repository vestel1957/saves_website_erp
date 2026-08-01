"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";
import { MOTIVO_GEO, formatearDistancia, pedirUbicacion } from "@/lib/geo";
import { formatearDuracion, type Ruta } from "@/lib/mapa";
import { COLOR_ESTADO, type PuntoMapa } from "@/components/map/Mapa";

const Mapa = dynamic(() => import("@/components/map/Mapa").then((m) => m.Mapa), {
  ssr: false,
  loading: () => <div className="h-full w-full animate-pulse rounded-xl bg-surface-2" />,
});

/**
 * Cómo llegar, a pantalla completa.
 *
 * Empezó dentro de un modal y era inservible: una ruta en 288 px de alto no se
 * lee. Un trayecto necesita el alto de la pantalla, porque lo que se mira no es
 * el número de kilómetros sino POR DÓNDE va — qué barrio, qué vía, si cruza el
 * río. Además el técnico la consulta en el móvil, donde un modal se come la
 * mitad de la pantalla con su propio marco.
 *
 * Destino por `?abonado=<id>` (el nombre y las coordenadas se resuelven en el
 * servidor) o por `?lat=&lng=` con `?nombre=` para cualquier otro punto, como
 * una caja NAP.
 */
function RutaVista() {
  const router = useRouter();
  const params = useSearchParams();
  const { loading: authLoading, authFetch } = useAuth();

  const abonado = params.get("abonado");
  const lat = Number(params.get("lat"));
  const lng = Number(params.get("lng"));
  const nombreParam = params.get("nombre");
  const volverA = params.get("volver");

  const [ruta, setRuta] = useState<Ruta | null>(null);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const trazar = useCallback(async () => {
    setCargando(true);
    setError(null);
    try {
      const yo = await pedirUbicacion();
      if (!yo.ok) {
        setError(`No se puede trazar la ruta sin saber dónde estás. ${MOTIVO_GEO[yo.motivo]}`);
        return;
      }
      const destino = abonado
        ? { subscriberId: abonado }
        : Number.isFinite(lat) && Number.isFinite(lng)
          ? { toLat: lat, toLng: lng }
          : null;
      if (!destino) {
        setError("Falta el destino: abre esta pantalla desde un cliente o desde el mapa.");
        return;
      }
      const res = await authFetch("/geo/route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fromLat: yo.lat, fromLng: yo.lng, ...destino }),
      });
      if (!res.ok) {
        const cuerpo = await res.json().catch(() => null);
        throw new Error(cuerpo?.message ?? `Error ${res.status}`);
      }
      setRuta((await res.json()) as Ruta);
    } catch (e) {
      setError(mensajeDeError(e, "No se pudo calcular la ruta"));
    } finally {
      setCargando(false);
    }
  }, [abonado, lat, lng, authFetch]);

  useEffect(() => {
    if (!authLoading) void trazar();
  }, [authLoading, trazar]);

  if (authLoading) return <PageSkeleton />;

  const nombre = ruta?.nombre ?? nombreParam ?? "Destino";

  const puntos: PuntoMapa[] = ruta
    ? [
        {
          id: "yo",
          tipo: "yo",
          lat: ruta.origen.lat,
          lng: ruta.origen.lng,
          titulo: "Estás aquí",
          detalles: [{ label: "Origen", valor: "Tu ubicación actual" }],
        },
        {
          id: "destino",
          tipo: "abonado",
          lat: ruta.destino.lat,
          lng: ruta.destino.lng,
          titulo: nombre,
          color: COLOR_ESTADO.CORTADO,
          href: abonado ? `/clientes/${abonado}` : undefined,
        },
      ]
    : [];

  const navExterna = ruta
    ? `https://www.google.com/maps/dir/?api=1&origin=${ruta.origen.lat},${ruta.origen.lng}` +
      `&destination=${ruta.destino.lat},${ruta.destino.lng}&travelmode=driving`
    : null;

  return (
    <div className="flex h-[calc(100vh-7rem)] min-h-[520px] flex-col">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <PageHeading icon="navigation" title="Cómo llegar" subtitle={nombre} showBack={false} />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" onClick={() => (volverA ? router.push(volverA) : router.back())}>
            <Icon name="arrow-left" size={14} /> Volver
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void trazar()} disabled={cargando}>
            <Icon name={cargando ? "loader" : "refresh-cw"} size={14} className={cargando ? "animate-spin" : ""} />
            Recalcular
          </Button>
          {navExterna && (
            // La app nativa da voz y tráfico en vivo; un mapa embebido no. Pero
            // se abre solo si el técnico lo pide.
            <a
              href={navExterna}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hover"
            >
              <Icon name="navigation" size={14} /> Navegar por voz
            </a>
          )}
        </div>
      </div>

      {/* Resumen del trayecto */}
      {ruta && (
        <div className="mb-2 flex flex-wrap items-baseline gap-x-5 gap-y-1 rounded-lg border border-border-subtle bg-surface px-4 py-2.5">
          <span className="text-[26px] font-bold leading-none text-text-primary">
            {formatearDistancia(ruta.distanceM)}
          </span>
          {ruta.durationS != null && (
            <span className="text-[14px] font-semibold text-text-secondary">
              ≈ {formatearDuracion(ruta.durationS)} en carro
            </span>
          )}
          {abonado && (
            <Link
              href={`/clientes/${abonado}`}
              className="text-[12.5px] font-semibold text-brand hover:underline"
            >
              Abrir ficha del cliente →
            </Link>
          )}
          <span className="ml-auto font-mono text-[11.5px] text-text-tertiary">
            {ruta.destino.lat.toFixed(6)}, {ruta.destino.lng.toFixed(6)}
          </span>
        </div>
      )}

      {ruta?.aproximada && (
        <p className="mb-2 rounded-lg border border-warning bg-warning-soft px-3 py-2 text-[12.5px] text-text-secondary">
          No se pudo calcular el camino por carretera, así que la línea punteada es la distancia{" "}
          <strong>en línea recta</strong>. El recorrido real será mayor.
        </p>
      )}

      {error && (
        <div className="mb-2 flex flex-wrap items-center gap-3 rounded-lg border border-error bg-error-soft px-3 py-2">
          <Icon name="alert-circle" size={16} className="text-error-text" />
          <span className="text-[12.5px] text-text-secondary">{error}</span>
          <Button variant="secondary" size="sm" onClick={() => void trazar()} className="ml-auto">
            Reintentar
          </Button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border-subtle">
        {cargando && !ruta ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-surface-2">
            <Icon name="loader" size={26} className="animate-spin text-brand" />
            <p className="text-[13px] text-text-secondary">Buscando tu ubicación y trazando la ruta…</p>
          </div>
        ) : (
          <Mapa
            puntos={puntos}
            ruta={ruta?.geometry ?? null}
            rutaAproximada={ruta?.aproximada ?? false}
            onAbrir={(href) => router.push(href)}
          />
        )}
      </div>
    </div>
  );
}

export default function RutaPage() {
  // `useSearchParams` obliga a un límite de Suspense en el App Router.
  return (
    <Suspense fallback={<PageSkeleton />}>
      <RutaVista />
    </Suspense>
  );
}
