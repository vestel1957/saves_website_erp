"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import { Input, Select } from "@/components/ui/Field";
import { ListToolbar } from "@/components/ui/ListToolbar";
import { useAuth } from "@/context/AuthProvider";
import { listaJson } from "@/lib/errores";
import { cop } from "@/lib/subscribers";
import { TX_METHODS, TX_TYPE_LABEL } from "@/lib/treasury";
import { RangoFechas, rangoDePreset, rangoDeUrl, rangoAUrl, etiquetaRango, type RangoFechasValor } from "@/components/ui/RangoFechas";

/**
 * Filtros de los listados de movimientos (Ingresos, Egresos, Anulaciones).
 *
 * Antes estas tres pantallas tenían un buscador de texto y nada más: para "los egresos
 * de Villanueva de la semana pasada de más de 500.000 sin comprobante" no había otra
 * salida que pasar páginas. El filtro rico vivía sólo en Movimientos (/tesoreria), que
 * la cajera ni siquiera tiene.
 *
 * Dos decisiones que no son obvias:
 *  - **La sede no es una columna del movimiento**: vive en la caja
 *    (`CashAccount.branchLegacy`). El desplegable se arma con las cajas que el
 *    servidor deja ver, así que ya viene acotado a lo que le toca a cada uno, y elegir
 *    sede acota además el desplegable de cajas.
 *  - **A la cajera no se le enseña ni periodo ni caja**: va acotada a SU ventanilla y
 *    al día de hoy, y esa regla la impone el servidor (ver `treasury.service.list`).
 *    Enseñarle controles que no cambian nada sería mentirle.
 */
export type FiltrosTx = {
  /** null = no mandar periodo (la cajera va a HOY por el servidor). */
  rango: RangoFechasValor | null;
  sede: string;
  cashAccountId: string;
  category: string;
  method: string;
  /** Monto del movimiento, en pesos (texto porque viene de un input). */
  min: string;
  max: string;
  /** '1' con comprobante · '0' sin comprobante · '' cualquiera. */
  attach: string;
  status: string;
  type: string;
};

/** Los atajos de periodo de tesorería: aquí la pregunta suele ser por día o semana. */
const PRESETS_TESORERIA = ["hoy", "semana", "mes", "mesPasado", "anio", "personalizado"] as const;

export const filtrosVacios = (cajera: boolean): FiltrosTx => ({
  rango: cajera ? null : rangoDePreset("mes"),
  sede: "", cashAccountId: "", category: "", method: "",
  min: "", max: "", attach: "", status: "", type: "",
});

/** Cuántos filtros hay puestos (sin contar el periodo, que siempre tiene valor). */
export function filtrosActivos(f: FiltrosTx): number {
  return [f.sede, f.cashAccountId, f.category, f.method, f.min, f.max, f.attach, f.status, f.type]
    .filter((v) => v !== "").length;
}

/**
 * Los filtros tal como viajan en la URL del listado, con nombres en castellano
 * (`?sede=3&caja=12&metodo=Efectivo&min=500000&comprobante=0&periodo=semana`).
 * Así volver atrás, recargar o pasarle el enlace a un compañero deja la lista igual.
 *
 * A la cajera no se le lee ni se le escribe periodo ni caja: el servidor la lleva a
 * su ventanilla y a hoy, y un enlace que le llegara con otro periodo no debe
 * enseñarle un control que no cambia nada.
 */
export function filtrosTxDeUrl(v: Record<string, string>, cajera: boolean): FiltrosTx {
  const numero = (s?: string) => (s && /^\d+$/.test(s) ? s : "");
  return {
    rango: cajera ? null : rangoDeUrl(v),
    sede: !cajera && v.sede !== undefined && /^\d+$/.test(v.sede) ? v.sede : "",
    cashAccountId: cajera ? "" : numero(v.caja),
    category: v.categoria ?? "",
    method: v.metodo ?? "",
    min: numero(v.min),
    max: numero(v.max),
    attach: v.comprobante === "1" || v.comprobante === "0" ? v.comprobante : "",
    status: v.estado ?? "",
    type: v.tipo ?? "",
  };
}

export function filtrosTxAUrl(f: FiltrosTx): Record<string, string> {
  return {
    ...rangoAUrl(f.rango),
    sede: f.sede, caja: f.cashAccountId, categoria: f.category, metodo: f.method,
    min: f.min, max: f.max, comprobante: f.attach, estado: f.status, tipo: f.type,
  };
}

type Caja = { id: number; name: string; branchLegacy: number | null; sede: string | null };

