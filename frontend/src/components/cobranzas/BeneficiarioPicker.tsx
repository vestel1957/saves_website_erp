"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/Icon";
import { Input, Select } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";
import { toast } from "@/components/ui/Toast";
import { mensajeDeError } from "@/lib/errores";

/**
 * A quién se le paga (o quién paga) en un movimiento de tesorería.
 *
 * `id` null = texto libre: alguien que no está en el directorio y que no vale la
 * pena registrar (un pago suelto). Con id, el movimiento queda LIGADO al
 * proveedor/tercero y aparece en su estado de cuenta.
 */
export type Beneficiario = { id: string | null; name: string; category?: number; nit?: string | null };

export const CATEGORIA_BENEFICIARIO: Record<number, string> = { 1: "Producto", 2: "Servicio", 3: "Tercero" };

/** Valor centinela del <option> de texto libre: no es —ni puede ser— un id real. */
const A_MANO = "__a_mano__";

/** Igual, en plural: encabeza los grupos del desplegable. */
const CATEGORIA_GRUPO: Record<number, string> = { 1: "Proveedores de productos", 2: "Proveedores de servicios", 3: "Terceros" };

/**
 * Beneficiario del movimiento. Se PROPONE el directorio; escribir a mano es la
 * salida, no la puerta de entrada.
 *
 * Ese orden importa: escribir el nombre a mano es lo que tiene 4.330 beneficiarios
 * distintos en los egresos históricos, con el mismo señor repetido por una tilde o
 * un "Dr." de más. Pero el pago suelto existe y hay que poder registrarlo.
 *
 * Tiene dos caras según quién registre, y la diferencia es deliberada:
 *
 * - **Cajera**: un desplegable con el directorio entero (terceros primero) y, al
 *   final, la salida «Otro — escribir el nombre» para el pago suelto a alguien
 *   que no está en el directorio (un domicilio, un arreglo, el señor que vino a
 *   pintar). No da de alta a nadie —registra plata, no administra catálogos—,
 *   pero tampoco se queda sin poder registrar el egreso: el directorio se
 *   propone primero, no encierra.
 * - **Contabilidad / administración**: buscador con autocompletar, con el atajo
 *   para crear el tercero que falte y la salida de texto libre para el pago suelto
 *   a alguien que no va a volver (obligar a registrarlo sería peor que el
 *   problema que resuelve).
 *
 * El área se mira aquí dentro y no se pasa por prop para que no haya dos pantallas
 * con criterios distintos sobre lo mismo.
 */
