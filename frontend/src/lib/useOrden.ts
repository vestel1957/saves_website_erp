"use client";

import { useCallback, useState } from "react";
import type { SortState } from "@/components/ui/DataTable";
import { alternarOrden } from "@/components/ui/table-sort";

/**
 * Orden de tabla resuelto por el servidor, para los listados que paginan en
 * backend.
 *
 * En esos listados la tabla solo tiene la página que está viendo, así que no
 * puede ordenar por su cuenta: ordenaría 25 filas y diría "mayor saldo" cuando
 * es el mayor de esas 25. Con esto el orden viaja en la query (`sortBy`/
 * `sortDir`), el backend ordena el listado completo y vuelve la página que toca.
 *
 * Uso típico en una pantalla:
 *
 *   const orden = useOrden({ by: "creado", dir: "desc" });
 *   ...
 *   const qs = new URLSearchParams({ page, pageSize, ...orden.params });
 *   useRequest(() => `/x?${qs}`, [ ..., orden.clave]);
 *   <DataTable sort={orden.sort} onSort={orden.onSort} columns={[
 *     { key: "nombre", header: "Nombre", sortable: true, render: ... },
 *   ]} />
 *
 * Las columnas se marcan `sortable: true` una por una y no todas por defecto:
 * aquí solo se puede ordenar por lo que el endpoint conozca, y una flecha que
 * no hace nada es peor que no tener flecha.
 *
 * @param inicial orden con el que arranca la pantalla; debe coincidir con el
 *        orden por defecto del endpoint para que la cabecera no mienta al cargar.
 */
export function useOrden(inicial?: SortState) {
  const [sort, setSort] = useState<SortState | null>(inicial ?? null);

  const onSort = useCallback((by: string) => {
    setSort((s) => alternarOrden(s, by));
  }, []);

  return {
    sort: sort ?? undefined,
    onSort,
    /**
     * Para meter en la query string: `{...orden.params}`.
     *
     * El tipo va explícito porque sin él se infiere como unión de
     * `{sortBy, sortDir}` y `{}`, y al hacer el spread TypeScript la lee como
     * `sortBy?: undefined` — que es justo lo que `URLSearchParams` no acepta.
     */
    params: (sort ? { sortBy: sort.by, sortDir: sort.dir } : {}) as Record<string, string>,
    /**
     * Dependencia estable para `useRequest`: cambia solo cuando cambia el orden.
     * (El objeto `params` es nuevo en cada render y recargaría en bucle.)
     */
    clave: sort ? `${sort.by}:${sort.dir}` : "",
  };
}
