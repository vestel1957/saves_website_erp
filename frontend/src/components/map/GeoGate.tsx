"use client";

import { useCallback, useEffect, useState } from "react";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/context/AuthProvider";
import { PERM, can } from "@/lib/auth";
import { pedirUbicacion } from "@/lib/geo";

/**
 * Puerta de ubicación para técnicos.
 *
 * **Lo que NO se puede hacer, para que quede escrito:** ningún sitio web ni
 * aplicación puede obligar a un teléfono a entregar su ubicación. El permiso lo
 * controlan el usuario y el sistema operativo, y si dicen que no, `getCurrentPosition`
 * falla y no hay API que lo fuerce. Cualquiera que prometa lo contrario miente.
 *
 * Lo que sí se puede es esto: si un técnico tiene el permiso DENEGADO, no pasa
 * de aquí. No es el sistema operativo quien le obliga, es que sin ubicación no
 * tiene nada que hacer en el sistema.
 *
 * Dos decisiones importantes:
 *
 *  · Bloquea con el permiso **denegado**, no cuando el GPS falla en ese momento.
 *    Un técnico dentro de una casa de material puede no conseguir posición
 *    durante minutos, y dejarle sin poder consultar ni un teléfono solo consigue
 *    que pida desactivar la regla entera.
 *  · No afecta a quien no es técnico. La cajera en el local y el contador no
 *    tienen por qué dar ubicación, y en un escritorio sin GPS el dato sería
 *    basura de todas formas.
 */

type Estado = "cargando" | "ok" | "denegado" | "inseguro";

/** Instrucciones por navegador: una vez denegado, el navegador NO vuelve a preguntar. */
function instrucciones(): { titulo: string; pasos: string[] } {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  const esIOS = /iPad|iPhone|iPod/.test(ua);
  const esAndroid = /Android/.test(ua);

  if (esIOS) {
    return {
      titulo: "En iPhone (Safari)",
      pasos: [
        "Abre Ajustes del teléfono → Privacidad y seguridad → Localización.",
        "Asegúrate de que la Localización esté encendida.",
        "Baja hasta Safari (o el navegador que uses) y elige «Al usar la app».",
        "Vuelve aquí y pulsa «Ya lo activé».",
      ],
    };
  }
  if (esAndroid) {
    return {
      titulo: "En Android (Chrome)",
      pasos: [
        "Toca el candado 🔒 que hay junto a la dirección web, arriba.",
        "Entra en Permisos (o «Configuración del sitio») → Ubicación.",
        "Cámbialo a «Permitir».",
        "Comprueba que el GPS del teléfono esté encendido y pulsa «Ya lo activé».",
      ],
    };
  }
  return {
    titulo: "En el navegador",
    pasos: [
      "Pulsa el candado 🔒 junto a la dirección web.",
      "Busca «Ubicación» y ponlo en «Permitir».",
      "Recarga la página y pulsa «Ya lo activé».",
    ],
  };
}

export function GeoGate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [estado, setEstado] = useState<Estado>("cargando");
  const [comprobando, setComprobando] = useState(false);

  // Aplica solo a técnicos. Gerencia, administración y el superusuario quedan
  // fuera: son los mismos exentos que en la geo-cerca del cierre.
  const esTecnico =
    !!user &&
    can(user, PERM.AREA_TECNICOS) &&
    !can(user, [PERM.AREA_GERENCIA, PERM.AREA_ADMINISTRACION]) &&
    !(user.permissions ?? []).includes(PERM.SYSTEM_ADMIN);

  const comprobar = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (!window.isSecureContext) return setEstado("inseguro");

    // `permissions.query` dice si está denegado SIN lanzar el diálogo, que es lo
    // que permite distinguir "dijo que no" de "aún no ha contestado".
    try {
      const p = await navigator.permissions?.query({ name: "geolocation" as PermissionName });
      if (p?.state === "denied") return setEstado("denegado");
      if (p?.state === "granted") return setEstado("ok");
    } catch {
      // Safari viejo no soporta permissions.query: se cae al intento directo.
    }

    // Estado "prompt" (o navegador sin la API): se pide de verdad, lo que
    // dispara el diálogo del navegador. Es el único momento en que puede salir.
    const r = await pedirUbicacion(20000);
    setEstado(r.ok || r.motivo !== "denegado" ? "ok" : "denegado");
  }, []);

  useEffect(() => {
    if (loading || !esTecnico) return;
    void comprobar();

    // Si el técnico cambia el permiso en los ajustes, la puerta se abre sola sin
    // que tenga que recargar ni volver a entrar.
    let cancelar: (() => void) | undefined;
    void navigator.permissions
      ?.query({ name: "geolocation" as PermissionName })
      .then((p) => {
        const alCambiar = () => void comprobar();
        p.addEventListener("change", alCambiar);
        cancelar = () => p.removeEventListener("change", alCambiar);
      })
      .catch(() => undefined);
    return () => cancelar?.();
  }, [loading, esTecnico, comprobar]);

  if (loading || !esTecnico || estado === "ok" || estado === "cargando") return <>{children}</>;

  const guia = instrucciones();

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-4">
      <div className="w-full max-w-md rounded-xl border border-border-default bg-surface p-6 shadow-sm">
        <div className="mb-3 flex items-center gap-2.5">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-warning-soft">
            <Icon name="map-pin" size={20} className="text-warning-text" />
          </span>
          <div>
            <h1 className="text-[16px] font-bold text-text-primary">Activa tu ubicación</h1>
            <p className="text-[12px] text-text-tertiary">{user?.name}</p>
          </div>
        </div>

        {estado === "inseguro" ? (
          <>
            <p className="mb-3 text-[13px] leading-relaxed text-text-secondary">
              Estás entrando por una dirección <strong>sin HTTPS</strong>, y los navegadores no dan
              la ubicación en ese caso. No es algo que se pueda arreglar desde aquí: hay que entrar
              por el dominio seguro.
            </p>
            <a
              href="https://app.saves.com.co"
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-brand px-4 py-2.5 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hover"
            >
              <Icon name="external-link" size={15} /> Entrar por app.saves.com.co
            </a>
          </>
        ) : (
          <>
            <p className="mb-3 text-[13px] leading-relaxed text-text-secondary">
              Como técnico necesitas la ubicación activada para trabajar: es lo que deja constancia
              de que estuviste en el domicilio del cliente. Está <strong>bloqueada</strong> en este
              navegador y hay que reactivarla a mano — una vez denegada, ya no vuelve a preguntar
              sola.
            </p>
            <div className="mb-4 rounded-lg border border-border-subtle bg-surface-2 p-3">
              <p className="mb-1.5 text-[12px] font-bold text-text-primary">{guia.titulo}</p>
              <ol className="list-decimal space-y-1 pl-4 text-[12.5px] leading-relaxed text-text-secondary">
                {guia.pasos.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ol>
            </div>
            <Button
              className="w-full justify-center py-2.5"
              disabled={comprobando}
              onClick={async () => {
                setComprobando(true);
                await comprobar();
                setComprobando(false);
              }}
            >
              <Icon
                name={comprobando ? "loader" : "check"}
                size={15}
                className={comprobando ? "animate-spin" : ""}
              />
              {comprobando ? "Comprobando…" : "Ya lo activé"}
            </Button>
            <p className="mt-2 text-center text-[11.5px] text-text-tertiary">
              Si no te deja, cierra el navegador por completo y vuelve a entrar.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
