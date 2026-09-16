"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Input } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { listaJson, objetoJson } from "@/lib/errores";

/** La caja y el puerto elegidos. Es lo que viaja al backend (`napId` + `portId`). */
export type NapPort = { napId: string; napName: string; portId: string; portNumber: number };

type NapFila = {
  id: string; name: string; address: string | null; branch: string | null;
  deSuSede: boolean; puertos: number; libres: number;
};
type PuertoFila = {
  id: string; port: number; status: string; detail: string | null;
  client: string | null; subscriberId: string | null; mio: boolean; libre: boolean;
};

/**
 * Cierra el desplegable al pulsar fuera. En FASE DE CAPTURA a propósito: el panel
 * del Modal corta la propagación del `mousedown` y un detector normal montado en
 * `document` nunca se entera (ver `desplegable-dentro-de-modal`).
 */
function useCerrarAlPulsarFuera(activo: boolean, onFuera: () => void) {
  const caja = useRef<HTMLDivElement>(null);
  const cb = useRef(onFuera);
  cb.current = onFuera;
  useEffect(() => {
    if (!activo) return;
    const onDoc = (e: MouseEvent) => {
      if (caja.current && !caja.current.contains(e.target as Node)) cb.current();
    };
    document.addEventListener("mousedown", onDoc, true);
    return () => document.removeEventListener("mousedown", onDoc, true);
  }, [activo]);
  return caja;
}

/**
 * Elegir la CAJA NAP y el PUERTO donde queda colgado el equipo.
 *
 * Sustituye a las dos casillas numéricas que había en la entrega de equipos ("Caja
 * NAT" y "Puerto NAT"): lo que el legacy guarda ahí no son ni el nombre de la caja
 * ni el número rotulado en ella, sino dos ids internos (`idn` de `naps` e `idp` de
 * `puertos`). Nadie los sabe de memoria, así que la casilla se quedaba vacía —o
 * peor, con el número del puerto, que no es lo que espera el legacy—. Aquí se elige
 * la caja por su rótulo y el puerto por su número, y el servidor hace la traducción.
 *
 * El puerto se pinta como se mira la caja: una rejilla de números. Verde/marca = de
 * este cliente, gris con nombre = ocupado por otro (no se puede elegir, dos clientes
 * en el mismo puerto es una avería), y el resto libres.
 */
