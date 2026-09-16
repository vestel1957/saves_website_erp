"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/context/AuthProvider";
import { rxTone, runTone } from "@/lib/olt";
import { dbm, duracion, fraseRx } from "@/components/network/SenalOptica";
import type { EquipoUbicar } from "./UbicarEquipoModal";

/** Lo que la ficha trae de cada equipo (ver `subscribers.service`, `equipment`). */
export type EquipoFicha = EquipoUbicar & {
  brand?: string | null;
  installType?: string | null;
  status?: string | null;
  warehouse?: string | null;
  arrival?: string | null;
  assignedAt?: string | null;
};

type Optica = {
  ok: boolean;
  motivo?: "SIN_ONU" | "OLT";
  error?: string;
  olt?: { id: string; name: string };
  onu?: { sn: string | null; fsp: string; ontId: number; descripcion: string | null };
  estado?: {
    run: string | null; config: string | null; match: string | null;
    distancia: number | null; ultimaCaida: string | null; causaCaida: string | null; desdeCuando: string | null;
  };
  optica?: {
    rx: number | null; tx: number | null; oltRx: number | null;
    temperatura: number | null; voltaje: number | null; corriente: number | null;
  };
  avisoOptica?: string;
  avisoVinculo?: string;
  consultadoEn?: string;
};
type LecturaVlan = { ok: boolean; motivo?: string; vlan: number | null; vlans?: number[]; error?: string; olt?: { name: string } };
type PuertoFila = { id: string; port: number; libre: boolean; mio: boolean; client: string | null };
type Caja = { nap: { name: string; address: string | null; branch: string | null; portCount: number }; ports: PuertoFila[] };

/** Fondo + borde + texto de cada tono, para los nodos de la cadena y las potencias. */
const TONO: Record<string, string> = {
  success: "border-success-text/25 bg-success-soft text-success-text",
  warning: "border-warning-text/25 bg-warning-soft text-warning-text",
  error: "border-error-text/25 bg-error-soft text-error-text",
  default: "border-border-subtle bg-surface text-text-primary",
  vacio: "border-dashed border-border-strong bg-surface-2 text-text-tertiary",
};

