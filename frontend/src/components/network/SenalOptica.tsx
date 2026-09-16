"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { rxTone, runTone } from "@/lib/olt";
import { useAuth } from "@/context/AuthProvider";

/**
 * Potencias ópticas de la ONU del abonado, en la ficha del cliente.
 *
 * Lo que hasta ahora había que ir a buscar a Red › Gestión OLT —entrar al equipo,
 * acertar el puerto y encontrar la ONU entre las 96 del PON— para responder a un
 * "se me va el internet": cuánta luz RECIBE la ONT del cliente, cuánta EMITE y
 * cuánta le llega de vuelta a la OLT. La lectura es en vivo por SSH (no hay nada
 * guardado: `OltOnu.rxPower` es la foto del último sync), así que el bloque se
 * pinta en cuanto la ficha abre y el dato entra después, sin bloquear nada.
 *
 * Umbrales (los mismos del módulo OLT): OK ≥ -25 dBm · flojo -25..-28 · crítica < -28.
 * Ojo al leerlos: un -26 aislado no es avería si TODO ese PON anda por ahí — lo que
 * delata un empalme malo es que el cliente esté claramente peor que sus vecinos.
 *
 * Sin permiso de red (403) o con el módulo apagado el bloque desaparece: al cajero
 * no le sirve de nada un error que no puede resolver.
 */

type Optica = {
  ok: boolean;
  motivo?: "SIN_ONU" | "NO_AUTENTICADA" | "OLT";
  error?: string;
  via?: "VINCULADA" | "SERIAL" | "BUSQUEDA" | "MAC";
  olt?: { id: string; name: string };
  onu?: { sn: string | null; fsp: string; ontId: number; descripcion: string | null };
  estado?: {
    run: string | null; config: string | null; match: string | null;
    distancia: number | null; ultimaCaida: string | null; causaCaida: string | null;
    desdeCuando: string | null;
  };
  optica?: {
    rx: number | null; tx: number | null; oltRx: number | null;
    temperatura: number | null; voltaje: number | null; corriente: number | null;
  };
  avisoOptica?: string;
  /** La ONU no estaba en la posición guardada y apareció en otra (quizá de otro abonado). */
  avisoVinculo?: string;
  consultadoEn?: string;
  /** La respuesta venía de la caché de 60 s del servidor, no de la OLT. */
  cached?: boolean;
};

const TONOS: Record<string, string> = {
  success: "border-success-text/20 bg-success-soft text-success-text",
  warning: "border-warning-text/20 bg-warning-soft text-warning-text",
  error: "border-error-text/20 bg-error-soft text-error-text",
  default: "border-border-subtle bg-surface-2 text-text-secondary",
};

/** Cómo se llama un nivel de recepción en una frase que sirva al que atiende. */
export function fraseRx(rx: number | null | undefined): string {
  if (rx === null || rx === undefined) return "Sin lectura de potencia";
  if (rx >= -25) return "Señal correcta";
  if (rx >= -28) return "Señal floja";
  return "Señal crítica";
}

export const dbm = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toFixed(2));

/**
 * "4 day(s), 0 hour(s), 17 minute(s), 46 second(s)" → "4 días".
 *
 * La OLT devuelve el uptime de la ONT en inglés y con las cuatro unidades
 * siempre, segundos incluidos. En la ficha sólo interesa el orden de magnitud
 * ("lleva días encendida" o "se reinició hace un rato"), así que se traduce y se
 * deja en las dos unidades de mayor peso.
 */
export function duracion(s: string | null | undefined): string | null {
  if (!s) return null;
  const n = (u: string) => {
    const m = s.match(new RegExp(`(\\d+)\\s*${u}`, "i"));
    return m ? Number(m[1]) : 0;
  };
  const partes: string[] = [];
  const d = n("day"), h = n("hour"), min = n("minute");
  if (d) partes.push(`${d} ${d === 1 ? "día" : "días"}`);
  if (h && partes.length < 2) partes.push(`${h} h`);
  if (min && partes.length < 2) partes.push(`${min} min`);
  if (!partes.length) return "menos de un minuto";
  return partes.join(" ");
}

