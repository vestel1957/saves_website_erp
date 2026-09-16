"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";

/**
 * Semáforo de conexión del abonado en el Mikrotik.
 *
 * Lo que se ve en la ficha —usuario PPPoE, perfil, IP— es lo que está GUARDADO;
 * no dice si el cliente está navegando AHORA. Este bloque pregunta al router
 * (GET /network/subscribers/:id/connection) y lo resume en un solo color:
 * verde navegando, rojo sin navegar. Es lo primero que necesita quien contesta
 * un "no me sirve el internet".
 *
 * La consulta abre una sesión contra el router, así que:
 *  - se lanza sola al abrir la ficha, pero SIN bloquear el render (el resto de
 *    la ficha ya está pintada mientras esto dice "Consultando…");
 *  - el backend cachea la respuesta 10 s, así que reabrir la ficha no vuelve a
 *    marcar al router;
 *  - si el usuario no tiene permiso de red (403) el bloque desaparece en vez de
 *    enseñar un error que no le sirve de nada.
 */

type Live = {
  secretExists?: boolean;
  secretDisabled?: boolean;
  sessionActive?: boolean;
  ip?: string;
  inActivos?: boolean;
  inMorosos?: boolean;
};

type Estado = {
  ok: boolean;
  dryRun: boolean;
  live?: Live;
  message?: string;
  error?: string;
  mikrotik?: { id: string; name: string; host: string; tech?: string | null };
};

/** Cómo se pinta cada situación: color, icono y qué se le dice al usuario. */
type Pinta = {
  tono: "verde" | "rojo" | "ambar" | "gris";
  icono: string;
  titulo: string;
  detalle?: string;
  /** Lo que se puede hacer AQUÍ para arreglarlo, sin abrir el panel del router. */
  arreglo?: { etiqueta: string; enCurso: string; ruta: string };
};

const TONOS: Record<Pinta["tono"], { caja: string; punto: string }> = {
  verde: { caja: "border-success-text/20 bg-success-soft text-success-text", punto: "bg-success-text" },
  rojo: { caja: "border-error-text/20 bg-error-soft text-error-text", punto: "bg-error-text" },
  ambar: { caja: "border-warning-text/20 bg-warning-soft text-warning-text", punto: "bg-warning-text" },
  gris: { caja: "border-border-subtle bg-surface-2 text-text-secondary", punto: "bg-text-tertiary" },
};

/**
 * Traduce la respuesta cruda del router a una frase.
 *
 * OJO con MOROSOS: aquí el corte NO deshabilita el secret —el cliente sigue
 * levantando la sesión PPPoE con su misma IP— sino que mete esa IP en la lista
 * MOROSOS, y una regla de firewall le bota el tráfico. Así que "sesión activa"
 * NO es sinónimo de navegar: si está en MOROSOS, está cortado. Verde solo
 * cuando tiene sesión Y no está en la lista.
 */
function leer(e: Estado): Pinta {
  if (e.dryRun) {
    return {
      tono: "gris",
      icono: "shield",
      titulo: "Sin consultar (simulación)",
      detalle: "La red está en modo simulación; no se pregunta al router.",
    };
  }
  if (!e.ok) {
    return {
      tono: "ambar",
      icono: "alert-triangle",
      titulo: "No se pudo consultar",
      detalle: e.error ?? e.message,
    };
  }
  const l = e.live ?? {};
  if (!l.secretExists) {
    return {
      tono: "rojo",
      icono: "user-plus",
      titulo: "Sin navegar · no existe en el router",
      detalle: "El usuario PPPoE no está creado en el Mikrotik. Hay que darlo de alta.",
      // Decir el problema y no dejar arreglarlo obligaba a abrir el panel del
      // router y buscar el botón ahí: es el mismo alta, a un clic de distancia.
      arreglo: { etiqueta: "Dar de alta", enCurso: "Dando de alta…", ruta: "provision" },
    };
  }
  if (l.secretDisabled) {
    return {
      tono: "rojo",
      icono: "power",
      titulo: "Sin navegar · deshabilitado",
      detalle: "El usuario está deshabilitado en el router: no puede ni conectarse.",
    };
  }
  if (l.inMorosos) {
    return {
      tono: "rojo",
      icono: "ban",
      titulo: "Cortado por mora",
      detalle: l.sessionActive
        ? "Conecta, pero el router le bota el tráfico: su IP está en la lista MOROSOS."
        : "En la lista MOROSOS y sin sesión levantada.",
    };
  }
  if (l.sessionActive) {
    return {
      tono: "verde",
      icono: "wifi",
      titulo: "Navegando",
      detalle: "Sesión PPPoE activa y sin bloqueo en el router.",
    };
  }
  return {
    tono: "rojo",
    icono: "wifi-off",
    titulo: "Sin navegar",
    detalle: "Está habilitado y sin bloqueo, pero no tiene sesión: equipo apagado, sin fibra o sin sincronizar.",
  };
}

