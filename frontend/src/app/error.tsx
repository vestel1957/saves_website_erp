"use client";

import { useEffect } from "react";
import { Icon } from "@/components/Icon";

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
  useEffect(() => {
    // Al menos queda en la consola del navegador con su `digest`, que es lo que
    // permite cruzarlo con el log del servidor.
    console.error("Error no controlado en la interfaz:", error);
  }, [error]);

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

      {error.digest && (
        <code className="rounded-md bg-surface-2 px-2 py-1 text-[11px] text-text-tertiary">
          {error.digest}
        </code>
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
          href="/inicio"
          className="rounded-lg border border-border-default px-4 py-2 text-[13px] font-semibold text-text-primary transition-colors hover:bg-surface-2"
        >
          Ir al inicio
        </a>
      </div>
    </div>
  );
}
