"use client";

import { useEffect, useState } from "react";
import { Icon } from "@/components/Icon";

const CLAVE_RECARGA = "error:recarga-por-despliegue";

/** ¿Falló la descarga de un trozo de JS (build vieja tras un despliegue)? */
const esTrozoViejo = (e: Error | undefined): boolean =>
  e?.name === "ChunkLoadError" || /Failed to load chunk|Loading chunk .* failed|dynamically imported module/i.test(e?.message ?? "");

/**
 * Frontera de error de la aplicación.
 *
 * No existía ninguna: cualquier excepción durante el render dejaba **pantalla en
 * blanco**, sin mensaje, sin forma de volver y sin rastro para diagnosticarla. Con
 * 93 páginas que hacen fetch en efecto y pintan datos sin validar, un campo nulo
 * inesperado basta para tumbar la vista entera.
 *
 * Next monta este componente en lugar del árbol que falló y ofrece `reset()` para
 * reintentar el render sin recargar la página.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [verDetalle, setVerDetalle] = useState(false);

  useEffect(() => {
    // Al menos queda en la consola del navegador con su `digest`, que es lo que
    // permite cruzarlo con el log del servidor.
    console.error("Error no controlado en la interfaz:", error);

    // Pestaña abierta desde ANTES de un despliegue: pide los trozos de JS de la build
    // vieja, que ya no existen (404), y cae aquí aunque la pantalla esté sana — visto
    // en Agendamiento el 2026-09-22. Recargar trae la build nueva. Una sola vez por
    // minuto, para no entrar en bucle si el trozo falta de verdad.
    if (esTrozoViejo(error)) {
      try {
        const ultima = Number(sessionStorage.getItem(CLAVE_RECARGA) ?? 0);
        if (Date.now() - ultima > 60_000) {
          sessionStorage.setItem(CLAVE_RECARGA, String(Date.now()));
          window.location.reload();
        }
      } catch { /* sin sessionStorage: se queda el aviso con el botón */ }
    }
  }, [error]);

  /**
   * El `digest` sólo existe cuando el error viene del servidor: si revienta en el
   * navegador, el recuadro salía VACÍO y quien reportaba no tenía nada que copiar —
   * "se rompió la pantalla" y a adivinar. El detalle real va detrás de un botón para
   * no asustar a quien sólo quiere reintentar, pero está a un clic de una captura.
   */
  const detalle = [
    error?.message,
    error?.digest ? `digest: ${error.digest}` : null,
    typeof window !== "undefined" ? `ruta: ${window.location.pathname}` : null,
    error?.stack?.split("\n").slice(0, 6).join("\n"),
  ].filter(Boolean).join("\n");

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <Icon name="alert-circle" size={40} className="text-error-text" />
      <div>
        <h2 className="text-[16px] font-bold text-text-primary">Algo se rompió en esta pantalla</h2>
        <p className="mt-1 max-w-md text-[13px] text-text-secondary">
          El resto del sistema sigue funcionando. Puedes reintentar; si vuelve a fallar, avisa a
          sistemas con el código de abajo.
        </p>
      </div>

      {detalle && (
        <div className="w-full max-w-2xl">
          <button
            type="button"
            onClick={() => setVerDetalle((v) => !v)}
            className="text-[12px] font-semibold text-brand hover:underline"
          >
            {verDetalle ? "Ocultar el detalle técnico" : "Ver el detalle técnico"}
          </button>
          {verDetalle && (
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-lg bg-surface-2 p-3 text-left text-[11px] leading-relaxed text-text-secondary">
              {detalle}
            </pre>
          )}
        </div>
      )}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg bg-brand px-4 py-2 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hover"
        >
          Reintentar
        </button>
        <a
          href="/"
          className="rounded-lg border border-border-default px-4 py-2 text-[13px] font-semibold text-text-primary transition-colors hover:bg-surface-2"
        >
          Ir al inicio
        </a>
      </div>
    </div>
  );
}