export function BeneficiarioPicker({
  value,
  onChange,
  placeholder = "Buscar proveedor o tercero…",
  autoFocus = false,
}: {
  value: Beneficiario | null;
  onChange: (b: Beneficiario | null) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const { authFetch, can } = useAuth();
  // Mismo criterio que el POST del backend: quien no es de contabilidad ni de
  // administración (la cajera) elige y punto.
  const puedeEscribir = can(["area.contabilidad", "area.administracion"]);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Beneficiario[]>([]);
  const [abierto, setAbierto] = useState(false);
  const [cargando, setCargando] = useState(false);
  const [creando, setCreando] = useState(false);
  // Alta de un tercero que no está en el directorio. Es un formulario y no un
  // botón de un solo golpe porque el NIT o la cédula es OBLIGATORIO: es lo único
  // que distingue de verdad a dos personas con el mismo nombre, y si no se pide
  // aquí nadie va a ir después a Proveedores a completarlo. Quien no lo tenga a
  // mano tiene la otra salida —usar el nombre sin registrarlo—, que no da de alta.
  const [alta, setAlta] = useState<{ name: string; nit: string } | null>(null);
  // Desplegable cerrado: el usuario pidió expresamente «Otro» y está tecleando.
  const [aMano, setAMano] = useState(false);
  const caja = useRef<HTMLDivElement>(null);

  const buscar = useCallback(async (term: string) => {
    setCargando(true);
    try {
      const r = await authFetch(`/treasury/beneficiaries?search=${encodeURIComponent(term)}`);
      const d = r.ok ? await r.json() : [];
      setItems(Array.isArray(d) ? d : []);
    } catch {
      setItems([]);
    } finally {
      setCargando(false);
    }
  }, [authFetch]);

  // Se busca también con el campo vacío: al enfocar se ve el directorio de
  // entrada, que es lo que hace que esto sea un desplegable y no otro buscador
  // en el que hay que adivinar qué escribir.
  useEffect(() => {
    if (!puedeEscribir || value) return;
    const t = setTimeout(() => { void buscar(q.trim()); }, q.trim() ? 300 : 0);
    return () => clearTimeout(t);
  }, [q, value, buscar, puedeEscribir]);

  // Desplegable cerrado (cajera): el directorio entra entero y de una sola vez,
  // porque no hay dónde teclear para filtrarlo.
  useEffect(() => {
    if (puedeEscribir) return;
    void buscar("");
  }, [puedeEscribir, buscar]);

  /** Agrupado por categoría para el <select>: terceros primero. */
  const grupos = useMemo(() => {
    const orden = [3, 2, 1];
    return orden
      .map((c) => ({ categoria: c, items: items.filter((i) => (i.category ?? 0) === c) }))
      .filter((g) => g.items.length > 0);
  }, [items]);

  // En CAPTURA: dentro de un Modal el mousedown no llega hasta document en fase
  // de burbuja (el Modal lo corta) y el desplegable se quedaba abierto.
  useEffect(() => {
    const fuera = (e: MouseEvent) => { if (caja.current && !caja.current.contains(e.target as Node)) setAbierto(false); };
    document.addEventListener("mousedown", fuera, true);
    return () => document.removeEventListener("mousedown", fuera, true);
  }, []);

  const termino = q.trim();
  const hayExacto = items.some((i) => i.name.trim().toLowerCase() === termino.toLowerCase());

  const elegir = (b: Beneficiario) => { onChange(b); setAbierto(false); setQ(""); setAlta(null); };

  async function crearTercero() {
    const nombre = alta?.name.trim();
    const documento = alta?.nit.trim() ?? "";
    // El backend lo rechaza igual: esto es para no gastarle el viaje ni enseñarle
    // un error rojo a quien todavía está escribiendo.
    if (!nombre || documento.length < 5 || creando) return;
    setCreando(true);
    try {
      const r = await authFetch(`/treasury/beneficiaries`, {
        method: "POST",
        body: JSON.stringify({ name: nombre, category: 3, nit: documento }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d?.message || "No se pudo crear el tercero");
      toast(`Tercero creado: ${d.name}`, "check");
      setAlta(null);
      elegir({ id: d.id, name: d.name, category: d.category, nit: d.nit });
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo crear el tercero"), "alert-triangle");
    } finally {
      setCreando(false);
    }
  }

  // --- Cajera: desplegable del directorio + salida a texto libre ---
  if (!puedeEscribir) {
    const vacio = !cargando && items.length === 0;
    // Escribiendo a mano: o lo pidió con «Otro», o el movimiento ya trae un
    // nombre suelto (sin id) y hay que poder verlo y corregirlo.
    if (aMano || (value && !value.id)) {
      return (
        <div className="flex items-center gap-2">
          <Input
            className="min-w-0 flex-1"
            placeholder="A quién se le paga"
            autoFocus
            value={value?.id ? "" : (value?.name ?? "")}
            // Sin nombre no viaja beneficiario ninguno: borrar el campo equivale
            // a no haber elegido a nadie.
            onChange={(e) => onChange(e.target.value.trim() ? { id: null, name: e.target.value } : null)}
          />
          <button
            type="button"
            title="Volver a la lista"
            onClick={() => { setAMano(false); onChange(null); }}
            className="shrink-0 rounded-md p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
          >
            <Icon name="list" size={15} />
          </button>
        </div>
      );
    }
    return (
      <Select
        // Ojo: NO se deshabilita con el directorio vacío. Deshabilitarlo dejaba a
        // la cajera sin poder registrar el egreso, que es justo lo contrario de
        // lo que hay que hacer cuando no hay a quién elegir.
        value={value?.id ?? ""}
        disabled={cargando}
        onChange={(e) => {
          if (e.target.value === A_MANO) { setAMano(true); onChange(null); return; }
          onChange(items.find((i) => i.id === e.target.value) ?? null);
        }}
      >
        <option value="">
          {cargando ? "Cargando…" : vacio ? "— Escribe a quién se le paga —" : "— Elige un beneficiario —"}
        </option>
        {grupos.map((g) => (
          <optgroup key={g.categoria} label={CATEGORIA_GRUPO[g.categoria] ?? "Otros"}>
            {g.items.map((b) => <option key={b.id} value={b.id ?? ""}>{b.name}</option>)}
          </optgroup>
        ))}
        <option value={A_MANO}>Otro — escribir el nombre…</option>
      </Select>
    );
  }

  if (value) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-lg border border-border-default bg-surface-2 px-3 py-2">
        <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-text-primary">
          <Icon name={value.id ? "truck" : "pencil"} size={14} className="shrink-0 text-brand" />
          <span className="truncate">{value.name}</span>
          {/* El documento identifica: con dos "Juan Pérez" en el directorio es lo
              único que dice cuál se eligió. */}
          {value.nit && <span className="shrink-0 font-normal text-text-tertiary">NIT/CC {value.nit}</span>}
          <span className="shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
            {value.id ? (CATEGORIA_BENEFICIARIO[value.category ?? 3] ?? "Directorio") : "Texto libre"}
          </span>
        </span>
        <button
          type="button"
          title="Quitar"
          onClick={() => { onChange(null); setQ(""); }}
          className="rounded-md p-1 text-text-tertiary hover:bg-surface hover:text-text-primary"
        >
          <Icon name="x" size={14} />
        </button>
      </div>
    );
  }

  return (
    <div ref={caja} className="relative">
      <Icon name="search" size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
      <Input
        className="pl-9"
        placeholder={placeholder}
        value={q}
        autoFocus={autoFocus}
        onChange={(e) => { setQ(e.target.value); setAbierto(true); }}
        onFocus={() => setAbierto(true)}
      />
      {abierto && (
        <div className={`absolute z-20 mt-1 w-full overflow-y-auto rounded-lg border border-border-default bg-surface shadow-lg ${alta ? "max-h-96" : "max-h-64"}`}>
          {cargando && <div className="px-3 py-2 text-[12px] text-text-tertiary">Buscando…</div>}
          {!cargando && items.length === 0 && (
            <div className="px-3 py-2 text-[12px] text-text-tertiary">
              {termino ? "Nadie con ese nombre en el directorio." : "El directorio está vacío."}
            </div>
          )}
          {items.map((b) => (
            <button
              key={b.id ?? b.name}
              type="button"
              onClick={() => elegir(b)}
              className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-[13px] hover:bg-surface-2"
            >
              <span className="min-w-0 truncate">
                <span className="font-medium text-text-primary">{b.name}</span>
                {b.nit && <span className="ml-1.5 text-[11px] text-text-tertiary">NIT/CC {b.nit}</span>}
              </span>
              <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-text-tertiary">
                {CATEGORIA_BENEFICIARIO[b.category ?? 0] ?? ""}
              </span>
            </button>
          ))}

          {/* Salidas cuando lo escrito no está en el directorio (sólo llega aquí
              quien puede escribir: contabilidad y administración). */}
          {termino && !hayExacto && !alta && (
            <div className="sticky bottom-0 border-t border-border-subtle bg-surface">
              <button
                type="button"
                onClick={() => setAlta({ name: termino, nit: "" })}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-semibold text-brand hover:bg-surface-2"
              >
                <Icon name="plus" size={13} />
                Crear tercero «{termino}»
              </button>
              <button
                type="button"
                onClick={() => elegir({ id: null, name: termino })}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-text-secondary hover:bg-surface-2"
              >
                <Icon name="pencil" size={13} />
                Usar «{termino}» sin registrarlo
              </button>
            </div>
          )}

          {/* Alta del tercero que falta, sin salir del movimiento: nombre y
              documento. El documento es OBLIGATORIO —sin él el directorio se
              vuelve a llenar de repetidos— y por eso el alta es un formulario:
              quien no lo tenga a mano se va por «Sin registrarlo». */}
          {alta && (
            <div className="sticky bottom-0 space-y-2 border-t border-border-subtle bg-surface p-3">
              <p className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">Nuevo tercero</p>
              <Input
                autoFocus
                placeholder="Nombre o razón social"
                value={alta.name}
                onChange={(e) => setAlta({ ...alta, name: e.target.value })}
              />
              <Input
                placeholder="NIT o cédula *"
                value={alta.nit}
                onChange={(e) => setAlta({ ...alta, nit: e.target.value })}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void crearTercero(); } }}
              />
              <p className="text-[11px] text-text-tertiary">
                El documento es obligatorio: es lo que evita tener al mismo tercero repetido. Si ya existe
                alguien con ese documento o ese nombre, se usa el que hay. ¿No lo tienes a mano? Pulsa
                «Sin registrarlo» y el movimiento queda con el nombre escrito.
              </p>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => elegir({ id: null, name: alta.name.trim() || termino })}
                  className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-2"
                >
                  Sin registrarlo
                </button>
                <button
                  type="button"
                  onClick={() => setAlta(null)}
                  className="rounded-md px-2.5 py-1.5 text-[12px] font-medium text-text-secondary hover:bg-surface-2"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={crearTercero}
                  disabled={creando || !alta.name.trim() || alta.nit.trim().length < 5}
                  className="rounded-md bg-brand px-2.5 py-1.5 text-[12px] font-semibold text-on-brand hover:opacity-90 disabled:opacity-60"
                >
                  {creando ? "Guardando…" : "Guardar tercero"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
