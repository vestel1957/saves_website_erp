"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { listaJson, mensajeDeError } from "@/lib/errores";
import { NapPortPicker, type NapPort } from "./NapPortPicker";

const INSTALL_TYPES = ["FTTH", "EOC", "HFC", "Radioenlace", "Otro"];

type StockEq = {
  id: string; code: number; mac: string | null; serial: string | null;
  brand: string | null; installType: string | null; warehouse: string | null;
  /** Ya está apartado para este cliente: es el que hay que entregarle. */
  reservado?: boolean;
};

/** Un equipo elegido. `uid` es sólo para React: no viaja al backend. */
type Eq = {
  uid: number;
  /** La unidad de inventario, o null si se registra a mano (equipo que no está en el stock). */
  stock: StockEq | null;
  mac: string; installType: string; serial: string;
  /** Caja NAP y puerto donde queda colgado, elegidos por rótulo y número. */
  caja: NapPort | null;
  vlan: string; master: string;
  meters: string; accessories: string;
};

let contador = 0;

const deStock = (s: StockEq): Eq => ({
  uid: ++contador, stock: s,
  mac: s.mac || "", installType: s.installType || INSTALL_TYPES[0], serial: s.serial || "",
  caja: null, vlan: "", master: "", meters: "", accessories: "",
});

const aMano = (): Eq => ({
  uid: ++contador, stock: null,
  mac: "", installType: INSTALL_TYPES[0], serial: "",
  caja: null, vlan: "", master: "", meters: "", accessories: "",
});

const rotulo = (s: StockEq) => [s.mac, s.serial, s.brand, s.warehouse].filter(Boolean).join(" · ");

/**
 * Modal para asignar equipos (CPE) al cliente desde la orden o desde su ficha.
 *
 * ES UN BUSCADOR, no un formulario (2026-09-05). Antes cada equipo abría una
 * tarjeta con MAC, tipo, puerto y caja NAT, VLAN, master, metros de cable y
 * accesorios —y la mitad marcados como obligatorios—, cuando lo que hace quien
 * entrega la caja es leer el CÓDIGO del rótulo y darla. Ahora se teclea el código
 * (o la MAC, o el serial), se pulsa la unidad y ya: la MAC, el serial y el tipo
 * salen del inventario. Todo lo demás vive plegado en «Datos de instalación» de
 * cada equipo elegido, y nada de eso es obligatorio: el backend sólo exige MAC y
 * tipo, así que exigir puerto y caja NAT era invento nuestro.
 *
 * Ahí dentro está también la CAJA NAP y el PUERTO donde queda colgado el equipo
 * (2026-09-09): ya no como dos casillas numéricas —lo que pedían eran los ids
 * internos del legacy, que nadie sabe— sino eligiendo la caja por su rótulo y el
 * puerto en una rejilla que enseña cuáles están libres. Ver `NapPortPicker`.
 *
 * Se pueden entregar varios de una —una instalación deja ONT y decodificador el
 * mismo día—: cada pulsación suma uno a la lista de arriba. Todo viaja en un envío
 * (`items`) y el backend lo escribe en una transacción: si el segundo choca, no
 * queda el primero asignado a medias.
 */
