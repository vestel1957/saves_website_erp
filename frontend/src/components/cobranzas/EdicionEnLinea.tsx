"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Icon } from "@/components/Icon";
import type { Column } from "@/components/ui/DataTable";
import { Input, Select } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import { PAY_METHODS } from "@/lib/cobranzas";
import { mensajeDeError } from "@/lib/errores";
import type { TxRow } from "@/lib/treasury";

/**
 * Edición EN LA PROPIA FILA de un movimiento de tesorería.
 *
 * Antes corregir un ingreso o un egreso era abrir un modal, tocar el campo y guardar;
 * la lista de al lado se perdía de vista. Aquí la fila se convierte en formulario: los
 * campos seguros (fecha, categoría, método, monto y nota) se vuelven inputs en su sitio
 * y la columna de acciones pasa a Guardar / Cancelar.
 *
 * QUIÉN — contabilidad y superusuario, igual que antes (el backend exige área
 * `contabilidad` en el PATCH). La cajera registra plata pero no vuelve sobre la
 * registrada: si se equivoca, contabilidad lo corrige o se anula y se rehace.
 *
 * QUÉ NO SE PUEDE — el monto de un pago de venta (factura + categoría Sales): eso se
 * anula y se registra de nuevo, porque mueve el `paidAmount` de la factura. El input
 * queda deshabilitado y el backend lo niega igual.
 */

type Borrador = { date: string; category: string; method: string; amount: string; note: string };

/** El monto de un pago de venta no se toca: se anula el movimiento y se rehace. */
const esPagoDeVenta = (r: TxRow) => !!r.invoiceTid && r.category === "Sales" && r.type === "INCOME";

/** ¿Este usuario puede corregir movimientos ya registrados? (espejo de la ruta PATCH). */
export function usePuedeEditarMovimientos(): boolean {
  const { can, isSuperadmin } = useAuth();
  return isSuperadmin || can(PERM.AREA_CONTABILIDAD);
}

export type EdicionEnLinea = {
  activa: boolean;
  /** ¿Esta fila es la que se está editando ahora? */
  editando: (r: TxRow) => boolean;
  /** ¿Se le puede abrir el formulario? (permiso + no anulada + no se está editando otra). */
  editable: (r: TxRow) => boolean;
  iniciar: (r: TxRow) => void;
  cancelar: () => void;
  guardar: () => void;
  guardando: boolean;
  borrador: Borrador | null;
  setCampo: (k: keyof Borrador, v: string) => void;
  categorias: string[];
  fila: TxRow | null;
};

/**
 * Estado de la fila en edición + guardado contra `PATCH /treasury/transactions/:id`.
 * `onDone` refresca el listado de quien lo usa (así el monto y el orden se recargan
 * desde el servidor, no se parchean a mano en la tabla). `habilitada` en `false` deja
 * la lista como estaba (pantallas donde corregir no aplica, p. ej. Anulaciones).
 */
export function useEdicionEnLinea({ onDone, habilitada = true }: { onDone: () => void; habilitada?: boolean }): EdicionEnLinea {
  const { authFetch } = useAuth();
  const puede = usePuedeEditarMovimientos() && habilitada;
  const [fila, setFila] = useState<TxRow | null>(null);
  const [borrador, setBorrador] = useState<Borrador | null>(null);
  const [guardando, setGuardando] = useState(false);
  const [categorias, setCategorias] = useState<string[]>([]);

  // El catálogo de categorías (transactions_cat del legacy) solo se pide si quien
  // mira puede editar: a la cajera no le hace falta.
  useEffect(() => {
    if (!puede) return;
    void authFetch("/treasury/categories")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { name: string }[]) => setCategorias(rows.map((c) => c.name)))
      .catch(() => {});
  }, [puede, authFetch]);

  const iniciar = useCallback((r: TxRow) => {
    setFila(r);
    setBorrador({
      date: (r.date || "").slice(0, 10),
      category: r.category ?? "",
      method: r.method || "Cash",
      amount: String(r.amount ?? 0),
      note: r.note ?? "",
    });
  }, []);

  const cancelar = useCallback(() => { setFila(null); setBorrador(null); }, []);

  const setCampo = useCallback((k: keyof Borrador, v: string) => {
    setBorrador((b) => (b ? { ...b, [k]: v } : b));
  }, []);

  const guardar = useCallback(() => {
    if (!fila || !borrador || guardando) return;
    if (!borrador.date) { toast("Falta la fecha del movimiento", "alert-triangle"); return; }
    const monto = Number(borrador.amount);
    if (!esPagoDeVenta(fila) && (!Number.isFinite(monto) || monto < 0)) {
      toast("El monto no es válido", "alert-triangle");
      return;
    }
    setGuardando(true);
    void (async () => {
      try {
        const body: Record<string, unknown> = {
          category: borrador.category,
          method: borrador.method,
          date: borrador.date,
          note: borrador.note,
        };
        if (!esPagoDeVenta(fila)) body.amount = monto;
        const res = await authFetch(`/treasury/transactions/${fila.id}`, { method: "PATCH", body: JSON.stringify(body) });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.message || "No se pudo guardar");
        toast("Movimiento actualizado", "check");
        setFila(null); setBorrador(null);
        onDone();
      } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setGuardando(false); }
    })();
  }, [fila, borrador, guardando, authFetch, onDone]);

  return {
    activa: puede,
    editando: (r) => fila?.id === r.id,
    editable: (r) => puede && r.status !== "ANULADA" && !fila,
    iniciar, cancelar, guardar, guardando, borrador, setCampo, categorias, fila,
  };
}