export function SenalOptica({ subscriberId }: { subscriberId: string }) {
  const { authFetch } = useAuth();
  const [datos, setDatos] = useState<Optica | null>(null);
  const [cargando, setCargando] = useState(false);
  const [oculto, setOculto] = useState(false);
  const vivo = useRef(true);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const consultar = useCallback(
    async (refresh = false) => {
      setCargando(true);
      try {
        const res = await authFetch(`/network/olt/abonado/${subscriberId}/optica${refresh ? "?refresh=1" : ""}`);
        // Sin permiso de red (403) o módulo apagado: el bloque no sale siquiera.
        if (res.status === 403 || res.status === 404) {
          if (vivo.current) setOculto(true);
          return;
        }
        const data = (await res.json().catch(() => null)) as Optica | null;
        if (!vivo.current) return;
        setDatos(
          res.ok && data
            ? data
            : { ok: false, motivo: "OLT", error: (data as any)?.message ?? "No se pudo consultar la OLT." },
        );
      } catch (e) {
        if (vivo.current) setDatos({ ok: false, motivo: "OLT", error: (e as Error).message });
      } finally {
        if (vivo.current) setCargando(false);
      }
    },
    [authFetch, subscriberId],
  );

  useEffect(() => {
    void consultar();
  }, [consultar]);

  if (oculto) return null;

  if (!datos) {
    return (
      <Marco tono="default" titulo="Consultando la señal óptica…" icono="signal" pulso />
    );
  }

  // Este cliente no tiene ONU que mirar (EoC, inalámbrico, o nunca se vinculó).
  if (!datos.ok && datos.motivo === "SIN_ONU") {
    return (
      <Marco
        tono="default"
        titulo="Sin ONU en la OLT"
        icono="signal"
        detalle={datos.error}
        onRefrescar={() => void consultar(true)}
        cargando={cargando}
      />
    );
  }

  // Tiene un equipo asignado en inventario, pero la OLT no lo tiene dado de alta:
  // no es una falla de lectura, es que falta autenticarlo (o el inventario miente).
  if (!datos.ok && datos.motivo === "NO_AUTENTICADA") {
    return (
      <Marco
        tono="warning"
        titulo="Equipo asignado sin autenticar en la OLT"
        icono="alert-triangle"
        detalle={datos.error}
        onRefrescar={() => void consultar(true)}
        cargando={cargando}
      />
    );
  }

  if (!datos.ok) {
    return (
      <Marco
        tono="warning"
        titulo="No se pudo leer la señal"
        icono="alert-triangle"
        detalle={[datos.error, datos.olt ? `OLT ${datos.olt.name}` : null].filter(Boolean).join(" · ")}
        onRefrescar={() => void consultar(true)}
        cargando={cargando}
      />
    );
  }

  const o = datos.optica!;
  const est = datos.estado!;
  const tono = rxTone(o.rx === null ? null : String(o.rx));
  const sello = datos.consultadoEn
    ? new Date(datos.consultadoEn).toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" })
    : null;

  return (
    <div className={`mb-2.5 rounded-lg border px-3 py-2 ${TONOS[tono]}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${tono === "default" ? "bg-text-tertiary" : "bg-current"}`} />
        <Icon name="signal" size={15} className="shrink-0" />
        <span className="text-[13px] font-bold">{fraseRx(o.rx)}</span>
        {est.run && <Badge label={est.run} tone={runTone(est.run)} />}
        <button
          type="button"
          title={sello ? `Consultado a las ${sello} · volver a preguntar a la OLT` : "Volver a preguntar a la OLT"}
          onClick={() => void consultar(true)}
          disabled={cargando}
          className="tap ml-auto shrink-0 opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40"
        >
          <Icon name="refresh-cw" size={14} className={cargando ? "animate-spin" : undefined} />
        </button>
      </div>

      {/* Las tres potencias, que es a lo que se viene. `oltRx` va con las otras dos
          porque es la que delata el camino de VUELTA: el cliente puede recibir bien
          y llegarle a la OLT una señal pobre (empalme flojo, conector sucio). */}
      <div className="mt-2 grid grid-cols-3 gap-2">
        <Potencia etiqueta="Recibe ONT" valor={dbm(o.rx)} destacado />
        <Potencia etiqueta="Emite ONT" valor={dbm(o.tx)} />
        <Potencia etiqueta="Llega a OLT" valor={dbm(o.oltRx)} />
      </div>

      {/* Va antes que todo lo demás: si la ONU es de OTRO abonado, las potencias de
          arriba no hablan de este cliente. */}
      {datos.avisoVinculo && (
        <p className={`mt-1.5 rounded-md border px-2 py-1 text-[11px] font-semibold leading-snug ${TONOS.warning}`}>
          {datos.avisoVinculo}
        </p>
      )}
      {datos.avisoOptica && <p className="mt-1.5 text-[11px] leading-snug opacity-90">{datos.avisoOptica}</p>}

      <p className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] opacity-80">
        {datos.olt && <span>OLT {datos.olt.name}</span>}
        {datos.onu?.fsp && <span className="font-mono">{datos.onu.fsp}:{datos.onu.ontId}</span>}
        {datos.onu?.sn && <span className="font-mono">{datos.onu.sn}</span>}
        {est.distancia !== null && <span>{est.distancia.toLocaleString("es-CO")} m de fibra</span>}
        {o.temperatura !== null && <span>{o.temperatura} °C</span>}
        {duracion(est.desdeCuando) && <span>Encendida hace {duracion(est.desdeCuando)}</span>}
      </p>

      {/* Por qué se cayó la última vez. `dying-gasp` = se le fue la luz en la casa:
          es la respuesta a la mitad de los "anoche no me servía". */}
      {est.causaCaida && (
        <p className="mt-0.5 text-[11px] opacity-70">
          Última caída {est.ultimaCaida ?? "—"}
          {est.causaCaida === "dying-gasp" ? " · se le fue la luz (dying-gasp)" : ` · ${est.causaCaida}`}
        </p>
      )}
      {sello && (
        <p className="mt-0.5 text-[11px] opacity-60">
          Consultado {sello}
          {datos.cached ? " (lectura reciente)" : ""}
        </p>
      )}
    </div>
  );
}