export function EstadoConexion({
  subscriberId,
  pppUsername,
}: {
  subscriberId: string;
  /** Si viene vacío ni se pregunta: sin usuario PPPoE no hay nada que mirar. */
  pppUsername?: string | null;
}) {
  const { authFetch } = useAuth();
  const [estado, setEstado] = useState<Estado | null>(null);
  const [cargando, setCargando] = useState(false);
  const [arreglando, setArreglando] = useState(false);
  const [oculto, setOculto] = useState(false);
  const [sello, setSello] = useState<string | null>(null);
  const vivo = useRef(true);

  useEffect(() => {
    vivo.current = true;
    return () => {
      vivo.current = false;
    };
  }, []);

  const consultar = useCallback(async () => {
    if (!pppUsername) return;
    setCargando(true);
    try {
      const res = await authFetch(`/network/subscribers/${subscriberId}/connection`);
      // Sin permiso de red (403) o módulo apagado: el bloque simplemente no sale.
      if (res.status === 403 || res.status === 404) {
        if (vivo.current) setOculto(true);
        return;
      }
      const data = (await res.json().catch(() => null)) as Estado | null;
      if (!vivo.current) return;
      if (!res.ok) {
        setEstado({ ok: false, dryRun: false, message: (data as any)?.message ?? "No se pudo consultar el router." });
      } else {
        setEstado(data);
      }
      setSello(new Date().toLocaleTimeString("es-CO", { hour: "2-digit", minute: "2-digit" }));
    } catch (e) {
      if (vivo.current) setEstado({ ok: false, dryRun: false, message: (e as Error).message });
    } finally {
      if (vivo.current) setCargando(false);
    }
  }, [authFetch, subscriberId, pppUsername]);

  useEffect(() => {
    void consultar();
  }, [consultar]);

  /**
   * Arreglar lo que dice el semáforo, sin salir de la ficha. Termine bien o mal,
   * se vuelve a preguntar al router: el color que quede es la respuesta, no el
   * mensaje del servidor.
   */
  const arreglar = useCallback(
    async (ruta: string) => {
      setArreglando(true);
      try {
        const res = await authFetch(`/network/subscribers/${subscriberId}/${ruta}`, { method: "POST" });
        const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
        if (!vivo.current) return;
        toast(res.ok && data?.ok ? (data.message ?? "Listo") : (data?.message ?? "No se pudo dar de alta"), res.ok && data?.ok ? "check" : "x");
      } catch (e) {
        if (vivo.current) toast((e as Error).message, "x");
      } finally {
        if (vivo.current) setArreglando(false);
        await consultar();
      }
    },
    [authFetch, subscriberId, consultar],
  );

  if (oculto) return null;

  // Sin usuario PPPoE no hay conexión que mirar: se dice y no se consulta nada.
  if (!pppUsername) {
    return (
      <Franja
        pinta={{ tono: "gris", icono: "wifi-off", titulo: "Sin usuario PPPoE", detalle: "No se puede consultar la conexión." }}
      />
    );
  }

  if (!estado) {
    return (
      <Franja
        pinta={{ tono: "gris", icono: "activity", titulo: "Consultando el router…" }}
        pulso
      />
    );
  }

  const pinta = leer(estado);
  return (
    <Franja
      pinta={pinta}
      ip={estado.live?.ip}
      router={estado.mikrotik?.name}
      sello={sello}
      onRefrescar={consultar}
      cargando={cargando}
      onArreglar={pinta.arreglo ? () => void arreglar(pinta.arreglo!.ruta) : undefined}
      arreglando={arreglando}
    />
  );
}

/** La franja de color en sí. Separada para que los estados vacíos la reusen. */
function Franja({
  pinta,
  ip,
  router,
  sello,
  onRefrescar,
  cargando,
  pulso,
  onArreglar,
  arreglando,
}: {
  pinta: Pinta;
  ip?: string;
  router?: string;
  sello?: string | null;
  onRefrescar?: () => void;
  cargando?: boolean;
  pulso?: boolean;
  onArreglar?: () => void;
  arreglando?: boolean;
}) {
  const t = TONOS[pinta.tono];
  return (
    <div className={`mb-2.5 rounded-lg border px-3 py-2 ${t.caja}`}>
      <div className="flex items-center gap-2">
        <span className={`relative flex h-2.5 w-2.5 shrink-0 rounded-full ${t.punto}`}>
          {(pulso || cargando) && (
            <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${t.punto}`} />
          )}
        </span>
        <Icon name={pinta.icono} size={15} className="shrink-0" />
        <span className="text-[13px] font-bold">{pinta.titulo}</span>
        {onRefrescar && (
          <button
            type="button"
            title={sello ? `Consultado a las ${sello} · volver a consultar` : "Volver a consultar"}
            onClick={onRefrescar}
            disabled={cargando}
            className="tap ml-auto shrink-0 opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40"
          >
            <Icon name="refresh-cw" size={14} className={cargando ? "animate-spin" : undefined} />
          </button>
        )}
      </div>
      {pinta.detalle && <p className="mt-1 text-[11px] leading-snug opacity-90">{pinta.detalle}</p>}
      {pinta.arreglo && onArreglar && (
        <button
          type="button"
          onClick={onArreglar}
          disabled={arreglando || cargando}
          className="tap mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-current px-2 py-1 text-[11px] font-semibold opacity-90 transition-opacity hover:opacity-100 disabled:opacity-40"
        >
          <Icon name={arreglando ? "loader" : "user-plus"} size={13} className={arreglando ? "animate-spin" : undefined} />
          {arreglando ? pinta.arreglo.enCurso : pinta.arreglo.etiqueta}
        </button>
      )}
      {(ip || router) && (
        <p className="mt-1 flex flex-wrap gap-x-3 text-[11px] opacity-80">
          {ip && <span className="font-mono">IP {ip}</span>}
          {router && <span>Router: {router}</span>}
          {sello && <span>Consultado {sello}</span>}
        </p>
      )}
    </div>
  );
}
