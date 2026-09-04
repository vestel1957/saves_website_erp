"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { useAuth } from "@/context/AuthProvider";
import type { MiAgenda, OrdenAgendada } from "@/components/soporte/VisitaAgendada";

/**
 * Aviso en "Mis órdenes de trabajo": esta lista es tu historial, no tu menú.
 *
 * Con el turno obligatorio (2026-08-04, restituido el 2026-09-02), un técnico con
 * visita en turno solo puede abrir esa. La lista sigue existiendo —es donde consulta
 * lo que ya hizo, y quitársela lo dejaría sin memoria de su trabajo—, pero sin este
 * aviso el candado se vive como una avería: toca una fila, le sale un error rojo y no
 * entiende por qué.
 *
 * Así que se dice antes de que lo intente, y con el camino de vuelta al lado.
 *
 * Silencioso cuando no aplica: si hoy no tiene nada agendado, el backend tampoco
 * bloquea nada, y un aviso sobre una regla que ahora mismo no rige solo es ruido.
 */
export function AvisoTurno() {
  const { authFetch } = useAuth();
  const [visita, setVisita] = useState<OrdenAgendada | null>(null);

  useEffect(() => {
    void authFetch("/support/mi-agenda")
      .then((r) => (r.ok ? (r.json() as Promise<MiAgenda>) : null))
      .then((d) => setVisita(d?.ordenes.find((o) => o.id === d.enTurno) ?? null))
      .catch(() => undefined);
  }, [authFetch]);

  if (!visita) return null;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-brand/40 bg-brand-soft/30 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2">
        <Icon name="info" size={16} className="mt-0.5 shrink-0 text-brand" />
        <p className="text-[12.5px] text-text-secondary">
          Tienes una visita en turno: <b className="text-text-primary">{visita.type}</b>
          {visita.cliente ? ` · ${visita.cliente}` : ""}. Las visitas se atienden en el orden que
          puso la persona de caja, así que aquí solo puedes abrir esa.
        </p>
      </div>
      <Link
        href="/mi-agenda"
        className="tap inline-flex min-h-[36px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 text-[12px] font-semibold text-on-brand transition-opacity hover:opacity-90"
      >
        <Icon name="arrow-right" size={14} /> Ir a mi visita
      </Link>
    </div>
  );
}
