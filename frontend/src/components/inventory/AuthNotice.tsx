"use client";

import { Icon } from "../Icon";
import { PageSkeleton } from "../skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";

/**
 * Aviso de "inicia sesión" para páginas protegidas del cliente.
 *
 * Importante: mientras la sesión aún se está resolviendo (`loading`), mostramos
 * el skeleton del contenido en lugar del CTA de login. Así evitamos el parpadeo
 * a "Iniciar sesión" en cada navegación/recarga antes de que `fetchMe` responda.
 */
export function AuthNotice() {
  const { loading } = useAuth();

  if (loading) return <PageSkeleton />;

  return (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center">
      <Icon name="lock" size={22} className="text-text-tertiary" />
      <h2 className="text-[15px] font-bold text-text-primary">Inicia sesión para ver el inventario</h2>
      <p className="max-w-md text-[13px] text-text-tertiary">
        El módulo de inventario está protegido con autenticación. Inicia sesión para continuar.
      </p>
      <a
        href="/login?next=/inventario"
        className="mt-1 rounded-lg bg-brand px-4 py-2 text-[13px] font-semibold text-on-brand transition-colors hover:bg-brand-hover"
      >
        Iniciar sesión
      </a>
    </div>
  );
}
