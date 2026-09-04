/**
 * Historial de una factura: qué se le hizo, quién y POR QUÉ.
 *
 * El motivo del cambio ya se pedía al editar y al anular, pero se guardaba sólo
 * dentro del JSON de `AuditLog` y no lo veía nadie: en la factura únicamente
 * quedaba el rótulo "Editada" con la fecha. Al que abría el documento tres meses
 * después —contabilidad, la cajera, el cliente reclamando— le tocaba adivinar qué
 * renglón se había tocado y por qué.
 *
 * Aquí se traduce esa auditoría cruda a frases: "Total $45.000 → $50.000",
 * "Se quitó «Punto adicional» (1 × $5.000)". Es sólo lectura y sólo formato: las
 * funciones son puras para poder probarlas sin BD (`historial-factura.spec.ts`).
 */

/** Un renglón de la factura tal como lo guarda la auditoría (antes/después). */
export type ConceptoAuditado = {
  product?: string | null;
  description?: string | null;
  qty?: number | null;
  price?: number | null;
  taxRate?: number | null;
  subtotal?: number | null;
};

export type TipoMovimiento =
  | 'EMITIDA'
  | 'EDICION'
  | 'ANULACION'
  | 'SERVICIO'
  | 'NOTA_CREDITO'
  | 'NOTA_DEBITO';

export type Movimiento = {
  id: string;
  fecha: Date;
  tipo: TipoMovimiento;
  /** Título legible: "Factura editada", "Nota crédito"… */
  titulo: string;
  /** Quién lo hizo (nombre del funcionario), si quedó registrado. */
  por: string | null;
  /** El "por qué": lo que escribió quien hizo el cambio. */
  motivo: string | null;
  /** El "qué": una frase por cosa que cambió. */
  cambios: string[];
  /** Monto asociado al movimiento (notas), cuando aplica. */
  monto?: number | null;
};

/** Pesos sin decimales, el mismo formato en todas las frases del historial. */
export const copHistorial = (n: number) =>
  '$' + new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.round(Number(n) || 0));

const fechaCorta = (v: unknown): string => {
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v ?? '—') : d.toISOString().slice(0, 10);
};

const ESTADO: Record<string, string> = {
  DUE: 'Pendiente', PARTIAL: 'Abonada', PAID: 'Pagada', CANCELED: 'Anulada',
};

/** Nombre con el que se muestra un renglón (el producto, o su descripción). */
const nombreConcepto = (it: ConceptoAuditado) =>
  (it.product ?? it.description ?? 'Concepto').toString().trim() || 'Concepto';

/** Clave para emparejar el mismo renglón antes y después de la edición. */
const claveConcepto = (it: ConceptoAuditado) =>
  `${nombreConcepto(it).toLowerCase()}|${(it.description ?? '').toString().trim().toLowerCase()}`;

const cantidadYPrecio = (it: ConceptoAuditado) =>
  `${Number(it.qty) || 0} × ${copHistorial(Number(it.price) || 0)}`;

/**
 * Diferencias entre los conceptos de antes y los de después, en frases.
 *
 * La edición borra los renglones y los reinserta (paridad legacy), así que no hay
 * ningún id que seguir: se emparejan por nombre + descripción y, dentro de un
 * mismo nombre repetido, por orden de aparición.
 */
export function diffConceptos(antes: ConceptoAuditado[], despues: ConceptoAuditado[]): string[] {
  const porClave = (lista: ConceptoAuditado[]) => {
    const m = new Map<string, ConceptoAuditado[]>();
    for (const it of lista) {
      const k = claveConcepto(it);
      const grupo = m.get(k) ?? [];
      if (grupo.length === 0) m.set(k, grupo);
      grupo.push(it);
    }
    return m;
  };
  const a = porClave(antes);
  const d = porClave(despues);
  const frases: string[] = [];

  for (const [clave, viejos] of a) {
    const nuevos = d.get(clave) ?? [];
    const comunes = Math.min(viejos.length, nuevos.length);
    for (let i = 0; i < comunes; i++) {
      const v = viejos[i];
      const n = nuevos[i];
      const cambiaCantidad = (Number(v.qty) || 0) !== (Number(n.qty) || 0);
      const cambiaPrecio = (Number(v.price) || 0) !== (Number(n.price) || 0);
      if (cambiaCantidad || cambiaPrecio) {
        frases.push(`«${nombreConcepto(n)}»: ${cantidadYPrecio(v)} → ${cantidadYPrecio(n)}`);
      }
    }
    for (const v of viejos.slice(comunes)) {
      frases.push(`Se quitó «${nombreConcepto(v)}» (${cantidadYPrecio(v)})`);
    }
  }
  for (const [clave, nuevos] of d) {
    const sobran = nuevos.slice((a.get(clave) ?? []).length);
    for (const n of sobran) frases.push(`Se agregó «${nombreConcepto(n)}» (${cantidadYPrecio(n)})`);
  }
  return frases;
}

