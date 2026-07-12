"use client";

import { Icon } from "@/components/Icon";

/**
 * Fallback cuando una carga de datos falla. Evita que la página quede colgada
 * en el esqueleto para siempre y distingue "error" de "vacío".
 */
export function LoadError({
  onRetry,
  message = "No se pudieron cargar los datos.",
}: {
  onRetry?: () => void;
  message?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-border-default bg-surface-1 py-14 text-center">
      <Icon name="alert-circle" size={28} className="text-error-text" />
      <p className="text-sm text-text-secondary">{message}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-lg bg-brand px-4 py-2 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hover"
        >
          Reintentar
        </button>
      )}
    </div>
  );
}
