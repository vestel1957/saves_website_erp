"use client";

import { useMemo, useState } from "react";
import { Icon } from "../Icon";
import type { SortState } from "./DataTable";
import { alternarOrden, ordenarPorValor } from "./table-sort";

/**
 * Orden en la cabecera para las tablas escritas a mano en HTML.
 *
 * `DataTable` ya ordena solo, pero varias pantallas montan su `<table>` a pelo
 * porque tienen algo que el componente no hace: fila de saldo inicial, pie de
 * totales, celdas con `colSpan`, filas agrupadas. Convertirlas a `DataTable`
 * sería una cirugía con riesgo de romper esos detalles, así que se les añade
 * solo lo que faltaba: la cabecera pulsable.
 *
 * Ordena ÚNICAMENTE el arreglo de filas que se le pasa. Lo que se pinte aparte
 * (totales, saldo inicial, subtotales) se queda donde está, que es justo lo que
 * se quiere en un informe contable.
 *
 * Uso, respetando el `<th>` que ya existía:
 *
 *   const t = useTablaOrdenable(data.rows, {
 *     codigo: (r) => r.code,
 *     cuenta:  (r) => r.name,
 *     debito:  (r) => r.debit,
 *   });
 *   ...
 *   <th className="…lo de siempre…"><BotonOrden t={t} clave="codigo">Código</BotonOrden></th>
 *   ...
 *   {t.filas.map(…)}
 */
export function useTablaOrdenable<T>(
  filas: T[],
  /** Clave de columna → de dónde sale el valor por el que se ordena. */
  valores: Record<string, (fila: T) => unknown>,
  inicial?: SortState,
) {
  const [orden, setOrden] = useState<SortState | null>(inicial ?? null);

  const ordenadas = useMemo(() => {
    if (!orden) return filas;
    const valor = valores[orden.by];
    if (!valor) return filas;
    return ordenarPorValor(filas, valor, orden.dir);
    // `valores` se declara en línea en el render, así que se compara por sus
    // claves y no por identidad: si no, esto se recalcularía en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filas, orden, Object.keys(valores).join(",")]);

  return {
    filas: ordenadas,
    orden,
    pulsar: (clave: string) => setOrden((s) => alternarOrden(s, clave)),
  };
}

export type TablaOrdenable = ReturnType<typeof useTablaOrdenable>;

/**
 * Contenido pulsable de un `<th>`. Va dentro del `<th>` que ya estaba para no
 * tocar sus clases (ancho, alineación, tipografía).
 */
export function BotonOrden<T>({
  t,
  clave,
  children,
}: {
  t: { orden: SortState | null; pulsar: (clave: string) => void };
  clave: string;
  children: React.ReactNode;
}) {
  const activa = t.orden?.by === clave;
  return (
    <button
      type="button"
      onClick={() => t.pulsar(clave)}
      title="Ordenar por esta columna"
      className={`inline-flex cursor-pointer items-center gap-1 font-semibold uppercase tracking-wider transition-colors hover:text-text-primary ${
        activa ? "text-text-primary" : ""
      }`}
    >
      {children}
      {activa ? (
        <Icon name={t.orden!.dir === "desc" ? "arrow-down" : "arrow-up"} size={12} className="text-brand" />
      ) : (
        <Icon name="chevrons-up-down" size={12} className="opacity-40" />
      )}
    </button>
  );
}
