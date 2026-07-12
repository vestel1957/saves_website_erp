"use client";

import type { ReactNode } from "react";
import { Icon } from "./Icon";
import { PageSkeleton } from "./skeletons/PageSkeleton";
import { useAuth } from "@/context/AuthProvider";

/**
 * Client-side RBAC gate. Renders `children` only when the signed-in user holds
 * the required permission(s); otherwise shows an access-denied notice. This is a
 * UX guard — the backend independently enforces the same permission on its API.
 */
export function PermissionGate({
  required,
  children,
}: {
  required: string | string[];
  children: ReactNode;
}) {
  const { user, loading, can } = useAuth();

  // Mientras se resuelve la sesión mostramos el skeleton del contenido en vez
  // de un spinner suelto (o un parpadeo a "iniciar sesión").
  if (loading) {
    return <PageSkeleton />;
  }

  if (!can(required)) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="max-w-sm rounded-xl border border-border-subtle bg-surface p-8 text-center">
          <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-error-soft">
            <Icon name="lock" size={20} className="text-error-text" />
          </div>
          <h2 className="text-[15px] font-bold text-text-primary">Acceso restringido</h2>
          <p className="mt-1.5 text-[13px] text-text-secondary">
            {user
              ? "Tu rol no tiene permisos para ver esta sección. Contacta a un administrador."
              : "Inicia sesión para continuar."}
          </p>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