/** Enter guarda, Escape cancela: editar una fila no debería exigir el ratón. */
function teclas(ed: EdicionEnLinea) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); ed.guardar(); }
    else if (e.key === "Escape") { e.preventDefault(); ed.cancelar(); }
  };
}

function BotonesEdicion({ ed }: { ed: EdicionEnLinea }) {
  return (
    <span className="inline-flex items-center gap-1">
      <button type="button" onClick={ed.guardar} disabled={ed.guardando} title="Guardar cambios (Enter)"
        className="inline-flex min-h-8 items-center gap-1 rounded-md bg-brand px-2.5 py-1 text-[11px] font-semibold text-on-brand disabled:opacity-60">
        <Icon name={ed.guardando ? "loader" : "check"} size={12} className={ed.guardando ? "animate-spin" : ""} />
        {ed.guardando ? "Guardando…" : "Guardar"}
      </button>
      <button type="button" onClick={ed.cancelar} disabled={ed.guardando} title="Descartar (Esc)"
        className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold text-text-secondary hover:bg-surface-2">
        <Icon name="x" size={12} /> Cancelar
      </button>
    </span>
  );
}

/**
 * Convierte columnas de movimientos en columnas editables: mientras la fila está en
 * edición, `date`, `cat`, `method`, `amount` y `note` pintan su input; el resto queda
 * como estaba. La columna de acciones gana el lápiz (y, en
 * edición, Guardar/Cancelar delante de las acciones propias de cada pantalla).
 *
 * Sirve tanto para la tabla de escritorio como para las tarjetas de móvil: DataTable
 * pinta el mismo `render` en las dos.
 */
export function columnasEditables(cols: Column<TxRow>[], ed: EdicionEnLinea): Column<TxRow>[] {
  if (!ed.activa) return cols;
  const b = ed.borrador;
  const onKeyDown = teclas(ed);

  const conInput = (c: Column<TxRow>): Column<TxRow> => {
    const original = c.render;
    switch (c.key) {
      case "date":
        return { ...c, render: (r) => !ed.editando(r) || !b ? original(r) : (
          <Input type="date" value={b.date} onKeyDown={onKeyDown} aria-label="Fecha"
            onChange={(e) => ed.setCampo("date", e.target.value)} className="w-36 px-2 py-1 text-[12px]" />
        ) };
      case "cat":
        return { ...c, render: (r) => !ed.editando(r) || !b ? original(r) : (
          <Select value={b.category} onKeyDown={onKeyDown} aria-label="Categoría" className="w-44"
            onChange={(e) => ed.setCampo("category", e.target.value)}>
            {/* La categoría vieja puede no estar en el catálogo (movimiento migrado). */}
            {b.category && !ed.categorias.includes(b.category) && <option value={b.category}>{b.category}</option>}
            {ed.categorias.map((x) => <option key={x} value={x}>{x}</option>)}
          </Select>
        ) };
      case "method":
        return { ...c, render: (r) => !ed.editando(r) || !b ? original(r) : (
          <Select value={b.method} onKeyDown={onKeyDown} aria-label="Método" className="w-40"
            onChange={(e) => ed.setCampo("method", e.target.value)}>
            {/* Igual que la categoría: se respeta lo que ya traía la fila. */}
            {b.method && !PAY_METHODS.some((m) => m.value === b.method) && <option value={b.method}>{b.method}</option>}
            {PAY_METHODS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        ) };
      case "amount":
        return { ...c, render: (r) => !ed.editando(r) || !b ? original(r) : (
          <span className="inline-flex flex-col items-end gap-0.5">
            <Input type="number" min={0} step="0.01" value={b.amount} onKeyDown={onKeyDown} aria-label="Monto"
              disabled={esPagoDeVenta(r)} onChange={(e) => ed.setCampo("amount", e.target.value)}
              className="w-32 px-2 py-1 text-right text-[12px]" />
            {esPagoDeVenta(r) && (
              <span className="text-[10px] leading-tight text-text-tertiary">Pago de venta: anular y rehacer</span>
            )}
          </span>
        ) };
      case "note":
        // La nota ya tiene columna propia (antes colgaba del pagador mientras se
        // editaba), así que el input se edita donde se lee.
        return { ...c, render: (r) => !ed.editando(r) || !b ? original(r) : (
          <Input value={b.note} onKeyDown={onKeyDown} aria-label="Nota" placeholder="Nota…"
            onChange={(e) => ed.setCampo("note", e.target.value)} className="w-full min-w-48 px-2 py-1 text-[12px]" />
        ) };
      default:
        return c;
    }
  };

  const lapiz = (r: TxRow): ReactNode => ed.editable(r) ? (
    <button type="button" onClick={() => ed.iniciar(r)} title="Editar en la fila"
      className="inline-flex min-h-8 items-center gap-1 text-[12px] font-medium text-text-secondary hover:text-brand">
      <Icon name="pencil" size={13} /> Editar
    </button>
  ) : null;

  const conAcciones = (c: Column<TxRow>): Column<TxRow> => {
    const original = c.render;
    return { ...c, render: (r) => ed.editando(r)
      ? <BotonesEdicion ed={ed} />
      : <span className="inline-flex flex-wrap items-center justify-end gap-1.5">{lapiz(r)}{original(r)}</span> };
  };

  const salida = cols.map((c) => (c.key === "acciones" ? conAcciones(conInput(c)) : conInput(c)));
  // Si la pantalla no traía columna de acciones, la edición pone la suya.
  if (!cols.some((c) => c.key === "acciones")) {
    salida.push({ key: "acciones", header: "", align: "right",
      render: (r) => ed.editando(r) ? <BotonesEdicion ed={ed} /> : lapiz(r) });
  }
  return salida;
}
