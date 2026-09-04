// "Servicio asignado" de una factura: qué plan tiene contratado el abonado y por
// tanto qué se le cobrará en la próxima facturación mensual (el bloque ASIGNAR
// SERVICIO del legacy). No es lo que ESTA factura cobró — eso son sus renglones.

/** Una línea de servicio contratada por el abonado. */
export type ServicioContratado = {
  kind: string; // INTERNET | TV | PUNTOS | STREAMING
  planId: string | null;
  planName: string | null;
  price: number;
  taxRate: number;
  qty: number;
  status: string;
};

export type ServicioAsignado = {
  servicios: ServicioContratado[];
  /**
   * true = el plan no está en la ficha del abonado sino deducido de sus facturas
   * (el hueco de la migración: `SubscriberService` solo se pobló para los ACTIVO).
   * Merece decirlo en pantalla, porque asignarle el servicio es justo lo que lo
   * deja registrado de verdad.
   */
  derivado: boolean;
  assignedAt: string | null;
  assignedBy: string | null;
  /**
   * La factura mensual de la que el sistema anterior lee qué cobrar el mes que
   * viene. `esEsta` dice si es la que se está mirando. null = el abonado todavía
   * no tiene ninguna mensual.
   */
  dicta: { id: string; tid: number; date: string; esEsta: boolean } | null;
};

/** Resumen de una línea en texto: "300 Megas ST · $77.000/mes". */
export function etiquetaServicio(s: ServicioContratado) {
  return s.kind === "PUNTOS"
    ? `${s.qty} punto${s.qty === 1 ? "" : "s"} de TV`
    : s.planName ?? s.kind;
}