export function NapPortPicker({
  value, onChange, subscriberId,
}: {
  value: NapPort | null;
  onChange: (v: NapPort | null) => void;
  /** Para ofrecer primero las cajas de SU sede y marcar los puertos que ya son suyos. */
  subscriberId?: string;
}) {
  const { authFetch } = useAuth();
  const [abierto, setAbierto] = useState(false);
  const [busca, setBusca] = useState("");
  const [naps, setNaps] = useState<NapFila[]>([]);
  const [cargandoNaps, setCargandoNaps] = useState(false);
  /** La caja abierta: la elegida, o la que se acaba de pulsar en la lista. */
  const [nap, setNap] = useState<{ id: string; name: string } | null>(
    value ? { id: value.napId, name: value.napName } : null,
  );
  const [ports, setPorts] = useState<PuertoFila[]>([]);
  const [cargandoPorts, setCargandoPorts] = useState(false);
  const caja = useCerrarAlPulsarFuera(abierto, () => setAbierto(false));

  // Lista de cajas: del servidor. Son 1.406 y sin texto se ofrecen las de la sede
  // del cliente, que son las que pueden estar de verdad en su poste.
  useEffect(() => {
    if (!abierto) return;
    const q = busca.trim();
    const t = setTimeout(() => {
      const p = new URLSearchParams();
      if (q) p.set("search", q);
      if (subscriberId) p.set("subscriberId", subscriberId);
      setCargandoNaps(true);
      void authFetch(`/support/naps?${p.toString()}`)
        .then(listaJson)
        .then((l) => setNaps(l as NapFila[]))
        .catch(() => setNaps([]))
        .finally(() => setCargandoNaps(false));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [abierto, busca, authFetch, subscriberId]);

  const cargarPuertos = useCallback(async (napId: string) => {
    setCargandoPorts(true);
    try {
      const p = new URLSearchParams();
      if (subscriberId) p.set("subscriberId", subscriberId);
      const d: any = await objetoJson(await authFetch(`/support/naps/${napId}/ports?${p.toString()}`));
      setPorts((d?.ports ?? []) as PuertoFila[]);
    } catch { setPorts([]); } finally { setCargandoPorts(false); }
  }, [authFetch, subscriberId]);

  useEffect(() => { if (nap) void cargarPuertos(nap.id); }, [nap, cargarPuertos]);

  const elegirNap = (n: NapFila) => {
    setNap({ id: n.id, name: n.name });
    setAbierto(false);
    setBusca("");
    // Cambiar de caja invalida el puerto: era un puerto de la otra.
    if (value && value.napId !== n.id) onChange(null);
  };

  const elegirPuerto = (p: PuertoFila) => {
    if (!nap) return;
    if (value?.portId === p.id) { onChange(null); return; }
    onChange({ napId: nap.id, napName: nap.name, portId: p.id, portNumber: p.port });
  };

  return (
    <div className="flex flex-col gap-2">
      {/* La caja */}
      <div ref={caja} className="relative">
        {nap && !abierto ? (
          <div className="flex items-center gap-2 rounded-lg border border-border-default bg-surface px-3 py-2">
            <Icon name="network" size={14} className="shrink-0 text-text-tertiary" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-text-primary">{nap.name}</span>
            <button
              type="button" onClick={() => { setAbierto(true); setBusca(""); }}
              className="shrink-0 rounded-md px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-2"
            >
              Cambiar caja
            </button>
          </div>
        ) : (
          <>
            <Icon name="search" size={14} className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-text-tertiary" />
            <Input
              value={busca}
              onFocus={() => setAbierto(true)}
              onChange={(e) => { setBusca(e.target.value); setAbierto(true); }}
              placeholder="Busca la caja NAP por nombre o dirección…"
              className="pl-9"
            />
          </>
        )}

        {abierto && (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-xl border border-border-default bg-surface shadow-lg">
            {naps.length === 0 ? (
              <p className="px-3 py-4 text-center text-[12px] text-text-tertiary">
                {cargandoNaps ? "Buscando…" : busca.trim() ? "Ninguna caja con ese nombre." : "No hay cajas NAP registradas."}
              </p>
            ) : (
              <ul className="divide-y divide-border-subtle">
                {naps.map((n) => (
                  <li key={n.id}>
                    <button
                      type="button" onClick={() => elegirNap(n)}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors hover:bg-surface-2 ${nap?.id === n.id ? "bg-brand-soft" : ""}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold text-text-primary">{n.name}</span>
                        <span className="block truncate text-[11px] text-text-tertiary">
                          {[n.branch, n.address].filter(Boolean).join(" · ") || "Sin dirección"}
                        </span>
                      </span>
                      <span className={`shrink-0 text-[11px] font-medium ${n.libres ? "text-success-text" : "text-text-tertiary"}`}>
                        {n.libres} de {n.puertos} libres
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      {/* Los puertos de esa caja */}
      {nap && (
        cargandoPorts ? (
          <p className="text-[12px] text-text-tertiary">Abriendo la caja…</p>
        ) : ports.length === 0 ? (
          <p className="text-[12px] text-warning-text">
            Esta caja no tiene puertos registrados: elige otra o regístralos en Red › NAPs.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {ports.map((p) => {
                const puesto = value?.portId === p.id;
                const ajeno = !p.libre && !p.mio;
                return (
                  <button
                    key={p.id} type="button" disabled={ajeno}
                    onClick={() => elegirPuerto(p)}
                    title={[
                      ajeno ? `Puerto ${p.port}: ocupado por ${p.client ?? "otro cliente"}` : p.mio ? `Puerto ${p.port}: ya es de este cliente` : `Puerto ${p.port}: libre`,
                      // El legacy repite números dentro de una misma caja: sin el
                      // detalle no hay forma de distinguir dos botones con el mismo 2.
                      p.detail,
                    ].filter(Boolean).join(" · ")}
                    className={`h-9 w-9 rounded-lg border text-[12px] font-semibold transition-colors ${
                      puesto
                        ? "border-brand bg-brand text-on-brand"
                        : ajeno
                          ? "cursor-not-allowed border-border-subtle bg-surface-2 text-text-tertiary opacity-60"
                          : p.mio
                            ? "border-brand bg-brand-soft text-brand hover:bg-brand/15"
                            : "border-border-default bg-surface text-text-secondary hover:border-brand hover:text-brand"
                    }`}
                  >
                    {p.port}
                  </button>
                );
              })}
            </div>
            <p className="text-[11px] text-text-tertiary">
              {value
                ? `Caja ${value.napName}, puerto ${value.portNumber}.`
                : "Pulsa el puerto donde queda colgado el equipo. Los apagados ya tienen cliente."}
            </p>
          </>
        )
      )}
    </div>
  );
}