export function FiltrosMovimientos({
  value, onChange, search, onSearch, cajera, fijos, totales, resultados, acciones,
}: {
  value: FiltrosTx;
  onChange: (f: FiltrosTx) => void;
  search: string;
  onSearch: (s: string) => void;
  /** Cajera "pura": sin periodo ni selector de caja (va a su ventanilla y a hoy). */
  cajera: boolean;
  /** Lo que la pantalla ya fija y por tanto no se ofrece como filtro. */
  fijos: { type?: string; status?: string };
  totales?: { ingresos: number; egresos: number; balance: number; arrastres: number };
  resultados?: number;
  /** Botones a la derecha del buscador (el Excel de la pantalla). */
  acciones?: ReactNode;
}) {
  const { authFetch } = useAuth();
  const [cajas, setCajas] = useState<Caja[]>([]);
  const [cats, setCats] = useState<{ name: string }[]>([]);
  const [abierto, setAbierto] = useState(false);

  useEffect(() => {
    void authFetch("/treasury/cash-accounts").then(listaJson).then(setCajas).catch(() => {});
    void authFetch("/treasury/categories").then(listaJson).then(setCats).catch(() => {});
  }, [authFetch]);

  /** Sedes que existen entre las cajas visibles. 0 = los bancos, que no son de nadie. */
  const sedes = useMemo(() => {
    const m = new Map<number, string>();
    for (const c of cajas) {
      if (c.branchLegacy == null) continue;
      m.set(c.branchLegacy, c.sede ?? `Sede ${c.branchLegacy}`);
    }
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [cajas]);

  /** Elegida una sede, el desplegable de cajas se queda con las de esa sede. */
  const cajasVisibles = useMemo(
    () => (value.sede === "" ? cajas : cajas.filter((c) => String(c.branchLegacy) === value.sede)),
    [cajas, value.sede],
  );

  const set = (parche: Partial<FiltrosTx>) => onChange({ ...value, ...parche });
  const activos = filtrosActivos(value);

  return (
    <div className="mb-3 flex flex-col gap-2">
      {!cajera && value.rango && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <RangoFechas
            value={value.rango}
            onChange={(r) => set({ rango: r })}
            presets={[...PRESETS_TESORERIA]}
            conHora
          />
          <span className="text-[12px] font-medium text-text-tertiary">{etiquetaRango(value.rango)}</span>
        </div>
      )}

      <ListToolbar search={search} onSearch={onSearch} searchPlaceholder="Buscar por código, pagador, factura, nota o cuenta…" actions={acciones}>
        {!cajera && sedes.length > 1 && (
          <Select
            value={value.sede}
            // Cambiar de sede tira la caja elegida: si no, quedaría filtrando por una
            // caja que ya no está en la lista y la tabla saldría vacía sin explicación.
            onChange={(e) => set({ sede: e.target.value, cashAccountId: "" })}
            className="w-auto"
            aria-label="Sede"
          >
            <option value="">Todas las sedes</option>
            {sedes.map(([id, nombre]) => <option key={id} value={id}>{nombre}</option>)}
          </Select>
        )}
        {!cajera && (
          <Select value={value.cashAccountId} onChange={(e) => set({ cashAccountId: e.target.value })} className="w-auto" aria-label="Caja o cuenta">
            <option value="">Todas las cajas</option>
            {cajasVisibles.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        )}
        <Select value={value.category} onChange={(e) => set({ category: e.target.value })} className="w-auto" aria-label="Categoría">
          <option value="">Categoría</option>
          {fijos.type !== "EXPENSE" && <option value="Sales">Ventas (Sales)</option>}
          {cats.map((c) => <option key={c.name} value={c.name}>{c.name}</option>)}
        </Select>
        <Select value={value.method} onChange={(e) => set({ method: e.target.value })} className="w-auto" aria-label="Método de pago">
          <option value="">Método</option>
          {TX_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        <button
          type="button"
          onClick={() => setAbierto((v) => !v)}
          className="tap inline-flex items-center gap-1.5 rounded-lg border border-border-default px-3 py-2 text-[12px] font-semibold text-text-secondary transition-colors hover:bg-surface-2"
        >
          <Icon name="sliders-horizontal" size={14} /> Más filtros
          {activos > 0 && (
            <span className="rounded-full bg-brand px-1.5 text-[10px] font-bold text-on-brand">{activos}</span>
          )}
          <Icon name={abierto ? "chevron-up" : "chevron-down"} size={13} />
        </button>
        {(activos > 0 || search || value.rango?.horaDesde || value.rango?.horaHasta) && (
          <button
            type="button"
            onClick={() => { onSearch(""); onChange(filtrosVacios(cajera)); }}
            className="tap inline-flex items-center gap-1 px-2 py-2 text-[12px] font-semibold text-text-tertiary hover:text-text-primary"
          >
            <Icon name="x" size={13} /> Limpiar
          </button>
        )}
      </ListToolbar>

      {abierto && (
        <div className="grid grid-cols-1 gap-2 rounded-lg border border-border-subtle bg-surface-2 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-text-tertiary">Monto desde</span>
            <Input type="number" min={0} inputMode="numeric" placeholder="0"
              value={value.min} onChange={(e) => set({ min: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-text-tertiary">Monto hasta</span>
            <Input type="number" min={0} inputMode="numeric" placeholder="Sin tope"
              value={value.max} onChange={(e) => set({ max: e.target.value })} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold text-text-tertiary">Comprobante</span>
            <Select value={value.attach} onChange={(e) => set({ attach: e.target.value })}>
              <option value="">Con o sin</option>
              <option value="1">Con comprobante</option>
              <option value="0">Sin comprobante</option>
            </Select>
          </label>
          {/* Tipo y estado sólo donde la pantalla no los fija ya (Ingresos fija el tipo,
              Anulaciones fija el estado): un filtro que no puede cambiar nada estorba. */}
          {!fijos.type && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-text-tertiary">Tipo</span>
              <Select value={value.type} onChange={(e) => set({ type: e.target.value })}>
                <option value="">Todos</option>
                {Object.entries(TX_TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </Select>
            </label>
          )}
          {!fijos.status && (
            <label className="flex flex-col gap-1">
              <span className="text-[11px] font-semibold text-text-tertiary">Estado</span>
              <Select value={value.status} onChange={(e) => set({ status: e.target.value })}>
                <option value="">Vigentes y anuladas</option>
                <option value="VIGENTE">Vigente</option>
                <option value="ANULADA">Anulada</option>
              </Select>
            </label>
          )}
        </div>
      )}

      {/* Lo que suma lo filtrado. Es la pregunta que sigue SIEMPRE a un filtro
          ("¿y cuánto es eso?") y hasta ahora se contestaba sumando a mano. Las
          anuladas no entran en la suma aunque salgan en la lista. */}
      {totales && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-lg border border-border-subtle bg-surface px-3 py-2 text-[12px]">
          <span className="font-medium text-text-tertiary">
            {(resultados ?? 0).toLocaleString("es-CO")} movimiento{resultados === 1 ? "" : "s"}
          </span>
          {fijos.type !== "EXPENSE" && totales.ingresos > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Icon name="trending-up" size={14} className="text-success-text" />
              <span className="text-text-tertiary">Ingresos</span>
              <span className="font-bold text-success-text">{cop(totales.ingresos)}</span>
            </span>
          )}
          {fijos.type !== "INCOME" && totales.egresos > 0 && (
            <span className="inline-flex items-center gap-1.5">
              <Icon name="trending-down" size={14} className="text-error-text" />
              <span className="text-text-tertiary">Egresos</span>
              <span className="font-bold text-error-text">{cop(totales.egresos)}</span>
            </span>
          )}
          {!fijos.type && (
            <span className="inline-flex items-center gap-1.5">
              <Icon name="scale" size={14} className="text-text-secondary" />
              <span className="text-text-tertiary">Balance</span>
              <span className={`font-bold ${totales.balance >= 0 ? "text-success-text" : "text-error-text"}`}>{cop(totales.balance)}</span>
            </span>
          )}
          {/* El arrastre ('Saldo <fecha>') sale en la lista pero NO en el total: son las
              dos patas con las que el cierre pasa el saldo al día siguiente, no plata
              que entre ni salga. Sumarlas casi doblaría la cifra, así que se dice. */}
          {totales.arrastres > 0 && (
            <span className="inline-flex items-center gap-1 text-text-tertiary" title="Las patas 'Saldo <fecha>' del cierre de caja no son ingreso ni egreso: aparecen en la lista pero no suman en el total.">
              <Icon name="info" size={13} />
              sin {totales.arrastres.toLocaleString("es-CO")} arrastre{totales.arrastres === 1 ? "" : "s"} de caja
            </span>
          )}
          {cajera && (
            <span className="ml-auto inline-flex items-center gap-1.5 text-text-tertiary">
              <Icon name="wallet" size={13} /> Tu caja · hoy
            </span>
          )}
        </div>
      )}
    </div>
  );
}