/** Compara un campo del encabezado y devuelve la frase, o null si no cambió. */
function campo(
  etiqueta: string,
  antes: unknown,
  despues: unknown,
  fmt: (v: unknown) => string = (v) => String(v ?? '—'),
): string | null {
  if (despues === undefined) return null; // no viajó en la auditoría: no se tocó
  const a = fmt(antes);
  const b = fmt(despues);
  return a === b ? null : `${etiqueta} ${a} → ${b}`;
}

type LogAuditado = {
  id: string;
  action: string;
  createdAt: Date;
  before: any;
  after: any;
};

/**
 * Traduce una fila de `AuditLog` sobre una factura a un movimiento del historial.
 *
 * Las tres cosas que se auditan sobre una factura salen con la misma forma
 * (`entity: 'SubInvoice'`) y se distinguen por el contenido: la anulación por su
 * `action`, y la asignación de servicio porque su `after` trae `servicios`.
 */
export function movimientoDeAuditoria(log: LogAuditado): Movimiento {
  const before = (log.before ?? {}) as any;
  const after = (log.after ?? {}) as any;
  const por = (after.by ?? null) as string | null;
  const motivo = (after.reason ?? null) as string | null;

  if (log.action === 'VOID') {
    return {
      id: log.id, fecha: log.createdAt, tipo: 'ANULACION', titulo: 'Factura anulada', por, motivo,
      cambios: [
        `Estado ${ESTADO[before.status] ?? before.status ?? '—'} → Anulada`,
        ...(before.voidedPayments > 0
          ? [`Se reversaron ${before.voidedPayments} pago(s) por ${copHistorial(before.paidAmount ?? 0)}`]
          : []),
      ],
    };
  }

  if (after.servicios) {
    const etiqueta = (s: any) =>
      s.kind === 'PUNTOS' ? `${s.qty ?? 0} punto(s) de TV` : (s.planName ?? s.kind);
    const antes = (before.servicios ?? []).map(etiqueta).join(', ') || 'sin servicio';
    const despues = (after.servicios ?? []).map(etiqueta).join(', ') || 'sin servicio';
    return {
      id: log.id, fecha: log.createdAt, tipo: 'SERVICIO', titulo: 'Servicio asignado al cliente', por, motivo,
      cambios: antes === despues ? [`Servicio: ${despues}`] : [`Servicio: ${antes} → ${despues}`],
    };
  }

  const cambios = [
    campo('Total', before.total, after.total, (v) => copHistorial(Number(v) || 0)),
    campo('IVA', before.tax, after.tax, (v) => copHistorial(Number(v) || 0)),
    campo('Estado', before.status, after.status, (v) => ESTADO[String(v)] ?? String(v ?? '—')),
    campo('Tipo', before.kind, after.kind, (v) => (v === 'FIJA' ? 'Fija' : v === 'RECURRENTE' ? 'Recurrente' : String(v ?? '—'))),
    campo('Fecha de emisión', before.invoiceDate, after.invoiceDate, fechaCorta),
    campo('Vencimiento', before.dueDate, after.dueDate, fechaCorta),
    campo('Observación', before.notes, after.notes, (v) => (v ? String(v) : '—')),
    ...diffConceptos(before.items ?? [], after.items ?? []),
  ].filter((x): x is string => x != null);

  return {
    id: log.id, fecha: log.createdAt, tipo: 'EDICION', titulo: 'Factura editada', por, motivo,
    cambios: cambios.length ? cambios : ['Se reescribieron los conceptos sin cambiar el total.'],
  };
}

/** Movimiento de una nota crédito/débito (que también cambia el total de la factura). */
export function movimientoDeNota(nota: {
  id: string;
  createdAt: Date;
  productName: string | null;
  description: string | null;
  price: number;
  autor: string | null;
}): Movimiento {
  const credito = nota.productName === 'Nota Credito';
  const monto = Math.abs(nota.price);
  return {
    id: nota.id,
    fecha: nota.createdAt,
    tipo: credito ? 'NOTA_CREDITO' : 'NOTA_DEBITO',
    titulo: credito ? 'Nota crédito' : 'Nota débito',
    por: nota.autor,
    // En una nota, la descripción ES el motivo: ahí es donde se escribe la promoción
    // aplicada, la retención o el ajuste acordado.
    motivo: nota.description && nota.description !== nota.productName ? nota.description : null,
    cambios: [`${credito ? 'Rebaja' : 'Recarga'} de ${copHistorial(monto)} sobre el total`],
    monto,
  };
}