export function AsignarEquipoModal({
  open, onClose, onDone, ticketId, subscriberId,
}: {
  open: boolean; onClose: () => void; onDone: () => void;
  /** Desde la ORDEN: la entrega queda anotada en su hilo. */
  ticketId?: string;
  /** Desde la FICHA del cliente: el servidor busca su orden abierta para la nota. */
  subscriberId?: string;
}) {
  const { authFetch } = useAuth();
  const [busca, setBusca] = useState("");
  const [stock, setStock] = useState<StockEq[]>([]);
  const [cargando, setCargando] = useState(false);
  const [elegidos, setElegidos] = useState<Eq[]>([]);
  /** Qué equipo elegido tiene abierto su bloque de datos de instalación. */
  const [abierto, setAbierto] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** La unidad apartada se pre-elige UNA vez por apertura, no en cada búsqueda. */
  const autoHecho = useRef(false);

  useEffect(() => {
    if (!open) return;
    setBusca(""); setElegidos([]); setAbierto(0); setErr(null);
    autoHecho.current = false;
  }, [open]);

  // La búsqueda es del SERVIDOR: el inventario son miles de unidades y la lista que
  // llega son 30. Filtrar en el navegador sólo buscaría dentro de esas 30 y el código
  // tecleado —que es el caso normal— no aparecería casi nunca.
  useEffect(() => {
    if (!open) return;
    const q = busca.trim();
    const t = setTimeout(() => {
      const p = new URLSearchParams();
      if (q) p.set("search", q);
      if (subscriberId) p.set("subscriberId", subscriberId);
      setCargando(true);
      void authFetch(`/support/equipment/available?${p.toString()}`)
        .then(listaJson)
        .then((l) => setStock(l as StockEq[]))
        .catch(() => setStock([]))
        .finally(() => setCargando(false));
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [open, busca, authFetch, subscriberId]);

  // La apartada para este cliente entra ya elegida: es la que hay que entregar, y
  // hacer que la cajera la busque a mano es la forma de que acabe dando otra.
  useEffect(() => {
    if (!open || autoHecho.current) return;
    const reservada = stock.find((s) => s.reservado);
    if (!reservada) return;
    autoHecho.current = true;
    setElegidos((prev) => (prev.length ? prev : [deStock(reservada)]));
  }, [open, stock]);

  const yaElegido = useMemo(
    () => new Set(elegidos.map((e) => e.stock?.id).filter(Boolean) as string[]),
    [elegidos],
  );

  const set = (uid: number, campo: keyof Eq, valor: string) =>
    setElegidos((prev) => prev.map((e) => (e.uid === uid ? { ...e, [campo]: valor } : e)));

  const alternar = (s: StockEq) => {
    setErr(null);
    setElegidos((prev) => {
      const fuera = prev.filter((e) => e.stock?.id !== s.id);
      if (fuera.length !== prev.length) return fuera;
      const nuevo = deStock(s);
      // Sin MAC en el inventario hay que teclearla (el backend la exige): se abre.
      if (!nuevo.mac) setAbierto(nuevo.uid);
      return [...prev, nuevo];
    });
  };

  const añadirManual = () => {
    const nuevo = aMano();
    setElegidos((prev) => [...prev, nuevo]);
    setAbierto(nuevo.uid);
    setErr(null);
  };

  const quitar = (uid: number) => setElegidos((prev) => prev.filter((e) => e.uid !== uid));

  /** Devuelve el problema de un equipo, o null si se puede entregar. */
  const problema = (e: Eq): string | null => (e.mac.trim() ? null : "falta la MAC");

  async function submit() {
    setErr(null);
    if (!elegidos.length) { setErr("Busca el equipo por su código y elígelo."); return; }
    for (const e of elegidos) {
      const p = problema(e);
      if (p) {
        setAbierto(e.uid);
        setErr(e.stock ? `Al equipo ${e.stock.code} le ${p} en el inventario: escríbela.` : `Al equipo nuevo le ${p}.`);
        return;
      }
    }
    const macs = elegidos.map((e) => e.mac.trim().toLowerCase());
    const repetida = macs.find((m, i) => macs.indexOf(m) !== i);
    if (repetida) { setErr(`La MAC ${repetida.toUpperCase()} está dos veces en la lista.`); return; }

    setSaving(true);
    try {
      const items = elegidos.map((e) => {
        const it: Record<string, unknown> = {
          mac: e.mac.trim(), installType: e.installType,
          equipmentId: e.stock?.id || undefined,
          serial: e.serial.trim() || undefined,
          master: e.master.trim() || undefined,
          accessories: e.accessories.trim() || undefined,
        };
        // La caja y el puerto viajan como ids de aquí: el servidor los traduce a lo
        // que guarda el legacy (`nat` = id de la NAP, `puerto` = id de la fila del
        // puerto), que es justo lo que nadie podía teclear a mano.
        if (e.caja) { it.napId = e.caja.napId; it.portId = e.caja.portId; }
        if (e.vlan.trim()) it.vlan = Number(e.vlan);
        if (e.meters.trim()) it.meters = Number(e.meters);
        return it;
      });
      const ruta = ticketId ? `/support/tickets/${ticketId}/equipment` : `/support/subscribers/${subscriberId}/equipment`;
      const res = await authFetch(ruta, { method: "POST", body: JSON.stringify({ items }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo asignar el equipo");
      toast(items.length > 1 ? `${d.total ?? items.length} equipos asignados` : `Equipo ${d.mac} asignado`);
      onDone(); onClose();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal
      open={open} onClose={onClose} maxWidth="max-w-2xl"
      title={elegidos.length > 1 ? `Asignar equipos (${elegidos.length})` : "Asignar equipo"}
    >
      <div className="flex flex-col gap-3">
        {/* Lo elegido, arriba: es lo que se va a entregar */}
        {elegidos.map((e) => {
          const expandido = abierto === e.uid;
          const isFTTH = e.installType === "FTTH";
          const isEOC = e.installType === "EOC";
          const faltaMac = !e.mac.trim();
          return (
            <div
              key={e.uid}
              className={`rounded-xl border bg-surface ${faltaMac ? "border-warning-border" : "border-border-default"}`}
            >
              <div className="flex items-center gap-2 px-3 py-2">
                <Icon name="package-check" size={16} className="shrink-0 text-success-text" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-semibold text-text-primary">
                    {e.stock ? `Cód. ${e.stock.code}` : "Equipo nuevo"}
                    {e.mac.trim() ? <span className="font-mono font-normal text-text-secondary"> · {e.mac.trim().toUpperCase()}</span> : null}
                  </span>
                  <span className="block truncate text-[11px] text-text-tertiary">
                    {faltaMac
                      ? "Sin MAC en el inventario: escríbela abajo"
                      : [
                          e.installType,
                          e.caja ? `NAP ${e.caja.napName} · pto ${e.caja.portNumber}` : "",
                          e.serial.trim(), e.stock?.brand, e.stock?.warehouse,
                        ].filter(Boolean).join(" · ")}
                  </span>
                </span>
                <button
                  type="button" onClick={() => setAbierto(expandido ? 0 : e.uid)}
                  aria-expanded={expandido}
                  className="shrink-0 rounded-lg px-2 py-1 text-[11px] text-text-secondary hover:bg-surface-2"
                >
                  <span className="hidden sm:inline">Datos de instalación </span>
                  <Icon name={expandido ? "chevron-down" : "chevron-right"} size={12} className="inline" />
                </button>
                <button
                  type="button" onClick={() => quitar(e.uid)} title="Quitar este equipo"
                  className="shrink-0 rounded-lg p-1.5 text-text-tertiary hover:bg-surface-2 hover:text-error-text"
                >
                  <Icon name="x" size={14} />
                </button>
              </div>

              {expandido && (
                <div className="grid grid-cols-1 gap-3 border-t border-border-subtle px-3 py-3 sm:grid-cols-2">
                  <Field label="MAC" required={!e.stock || faltaMac}>
                    <Input value={e.mac} onChange={(ev) => set(e.uid, "mac", ev.target.value)} placeholder="AA:BB:CC:DD:EE:FF" className="font-mono" />
                  </Field>
                  <Field label="Tipo de instalación">
                    <Select value={e.installType} onChange={(ev) => set(e.uid, "installType", ev.target.value)}>
                      {INSTALL_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </Select>
                  </Field>
                  <Field label="Serial"><Input value={e.serial} onChange={(ev) => set(e.uid, "serial", ev.target.value)} className="font-mono" /></Field>
                  {isEOC && <Field label="Master"><Input value={e.master} onChange={(ev) => set(e.uid, "master", ev.target.value)} /></Field>}
                  {isFTTH && (
                    <div className="sm:col-span-2">
                      <Field label="Caja NAP y puerto">
                        <NapPortPicker
                          subscriberId={subscriberId}
                          value={e.caja}
                          onChange={(v) => setElegidos((prev) => prev.map((x) => (x.uid === e.uid ? { ...x, caja: v } : x)))}
                        />
                      </Field>
                    </div>
                  )}
                  {isFTTH && <Field label="VLAN"><Input value={e.vlan} onChange={(ev) => set(e.uid, "vlan", ev.target.value)} inputMode="numeric" placeholder="La de la caja" /></Field>}
                  <Field label="Metros de cable"><Input value={e.meters} onChange={(ev) => set(e.uid, "meters", ev.target.value)} inputMode="numeric" /></Field>
                  <Field label="Accesorios"><Input value={e.accessories} onChange={(ev) => set(e.uid, "accessories", ev.target.value)} placeholder="Conectores, rosetas…" /></Field>
                </div>
              )}
            </div>
          );
        })}

        {/* El buscador: código, MAC o serial */}
        <div className="relative">
          <Icon name="search" size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary" />
          <Input
            autoFocus value={busca} onChange={(ev) => setBusca(ev.target.value)}
            placeholder="Busca por código, MAC o serial…" className="pl-9"
          />
        </div>

        <div className="max-h-72 overflow-y-auto rounded-xl border border-border-subtle">
          {stock.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-text-tertiary">
              {cargando ? "Buscando…" : busca.trim() ? "Ningún equipo disponible con ese código." : "No hay equipos disponibles."}
            </p>
          ) : (
            <ul className="divide-y divide-border-subtle">
              {stock.map((s) => {
                const puesto = yaElegido.has(s.id);
                return (
                  <li key={s.id}>
                    <button
                      type="button" onClick={() => alternar(s)}
                      className={`flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ${puesto ? "bg-brand-soft" : "hover:bg-surface-2"}`}
                    >
                      <span className="w-16 shrink-0 font-mono text-[13px] font-semibold text-text-primary">{s.code}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[12px] text-text-secondary">{rotulo(s) || "Sin MAC ni serial"}</span>
                        {s.reservado && (
                          <span className="block text-[11px] font-medium text-brand">★ Apartado para este cliente</span>
                        )}
                      </span>
                      <Icon
                        name={puesto ? "check" : "plus"} size={14}
                        className={`shrink-0 ${puesto ? "text-success-text" : "text-text-tertiary"}`}
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <button
            type="button" onClick={añadirManual} disabled={saving}
            className="text-[12px] text-text-secondary underline underline-offset-2 hover:text-text-primary"
          >
            El equipo no está en el inventario: registrarlo por su MAC
          </button>
        </div>

        {err && <p className="text-[12px] text-error-text">{err}</p>}

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={saving || elegidos.length === 0}>
            {saving ? "Asignando…" : elegidos.length > 1 ? `Asignar ${elegidos.length} equipos` : "Asignar equipo"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
