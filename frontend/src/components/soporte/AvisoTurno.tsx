"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/Icon";
import { useAuth } from "@/context/AuthProvider";
import type { MiAgenda, OrdenEnCurso } from "@/components/soporte/VisitaAgendada";

/**
 * "Ya tienes una orden abierta": el aviso que evita que el candado se descubra
 * chocando con él — el mismo texto que da el legacy al pulsar "Realizando" con otra
 * orden ya empezada.
 *
 * Se pinta tanto en "Mis órdenes" del técnico como en la lista general de caja y
 * administración (donde sólo aparece con el interruptor `UNA_ORDEN_A_LA_VEZ`
 * encendido, hoy apagado). Sin este cartel, el bloqueo se descubre al pulsar
 * "Empezar" en otra visita y sale un error rojo sin contexto.
 *
 * Lleva el enlace a la orden que hay que cerrar, que es lo único accionable. Lo demás
 * de la lista SÍ se puede abrir y trabajar (2026-09-10): lo único cerrado es empezar
 * una segunda.
 *
 * Silencioso cuando no aplica: quien no tiene ninguna orden empezada no está
 * bloqueado, y un aviso sobre una regla que ahora mismo no le rige sólo es ruido.
 * También calla si el usuario no tiene permiso para preguntar por su agenda (la
 * respuesta no llega `ok`): mejor sin cartel que con uno equivocado.
 */
export function AvisoTurno() {
  const { authFetch } = useAuth();
  const [orden, setOrden] = useState<OrdenEnCurso | null>(null);

  useEffect(() => {
    void authFetch("/support/mi-agenda")
      .then((r) => (r.ok ? (r.json() as Promise<MiAgenda>) : null))
      .then((d) => setOrden(d?.enCurso ?? null))
      .catch(() => undefined);
  }, [authFetch]);

  if (!orden) return null;

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-brand/40 bg-brand-soft/30 px-3.5 py-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-2">
        <Icon name="info" size={16} className="mt-0.5 shrink-0 text-brand" />
        <p className="text-[12.5px] text-text-secondary">
          Ya tienes una orden abierta:{" "}
          <b className="text-text-primary">
            {orden.code ? `#${orden.code} · ` : ""}
            {orden.type}
          </b>
          {orden.cliente ? ` · ${orden.cliente}` : ""}. Se trabaja una a la vez: ciérrala y
          podrás empezar otra.
        </p>
      </div>
      <Link
        href={`/soporte/${orden.id}`}
        className="tap inline-flex min-h-[36px] shrink-0 items-center justify-center gap-1.5 rounded-lg bg-brand px-3.5 text-[12px] font-semibold text-on-brand transition-opacity hover:opacity-90"
      >
        <Icon name="arrow-right" size={14} /> Ver la orden abierta
      </Link>
    </div>
  );
}