const fecha = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString("es-CO", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : null;

/** Un serial de ONU se parece a ZTEGDE519CDF o a 5A544547DE519CDF; "solicitar" no. */
const pareceSerialOnu = (s?: string | null) => !!s && /^[A-Z0-9]{4}[0-9A-F]{8}$|^[0-9A-F]{16}$/i.test(s.trim());

/**
 * La pestaña Equipos de la ficha, como se recorre la fibra (2026-09-14, opción A del
 * lienzo "Equipo y ONU en la ficha"): OLT → caja NAP → equipo → casa, y debajo el
 * detalle de cada tramo.
 *
 * Tres lecturas, cada una por su lado para que la pantalla pinte en cuanto llega
 * algo: la óptica de la ONU (`/network/olt/abonado/:id/optica`, sólo Red — ante un
 * 403 esa parte se dice y lo demás sigue), la VLAN del service-port
 * (`/support/.../vlan-olt`, también para la cajera) y los puertos de la caja NAP.
 */
export function AcometidaFibra({
  subscriberId, equipos, puedeEditar, puedeDevolver, onEditar, onDevolver, refrescarTras = 0,
}: {
  subscriberId: string;
  equipos: EquipoFicha[];
  puedeEditar: boolean;
  puedeDevolver: boolean;
  onEditar: (e: EquipoFicha) => void;
  onDevolver: (id: string) => void;
  /** Súbelo tras editar un equipo: vuelve a preguntar a la OLT saltando la caché. */
  refrescarTras?: number;
}) {
  const { authFetch } = useAuth();
  // El de fibra con caja manda: es el que tiene acometida. Si no, el primero.
  const [selId, setSelId] = useState<string | null>(null);
  const principal = useMemo(
    () => equipos.find((e) => e.napId && /ftth|gpon/i.test(e.installType ?? "")) ?? equipos.find((e) => e.napId) ?? equipos[0] ?? null,
    [equipos],
  );
  const eq = equipos.find((e) => e.id === selId) ?? principal;

  const [optica, setOptica] = useState<Optica | null>(null);
  const [sinAcceso, setSinAcceso] = useState(false);
  const [vlan, setVlan] = useState<LecturaVlan | null>(null);
  const [leyendo, setLeyendo] = useState(false);
  const [caja, setCaja] = useState<Caja | null>(null);
  const vivo = useRef(true);
  useEffect(() => () => { vivo.current = false; }, []);

  const leerOlt = useCallback(async (refresh: boolean) => {
    setLeyendo(true);
    const q = refresh ? "?refresh=1" : "";
    await Promise.all([
      authFetch(`/network/olt/abonado/${subscriberId}/optica${q}`)
        .then(async (res) => {
          if (res.status === 403 || res.status === 404) { if (vivo.current) setSinAcceso(true); return; }
          const d = await res.json().catch(() => null);
          if (vivo.current) setOptica(res.ok && d ? d : { ok: false, motivo: "OLT", error: d?.message ?? "No se pudo consultar la OLT." });
        })
        .catch((e) => vivo.current && setOptica({ ok: false, motivo: "OLT", error: (e as Error).message })),
      authFetch(`/support/subscribers/${subscriberId}/vlan-olt${q}`)
        .then(async (res) => {
          const d = await res.json().catch(() => null);
          if (vivo.current) setVlan(res.ok && d ? d : null);
        })
        .catch(() => vivo.current && setVlan(null)),
    ]);
    if (vivo.current) setLeyendo(false);
  }, [authFetch, subscriberId]);

  useEffect(() => { if (equipos.length) void leerOlt(false); }, [leerOlt, equipos.length]);
  const primera = useRef(true);
  useEffect(() => {
    if (primera.current) { primera.current = false; return; }
    void leerOlt(true);
  }, [refrescarTras, leerOlt]);

  useEffect(() => {
    setCaja(null);
    if (!eq?.napId) return;
    void authFetch(`/support/naps/${eq.napId}/ports?subscriberId=${subscriberId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => vivo.current && setCaja(d))
      .catch(() => undefined);
  }, [authFetch, eq?.napId, subscriberId, refrescarTras]);

  if (!eq) {
    return (
      <div className="rounded-xl border border-border-subtle bg-surface p-6 text-center text-[13px] text-text-tertiary shadow-sm">
        Sin equipos asignados.
      </div>
    );
  }

  const o = optica?.ok ? optica : null;
  const rx = o?.optica?.rx ?? null;
  const tonoCasa = o ? rxTone(rx === null ? null : String(rx)) : "vacio";
  const tonoOltRx = o ? rxTone(o.optica?.oltRx == null ? null : String(o.optica.oltRx)) : "default";
  const sinOnu = optica?.motivo === "SIN_ONU" || (sinAcceso && vlan?.motivo === "SIN_ONU");
  const nombreOlt = o?.olt?.name ?? vlan?.olt?.name ?? null;
  const sello = o?.consultadoEn ? new Date(o.consultadoEn).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }) : null;
  const libres = caja?.ports.filter((p) => p.libre).length ?? null;
  const encendida = duracion(o?.estado?.desdeCuando);

  return (
    <div className="flex flex-col gap-4">
      {/* Con varios equipos (ONT + decodificador) se elige cuál se recorre. */}
      {equipos.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {equipos.map((e) => {
            const on = e.id === eq.id;
            return (
              <button
                key={e.id} type="button" onClick={() => setSelId(e.id)}
                className={`rounded-lg border px-3 py-1.5 text-left text-[12px] font-semibold transition-colors ${on ? "border-brand bg-brand-soft text-brand" : "border-border-default text-text-secondary hover:bg-surface-2"}`}
              >
                Cód. {e.code ?? "—"} · {[e.brand, e.installType].filter(Boolean).join(" · ") || "Equipo"}
              </button>
            );
          })}
        </div>
      )}

      {/* ── La cadena ── */}
      <div className="flex flex-col gap-3.5 rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div className="flex items-center gap-2">
            <Icon name="signal" size={15} className="text-brand" />
            <span className="text-[13px] font-bold text-text-primary">Acometida de fibra</span>
            <span className="text-[11px] text-text-tertiary">
              {leyendo ? "Consultando la OLT…" : sello ? `Consultado ${sello} en la OLT` : ""}
            </span>
          </div>
          <div className="flex flex-wrap gap-2 sm:ml-auto">
            <Button size="sm" variant="secondary" onClick={() => void leerOlt(true)} disabled={leyendo}>
              <Icon name="refresh-cw" size={14} className={leyendo ? "animate-spin" : undefined} /> Refrescar OLT
            </Button>
            {puedeEditar && (
              <Button size="sm" variant="secondary" onClick={() => onEditar(eq)}>
                <Icon name="pencil" size={14} /> Editar caja y puerto
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4 lg:gap-0">
          {/* OLT */}
          <Nodo tono={nombreOlt ? "default" : "vacio"} icono="radio-tower" etiqueta="OLT" posicion="primero">
            <span className="text-[15px] font-bold">{nombreOlt ?? (leyendo ? "Consultando…" : "Sin localizar")}</span>
            {o?.onu && <span className="font-mono text-[12px] text-text-secondary">{o.onu.fsp} · ONT {o.onu.ontId}</span>}
            <div className="flex flex-wrap gap-1.5">
              {vlan?.ok ? <Badge label={`VLAN ${vlan.vlan}`} tone="brand" /> : <span className="text-[12px]">VLAN desconocida</span>}
              {o?.estado?.run && <Badge label={o.estado.run} tone={runTone(o.estado.run)} />}
            </div>
            {o?.optica?.oltRx != null && (
              <span className="text-[11px] text-text-tertiary">
                Llega a OLT <b className={`font-mono ${tonoOltRx === "default" ? "text-text-primary" : TONO[tonoOltRx].split(" ").pop()}`}>{dbm(o.optica.oltRx)}</b> dBm
              </span>
            )}
          </Nodo>

          {/* Caja NAP */}
          <Nodo tono={eq.napId || eq.nat ? "default" : "vacio"} icono="network" etiqueta="Caja NAP" posicion="medio">
            {eq.napName || eq.nat ? (
              <>
                <span className="text-[15px] font-bold">{eq.napName ?? `#${eq.nat}`}</span>
                <span className="text-[12px] text-text-secondary">
                  {eq.portNumber != null ? <>Puerto <b className="text-text-primary">{eq.portNumber}</b></> : "Puerto sin casar"}
                  {caja ? ` de ${caja.ports.length} · ${libres} libres` : ""}
                </span>
                {caja && caja.ports.length > 0 && (
                  <div className="mt-0.5 grid grid-cols-8 gap-[3px]">
                    {caja.ports.map((p) => (
                      <span
                        key={p.id}
                        title={p.libre ? `Puerto ${p.port}: libre` : p.mio ? `Puerto ${p.port}: de este cliente` : `Puerto ${p.port}: ${p.client ?? "ocupado"}`}
                        className={`flex h-5 items-center justify-center rounded border text-[10px] font-semibold ${
                          p.id === eq.portId
                            ? "border-brand bg-brand text-on-brand"
                            : p.mio
                              ? "border-brand bg-brand-soft text-brand"
                              : p.libre
                                ? "border-border-default bg-surface text-text-secondary"
                                : "border-border-subtle bg-surface-2 text-text-tertiary opacity-70"
                        }`}
                      >
                        {p.port}
                      </span>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <>
                <span className="text-[15px] font-bold">Sin caja NAP</span>
                <span className="text-[12px]">No se sabe de qué caja cuelga.</span>
              </>
            )}
          </Nodo>

          {/* Equipo */}
          <Nodo tono="default" icono="router" etiqueta="Equipo (ONU)" posicion="medio">
            <span className="text-[15px] font-bold">{[eq.brand, eq.code != null ? `Cód. ${eq.code}` : null].filter(Boolean).join(" · ") || "Equipo"}</span>
            <span className="font-mono text-[12px] text-text-secondary">{eq.mac || "Sin MAC"}</span>
            <div className="flex flex-wrap gap-1.5">
              {eq.installType && <Badge label={eq.installType} />}
              {eq.status?.trim() && <Badge label={eq.status.trim()} tone={/bueno|activo|asignado/i.test(eq.status) ? "success" : "default"} />}
            </div>
            {!pareceSerialOnu(eq.serial) ? (
              <span className="text-[11px] font-semibold text-warning-text">Serial: {eq.serial?.trim() ? `«${eq.serial.trim()}»` : "vacío"}</span>
            ) : (encendida || o?.optica?.temperatura != null) && (
              <span className="text-[11px] text-text-tertiary">
                {[encendida && `Encendida hace ${encendida}`, o?.optica?.temperatura != null && `${o.optica.temperatura} °C`].filter(Boolean).join(" · ")}
              </span>
            )}
          </Nodo>

          {/* Casa */}
          <Nodo tono={tonoCasa} icono="house" etiqueta="Señal en la casa" posicion="ultimo">
            {o ? (
              <>
                <span className="text-[15px] font-bold">{fraseRx(rx)}</span>
                <span className="font-mono text-[22px] font-bold leading-tight">
                  {dbm(rx)} {rx !== null && <span className="text-[11px] font-normal">dBm</span>}
                </span>
                <span className="text-[11px]">
                  {[o.optica?.tx != null && `Emite ${dbm(o.optica.tx)} dBm`, o.estado?.distancia != null && `${o.estado.distancia.toLocaleString("es-CO")} m de fibra`].filter(Boolean).join(" · ")}
                </span>
              </>
            ) : (
              <>
                <span className="text-[15px] font-bold">{leyendo ? "Consultando…" : "Sin lectura"}</span>
                {sinAcceso && <span className="text-[11px]">Tu perfil no ve las potencias de la OLT.</span>}
              </>
            )}
          </Nodo>
        </div>

        {/* Sin ONU: el caso de los equipos importados con "solicitar" en el serial. */}
        {sinOnu && (
          <Aviso
            titulo="No encontramos su ONU en la OLT"
            texto={
              pareceSerialOnu(eq.serial)
                ? "No hay ninguna ONU vinculada a este cliente y la OLT de su sede no reconoce el serial del equipo."
                : "El serial del inventario no es de una ONU, así que no hay con qué buscarla. Corrige el serial y vuelve a buscarla."
            }
          >
            {puedeEditar && (
              <Button size="sm" variant="secondary" onClick={() => onEditar(eq)} className="border-warning-text/35 text-warning-text hover:bg-warning-soft">
                Corregir serial
              </Button>
            )}
            <Button size="sm" onClick={() => void leerOlt(true)} disabled={leyendo}>
              <Icon name="search" size={14} /> Buscar ONU en la OLT
            </Button>
          </Aviso>
        )}
        {optica && !optica.ok && optica.motivo === "OLT" && (
          <Aviso titulo="No se pudo leer la OLT" texto={[optica.error, optica.olt ? `OLT ${optica.olt.name}` : null].filter(Boolean).join(" · ")} />
        )}
        {o?.avisoVinculo && <Aviso titulo="Ojo con la ONU" texto={o.avisoVinculo} />}
      </div>

      {/* ── El detalle ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Tarjeta titulo="Inventario del equipo">
          <Fila k="Código" v={<span className="font-mono">{eq.code ?? "—"}</span>} />
          <Fila k="Marca" v={eq.brand} />
          <Fila k="MAC" v={<span className="font-mono">{eq.mac || "—"}</span>} />
          <Fila k="Serial" v={<span className="font-mono">{eq.serial?.trim() || "—"}</span>} />
          <Fila k="Tipo instalación" v={eq.installType} />
          <Fila k="Bodega de origen" v={eq.warehouse} />
          <Fila k="Entregado" v={fecha(eq.assignedAt)} />
          {puedeDevolver && (
            <div className="mt-3">
              <Button size="sm" variant="secondary" onClick={() => onDevolver(eq.id)}>
                <Icon name="package-x" size={14} /> Devolver equipo
              </Button>
            </div>
          )}
        </Tarjeta>

        <Tarjeta titulo={eq.napName ? `Caja NAP ${eq.napName}` : "Caja NAP"}>
          {eq.napName || eq.nat ? (
            <>
              <Fila k="Puerto" v={eq.portNumber ?? (eq.port ? `#${eq.port} (sin casar)` : null)} />
              <Fila k="Ocupación" v={caja ? `${caja.ports.length - (libres ?? 0)} de ${caja.ports.length}` : null} />
              <Fila k="Sede" v={caja?.nap.branch} />
              <Fila k="Dirección" v={caja?.nap.address} />
              <Fila k="VLAN (de la OLT)" v={vlan?.ok ? vlan.vlan : null} />
            </>
          ) : (
            <p className="py-1 text-[12px] text-text-tertiary">
              Este equipo no tiene caja NAP ni puerto. {puedeEditar ? "Asígnalos con «Editar caja y puerto»." : ""}
            </p>
          )}
        </Tarjeta>

        <Tarjeta
          titulo="Parámetros de la ONU"
          accion={o?.estado?.run ? <Badge label={o.estado.run} tone={runTone(o.estado.run)} /> : null}
        >
          {o ? (
            <>
              <div className="mb-2 grid grid-cols-3 gap-1.5">
                <Potencia etiqueta="Recibe ONT" valor={o.optica?.rx} tono={rxTone(o.optica?.rx == null ? null : String(o.optica.rx))} destacado />
                <Potencia etiqueta="Emite ONT" valor={o.optica?.tx} tono="default" />
                <Potencia etiqueta="Llega a OLT" valor={o.optica?.oltRx} tono={tonoOltRx} />
              </div>
              {o.avisoOptica && <p className="mb-1 text-[11px] leading-snug text-text-tertiary">{o.avisoOptica}</p>}
              <Fila k="Run / config / match" v={[o.estado?.run, o.estado?.config, o.estado?.match].filter(Boolean).join(" · ") || null} />
              <Fila k="Distancia" v={o.estado?.distancia != null ? `${o.estado.distancia.toLocaleString("es-CO")} m` : null} />
              <Fila
                k="Temperatura · voltaje"
                v={[o.optica?.temperatura != null && `${o.optica.temperatura} °C`, o.optica?.voltaje != null && `${o.optica.voltaje.toLocaleString("es-CO")} V`].filter(Boolean).join(" · ") || null}
              />
              <Fila k="Corriente" v={o.optica?.corriente != null ? `${o.optica.corriente} mA` : null} />
              <Fila k="Encendida hace" v={encendida} />
              <Fila
                k="Última caída"
                v={o.estado?.causaCaida ? `${o.estado.causaCaida === "dying-gasp" ? "se fue la luz (dying-gasp)" : o.estado.causaCaida}${o.estado.ultimaCaida ? ` · ${o.estado.ultimaCaida}` : ""}` : null}
              />
              <Fila k="SN en la OLT" v={<span className="font-mono">{o.onu?.sn || "—"}</span>} />
              <Fila k="Descripción" v={o.onu?.descripcion} />
              <Fila k="Service-ports" v={vlan?.ok && vlan.vlans?.length ? `VLAN ${vlan.vlans.join(", ")}` : null} />
            </>
          ) : (
            <p className="py-1 text-[12px] text-text-tertiary">
              {sinAcceso
                ? "Tu perfil no ve los parámetros de la OLT."
                : leyendo
                  ? "Consultando la OLT…"
                  : "Sin lectura de la ONU."}
            </p>
          )}
        </Tarjeta>
      </div>
    </div>
  );
}

/** Un tramo de la cadena. En escritorio van pegados, en móvil apilados. */
function Nodo({
  tono, icono, etiqueta, posicion, children,
}: {
  tono: string; icono: string; etiqueta: string; posicion: "primero" | "medio" | "ultimo"; children: React.ReactNode;
}) {
  const esquinas =
    posicion === "primero" ? "lg:rounded-r-none" : posicion === "ultimo" ? "lg:rounded-l-none lg:border-l-0" : "lg:rounded-none lg:border-l-0";
  return (
    <div className={`flex min-w-0 flex-col gap-1.5 rounded-[10px] border px-3.5 py-3 ${TONO[tono] ?? TONO.default} ${esquinas}`}>
      <div className={`flex items-center gap-1.5 ${tono === "default" ? "text-text-secondary" : ""}`}>
        <Icon name={icono} size={15} className="shrink-0" />
        <span className="text-[10px] uppercase tracking-wide opacity-80">{etiqueta}</span>
      </div>
      {children}
    </div>
  );
}

function Aviso({ titulo, texto, children }: { titulo: string; texto?: string | null; children?: React.ReactNode }) {
  return (
    <div className={`flex flex-col gap-2 rounded-lg border px-3 py-2.5 sm:flex-row sm:items-center ${TONO.warning}`}>
      <div className="flex min-w-0 flex-1 gap-2.5">
        <Icon name="alert-triangle" size={15} className="mt-0.5 shrink-0" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[13px] font-bold">{titulo}</span>
          {texto && <span className="text-[12px]">{texto}</span>}
        </div>
      </div>
      {children && <div className="flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

function Tarjeta({ titulo, accion, children }: { titulo: string; accion?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-[13px] font-bold text-text-primary">{titulo}</span>
        {accion && <span className="ml-auto">{accion}</span>}
      </div>
      {children}
    </div>
  );
}

function Fila({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border-subtle py-1.5 last:border-0">
      <span className="text-[12px] text-text-tertiary">{k}</span>
      <span className="min-w-0 break-words text-right text-[12px] font-medium text-text-primary">{v ?? "—"}</span>
    </div>
  );
}

function Potencia({ etiqueta, valor, tono, destacado }: { etiqueta: string; valor?: number | null; tono: string; destacado?: boolean }) {
  return (
    <div className={`min-w-0 rounded-md border px-2 py-1.5 ${tono === "default" ? "border-border-subtle" : TONO[tono]}`}>
      <p className="truncate text-[10px] uppercase tracking-wide opacity-75">{etiqueta}</p>
      <p className={`whitespace-nowrap font-mono ${destacado ? "text-[15px] font-bold" : "text-[14px] font-semibold"}`}>{dbm(valor)}</p>
    </div>
  );
}
