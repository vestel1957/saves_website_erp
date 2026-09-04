"use client";

import { useEffect, useMemo, useState } from "react";
import { DataTable, type Column, type SortState } from "@/components/ui/DataTable";
import { Pagination, TODOS } from "@/components/ui/Pagination";
import { alternarOrden, ordenarFilas } from "@/components/ui/table-sort";

/**
 * Tabla con paginación en el cliente: corta las filas en memoria y reutiliza
 * el `Pagination` compartido (mismos tamaños 25/50/100 y mismo aspecto que la
 * paginación de servidor). Para listados que ya cargan todo de un golpe.
 *
 * El orden lo resuelve aquí y no el `DataTable` de dentro, porque hay que
 * ordenar el conjunto completo **antes** de cortar la página: si ordenara la
 * tabla interna, cada página se ordenaría por separado y el resultado sería
 * mentira.
 */
export function PagedTable<T>({
  columns, rows, empty, onRowClick, rowHref, defaultPageSize = 25,
  loading, loadingText, sort, onSort, conTodos = false,
}: {
  columns: Column<T>[];
  rows: T[];
  empty?: string;
  onRowClick?: (row: T) => void;
  /** A dónde lleva la fila; habilita ctrl+clic / botón central en pestaña nueva. */
  rowHref?: (row: T) => string;
  defaultPageSize?: number;
  loading?: boolean;
  loadingText?: string;
  sort?: SortState;
  onSort?: (sortKey: string) => void;
  /** Añade la opción "Todos" al selector de tamaño (todas las filas en una página). */
  conTodos?: boolean;
}) {
  const [pageSize, setPageSize] = useState(defaultPageSize);
  const [page, setPage] = useState(1);
  const [ordenLocal, setOrdenLocal] = useState<SortState | null>(null);

  // Si la pantalla controla el orden (`onSort`), aquí no se toca nada.
  const propio = !onSort;
  const orden = propio ? ordenLocal : sort;

  const ordenadas = useMemo(
    () => (propio ? ordenarFilas(rows, columns, ordenLocal) : rows),
    [propio, rows, columns, ordenLocal],
  );

  const total = ordenadas.length;
  // "Todos" llega como 0: la página es la lista entera.
  const tamano = pageSize === TODOS ? Math.max(total, 1) : pageSize;
  const pageCount = Math.max(1, Math.ceil(total / tamano));

  // Al cambiar los datos o el tamaño, no dejar la página fuera de rango.
  useEffect(() => { setPage((p) => Math.min(Math.max(1, p), pageCount)); }, [pageCount]);

  const startIdx = (page - 1) * tamano;
  const pageRows = useMemo(() => ordenadas.slice(startIdx, startIdx + tamano), [ordenadas, startIdx, tamano]);

  // Reordenar manda al usuario al principio de la lista: lo que buscaba al
  // pulsar la cabecera está arriba, no en la página en la que estaba.
  const cambiarOrden = (clave: string) => {
    if (propio) setOrdenLocal((s) => alternarOrden(s, clave));
    else onSort!(clave);
    setPage(1);
  };

  return (
    <div className="flex flex-col gap-3">
      <DataTable
        columns={columns} rows={pageRows} empty={empty} onRowClick={onRowClick} rowHref={rowHref}
        loading={loading} loadingText={loadingText} sort={orden ?? undefined} onSort={cambiarOrden}
        sortableByDefault={propio}
      />
      {total > 0 && (
        <Pagination
          meta={{ page, pageSize: tamano, total, pageCount }}
          onPage={setPage}
          onPageSize={(s) => { setPageSize(s); setPage(1); }}
          conTodos={conTodos}
          esTodos={pageSize === TODOS}
        />
      )}
    </div>
  );
}
