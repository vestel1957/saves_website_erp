"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthProvider";
import type { MiCaja } from "@/lib/treasury";

/**
 * Qué caja le toca a quien está usando la pantalla (`GET /treasury/mi-caja`).
 *
 * Lo usan los formularios que mueven plata (nueva transacción, transferencia,
 * egreso, recaudo) para no ofrecerle a la cajera un selector con opciones que el
 * backend le va a rechazar, y para no dejarla registrar "sin caja" —un movimiento
 * huérfano no sale en su cierre—. Devuelve también `bloqueada`: la caja fija
 * cuando el usuario está acotado, o null cuando puede elegir.
 *
 * La barrera de verdad sigue siendo el 403 del servidor (`treasury/caja-scope.ts`);
 * esto es para que la pantalla diga la verdad antes de que el usuario teclee.
 */
export function useMiCaja() {
  const { loading: authLoading, authFetch } = useAuth();
  const [mi, setMi] = useState<MiCaja | null>(null);
  const [cargando, setCargando] = useState(true);

  useEffect(() => {
    if (authLoading) return;
    let vivo = true;
    void authFetch("/treasury/mi-caja")
      .then((r) => (r.ok ? r.json() : null))
      .then((m: MiCaja | null) => { if (vivo) { setMi(m); setCargando(false); } })
      .catch(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [authLoading, authFetch]);

  /** true = está acotado a una caja (no puede elegir). */
  const acotado = !!mi && !mi.todas;
  return {
    mi,
    cargando,
    acotado,
    /** La caja que se le fija, o null si puede elegir. */
    bloqueada: acotado ? mi!.caja : null,
    /** Acotado pero sin caja asignada: no puede registrar nada (el server da 403). */
    sinCaja: acotado && !mi!.caja,
  };
}