/** Una de las tres potencias. El número manda; "dBm" va pequeño y a su lado. */
function Potencia({ etiqueta, valor, destacado }: { etiqueta: string; valor: string; destacado?: boolean }) {
  return (
    <div className="min-w-0 rounded-md border border-current/15 px-2 py-1.5">
      <p className="truncate text-[10px] uppercase tracking-wide opacity-70">{etiqueta}</p>
      <p className={`whitespace-nowrap font-mono ${destacado ? "text-[15px] font-bold" : "text-[14px] font-semibold"}`}>
        {valor}
        {valor !== "—" && <span className="ml-0.5 text-[10px] font-normal opacity-70">dBm</span>}
      </p>
    </div>
  );
}

/** La franja de una sola línea: cargando, sin ONU o error. */
function Marco({
  tono,
  titulo,
  icono,
  detalle,
  pulso,
  onRefrescar,
  cargando,
}: {
  tono: keyof typeof TONOS;
  titulo: string;
  icono: string;
  detalle?: string | null;
  pulso?: boolean;
  onRefrescar?: () => void;
  cargando?: boolean;
}) {
  return (
    <div className={`mb-2.5 rounded-lg border px-3 py-2 ${TONOS[tono]}`}>
      <div className="flex items-center gap-2">
        <span className="relative flex h-2.5 w-2.5 shrink-0 rounded-full bg-current opacity-70">
          {(pulso || cargando) && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-current opacity-60" />}
        </span>
        <Icon name={icono} size={15} className="shrink-0" />
        <span className="text-[13px] font-bold">{titulo}</span>
        {onRefrescar && (
          <button
            type="button"
            title="Volver a preguntar a la OLT"
            onClick={onRefrescar}
            disabled={cargando}
            className="tap ml-auto shrink-0 opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40"
          >
            <Icon name="refresh-cw" size={14} className={cargando ? "animate-spin" : undefined} />
          </button>
        )}
      </div>
      {detalle && <p className="mt-1 text-[11px] leading-snug opacity-90">{detalle}</p>}
    </div>
  );
}
