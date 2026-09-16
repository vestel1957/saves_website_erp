"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { ConceptoPicker } from "@/components/billing/ConceptoPicker";
import { DireccionFields, DIRECCION_VACIA, NOM_KEYS, ZONA_KEYS, direccionArmada, type DireccionValor } from "@/components/subscribers/DireccionFields";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

type Item = { productName?: string; productId?: number; description: string; qty: number; price: number; taxRate: number };

/**
 * POR QUÉ se factura. Lo sirve el backend (`/billing/motivos`) con el concepto y el
 * precio de HOY de cada motivo: escribir aquí «Traslado 30.000» es garantizar que el
 * día que suba de precio la pantalla siga diciendo lo viejo.
 */
type Motivo = {
  clave: string;
  etiqueta: string;
  ayuda: string;
  kind: Kind;
  /** El tipo de orden que se abre sola al pagarse esta factura (null = ninguna). */
  abreOrden: string | null;
  /** Pide la dirección nueva del cliente (hoy, solo el traslado). */
  pideDestino: boolean;
  producto: { name: string; productId: number; price: number; taxRate: number } | null;
};

/**
 * Tipo de factura: el `tipo_factura` del legacy (select "Factura" de `newinvoice.php`).
 *
 * Allá el select también listaba Nota Crédito y Nota Débito para roleid > 3; aquí no
 * van: una nota cuelga de una factura existente y se emite desde la factura
 * (Facturación ▸ Notas), no se crea suelta.
 */
type Kind = "FIJA" | "RECURRENTE";
const KINDS: { value: Kind; label: string; hint: string }[] = [
  { value: "FIJA", label: "Fija", hint: "Cargo puntual: instalación, reconexión, traslado, venta de equipo." },
  { value: "RECURRENTE", label: "Recurrente", hint: "Mensualidad del servicio: lleva periodo y sale por mes en el recibo de caja." },
];

const today = () => new Date().toISOString().slice(0, 10);
const emptyItem = (): Item => ({ description: "", qty: 1, price: 0, taxRate: 0 });

/**
 * Creación manual de una factura (o clonando la última del cliente). Reemplaza
 * la antigua vista `/facturacion/nueva`: se abre como modal desde el botón
 * "Nueva factura" de Administrar facturas.
 */
export function NuevaFacturaModal({
  open,
  onClose,
  onDone,
  fixedSub,
}: {
  open: boolean;
  onClose: () => void;
  /** Se llama tras crear con éxito para refrescar el listado. */
  onDone?: () => void;
  /**
   * Cliente ya decidido: se abre desde SU ficha, así que el selector sobra —y peor,
   * dejarlo abierto invita a facturarle al cliente equivocado teniendo el correcto
   * en pantalla. Con esto el modal enseña a quién se le factura y no deja cambiarlo.
   */
  fixedSub?: PickedSub;
}) {
  const { authFetch } = useAuth();
  const router = useRouter();
  const [sub, setSub] = useState<PickedSub | null>(fixedSub ?? null);
  const [items, setItems] = useState<Item[]>([emptyItem()]);
  const [invoiceDate, setInvoiceDate] = useState(today());
  const [kind, setKind] = useState<Kind>("FIJA");
  const [notes, setNotes] = useState("");
  /**
   * El MOTIVO: por qué se emite esta factura. Arranca vacío a propósito —«Fija» no
   * dice nada, y elegirlo es lo que permite ver después de qué era la factura— y hay
   * uno que además dispara trabajo: el traslado abre su orden al pagarse.
   */
  const [motivo, setMotivo] = useState("");
  const [motivos, setMotivos] = useState<Motivo[]>([]);
  /**
   * ¿El motivo lo eligió una persona? Mientras no, lo deduce el concepto de la línea
   * (ver `elegirConcepto`). En cuanto alguien toca el desplegable —aunque sea para
   * dejarlo en «Sin especificar»— el automático se calla y no vuelve a pisarlo.
   */
  const [motivoTocado, setMotivoTocado] = useState(false);
  /**
   * A dónde se muda el cliente, cuando la factura es de traslado. La ZONA se precarga
   * con la que tiene hoy (mudarse de barrio es lo raro) y la vía se deja en blanco a
   * propósito: es una dirección nueva, y arrancar con la vieja escrita es la forma de
   * que alguien la deje igual sin darse cuenta.
   */
  const [dir, setDir] = useState<DireccionValor>(DIRECCION_VACIA);
  /** La que tiene hoy, para enseñarla al lado y para no repetirla. */
  const [dirActual, setDirActual] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const motivoActual = useMemo(() => motivos.find((m) => m.clave === motivo) ?? null, [motivos, motivo]);
  /** La factura de traslado es la que pide dirección y la que deja orden programada. */
  const pideDestino = !!motivoActual?.pideDestino;
  const direccionNueva = useMemo(() => (pideDestino ? direccionArmada(dir) : ""), [pideDestino, dir]);
  /**
   * La dirección escrita es la que el cliente ya tiene. NO frena la factura (decisión del
   * usuario, 2026-09-08: «puede que vaya para el segundo piso»); solo se dice, por si de
   * verdad fue un error de dedo, y se recuerda dónde se escribe el piso para que la ficha
   * quede distinguiendo los dos sitios.
   */
  const mismaDireccion =
    !!dirActual && !!direccionNueva && direccionNueva.toLowerCase() === dirActual.toLowerCase();

  // Reset al cerrar para que la próxima apertura arranque limpia.
  useEffect(() => {
    if (open) return;
    setSub(fixedSub ?? null);
    setItems([emptyItem()]);
    setInvoiceDate(today());
    setKind("FIJA");
    setNotes("");
    setMotivo("");
    setMotivoTocado(false);
    setDir(DIRECCION_VACIA);
    setDirActual(null);
    setSaving(false);
    setErr(null);
  }, [open, fixedSub]);

  // Los motivos y su precio de hoy, una vez al abrir.
  useEffect(() => {
    if (!open) return;
    void authFetch("/billing/motivos")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setMotivos(Array.isArray(d) ? (d as Motivo[]) : []))
      .catch(() => {});
  }, [open, authFetch]);

  // La zona y la dirección de hoy, solo cuando hace falta: es una consulta más y la
  // mayoría de las facturas no son traslados.
  useEffect(() => {
    if (!pideDestino || !sub) return;
    let vivo = true;
    void authFetch(`/subscribers/${sub.id}/form`)
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((d) => {
        if (!vivo) return;
        const nom = (d.nomenclature ?? {}) as Record<string, unknown>;
        const str = (v: unknown) => (v == null ? "" : String(v));
        setDir((p) => ({ ...p, ...Object.fromEntries(ZONA_KEYS.map((k) => [k, str(d[k])])) }));
        setDirActual(direccionArmada({
          ...Object.fromEntries(NOM_KEYS.map((k) => [k, str(nom[k])])),
          addressLine: str(d.addressLine),
        }) || null);
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, [pideDestino, sub, authFetch]);

  /**
   * Elegir el motivo pone el tipo de factura que le corresponde y propone su
   * concepto: la cajera que va a cobrar un traslado no tiene que buscar «Traslado» a
   * mano en el catálogo (ni acabar cobrando otra cosa parecida). Solo se pisa la
   * línea si está vacía o si la había puesto otro motivo: lo escrito a conciencia no
   * se toca.
   */
  function elegirMotivo(clave: string) {
    setMotivo(clave);
    setMotivoTocado(true);
    const m = motivos.find((x) => x.clave === clave);
    if (!m) return;
    setKind(m.kind);
    if (!m.producto) return;
    setItems((prev) => {
      const sueltos = prev.filter((it) => it.description.trim());
      const propuestos = new Set(motivos.map((x) => x.producto?.name).filter(Boolean) as string[]);
      const propia = sueltos.length === 1 && propuestos.has(sueltos[0].description.trim());
      if (sueltos.length && !propia) return prev;
      return [{
        description: m.producto!.name, productName: m.producto!.name, productId: m.producto!.productId,
        qty: 1, price: m.producto!.price, taxRate: m.producto!.taxRate,
      }];
    });
  }

  /**
   * EL CAMINO INVERSO: elegir el concepto «Traslado» elige el motivo Traslado.
   *
   * `elegirMotivo` (arriba) va de motivo a concepto, pero en la ventanilla se piensa
   * al revés —"le cobro el traslado"— y se busca «Traslado» en el catálogo de la
   * línea sin mirar el desplegable de la derecha. Esa factura salía sin motivo: sin
   * la casilla de la dirección nueva y, sobre todo, sin abrir la orden de traslado al
   * pagarse, que es justo lo que se quería. Ahora el concepto lo deduce.
   *
   * Solo mientras nadie haya tocado el desplegable a mano, y NUNCA toca los ítems: el
   * concepto ya lo acaba de elegir la persona, faltaba el rótulo.
   */
  function elegirConcepto(i: number, p: { name: string; productId: number; price: number; taxRate: number }) {
    setItem(i, { description: p.name, productName: p.name, productId: p.productId, price: p.price, taxRate: p.taxRate });
    if (motivoTocado || motivo) return;
    const m = motivos.find((x) => x.producto?.productId === p.productId);
    if (!m) return;
    setMotivo(m.clave);
    setKind(m.kind);
  }

  /**
   * La línea cobra algo que tiene motivo propio y la factura salió sin él: pasa
   * cuando alguien vacía el desplegable a conciencia. No se bloquea —hay casos
   * legítimos, como refacturar un traslado ya hecho—, pero se dice qué se pierde.
   */
  const motivoDeLaLinea = useMemo(() => {
    if (motivo) return null;
    const ids = new Set(items.map((it) => it.productId).filter((v): v is number => v != null));
    return motivos.find((m) => m.producto && ids.has(m.producto.productId) && (m.pideDestino || m.abreOrden)) ?? null;
  }, [items, motivo, motivos]);

  const totals = useMemo(() => {
    let subtotal = 0, tax = 0;
    for (const it of items) {
      const s = (Number(it.qty) || 0) * (Number(it.price) || 0);
      subtotal += s; tax += (s * (Number(it.taxRate) || 0)) / 100;
    }
    return { subtotal: Math.round(subtotal), tax: Math.round(tax), total: Math.round(subtotal + tax) };
  }, [items]);

  function setItem(i: number, patch: Partial<Item>) {
    setItems((prev) => prev.map((it, idx) => (idx === i ? { ...it, ...patch } : it)));
  }

  async function cloneLast() {
    if (!sub) return;
    const r = await authFetch(`/billing/subscribers/${sub.id}/last-invoice`);
    const d = await r.json();
    if (!d.found || !d.items.length) { toast("El cliente no tiene factura previa para clonar", "info"); return; }
    setItems(d.items.map((x: any) => ({ productName: x.productName, productId: x.productId, description: x.description, qty: x.qty, price: x.price, taxRate: x.taxRate })));
    toast("Ítems clonados de la última factura");
  }

  async function submit() {
    setErr(null);
    if (!sub) { setErr("Selecciona un cliente."); return; }
    const clean = items.filter((it) => it.description.trim());
    if (!clean.length) { setErr("Agrega al menos un ítem con descripción."); return; }
    // El precio y el IVA ya no se escriben: los pone el producto. Una línea escrita a
    // mano se quedaría en $ 0, así que se bloquea aquí en vez de dejar salir una
    // factura en cero que después hay que anular.
    if (clean.some((it) => !it.productId && !(Number(it.price) > 0))) {
      setErr("Elige cada concepto del catálogo: el precio y el IVA los pone el producto.");
      return;
    }
    // El traslado necesita saber a dónde va el cliente: de esta dirección sale la
    // orden que se abre al pagarse la factura, y el día del pago ya no hay nadie
    // delante a quien preguntarle.
    if (pideDestino && !direccionNueva) {
      setErr("Escribe la dirección a la que se muda el cliente."); return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`/billing/invoices`, {
        method: "POST",
        body: JSON.stringify({
          subscriberId: sub.id, invoiceDate, kind, notes: notes || undefined, items: clean,
          purpose: motivo || undefined,
          moveTo: pideDestino
            ? {
                nomenclature: Object.fromEntries(NOM_KEYS.map((k) => [k, dir[k] || null])),
                ...Object.fromEntries(ZONA_KEYS.filter((k) => dir[k]).map((k) => [k, dir[k]])),
                ...(dir.addressLine ? { addressLine: dir.addressLine } : {}),
              }
            : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo crear la factura");
      toast(`Factura #${data.tid} creada · ${cop(data.total)}`);
      // Y si la factura lleva trabajo detrás, se dice: cobrarla no es el final del
      // asunto — al pagarse nace la orden y la ficha del cliente se muda con ella.
      if (data?.ordenAlPagar?.mensaje) toast(data.ordenAlPagar.mensaje, "info");
      onDone?.();
      router.push(`/facturacion/${data.id}`);
    } catch (e) { setErr(mensajeDeError(e)); setSaving(false); }
  }

  return (
    // max-w-5xl: con 4xl la columna de descripción se queda sin aire y trunca el
    // concepto elegido, que es justo lo que hay que revisar antes de crear.
    <Modal open={open} onClose={onClose} title="Nueva factura" maxWidth="max-w-5xl">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
          {/* Cliente */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[13px] font-bold text-text-primary">Cliente</span>
              {sub && <Button variant="secondary" size="sm" onClick={cloneLast}><Icon name="copy" size={13} /> Clonar última factura</Button>}
            </div>
            {fixedSub ? (
              <div className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2/50 px-3 py-2 text-[13px]">
                <Icon name="user" size={14} className="text-text-tertiary" />
                <span className="font-semibold text-text-primary">{fixedSub.name}</span>
                <span className="font-mono text-text-tertiary">#{fixedSub.abonado}</span>
              </div>
            ) : (
              <SubscriberPicker value={sub} onChange={setSub} />
            )}
          </div>

          {/* Ítems */}
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="mb-2 text-[13px] font-bold text-text-primary">Ítems</div>
            <p className="mb-2 text-[11px] text-text-tertiary">
              El precio y el IVA los pone el producto: elige el concepto del catálogo.
            </p>
            <div className="flex flex-col gap-2">
              <div className="hidden grid-cols-[1fr_70px_110px_60px_110px_32px] gap-2 px-1 text-[11px] font-semibold text-text-tertiary sm:grid">
                <span>Descripción</span><span className="text-right">Cant.</span><span className="text-right">Precio</span><span className="text-right">IVA</span><span className="text-right">Subtotal</span><span />
              </div>
              {items.map((it, i) => {
                const sub2 = (Number(it.qty) || 0) * (Number(it.price) || 0);
                // Sin producto y sin precio la línea no se puede facturar: se marca en
                // el acto, no al pulsar "Crear factura".
                const sinPrecio = !!it.description.trim() && !it.productId && !(Number(it.price) > 0);
                return (
                  <div key={i} className="grid grid-cols-2 gap-2 sm:grid-cols-[1fr_70px_110px_60px_110px_32px]">
                    <ConceptoPicker
                      className="col-span-2 sm:col-span-1"
                      value={it.description}
                      // Elegir del catálogo trae el precio y el IVA vigentes. Escribir a
                      // mano solo sirve para buscar: la línea queda sin producto y sin
                      // precio, porque ese par ya no se digita.
                      onPick={(p) => elegirConcepto(i, p)}
                      onText={(t) => setItem(i, { description: t, productName: undefined, productId: undefined, price: 0, taxRate: 0 })}
                    />
                    <Input type="number" min={0} className="text-right" value={it.qty} onChange={(e) => setItem(i, { qty: Number(e.target.value) })} />
                    <div className={`flex items-center justify-end text-[12px] ${sinPrecio ? "text-error-text" : "font-medium text-text-secondary"}`}>
                      {sinPrecio ? "Elige del catálogo" : cop(it.price)}
                    </div>
                    <div className="flex items-center justify-end text-[12px] text-text-tertiary">
                      {it.taxRate > 0 ? `${it.taxRate}%` : "—"}
                    </div>
                    <div className="flex items-center justify-end text-[12px] font-medium text-text-secondary">{cop(sub2)}</div>
                    <button type="button" onClick={() => setItems((p) => p.filter((_, idx) => idx !== i))} disabled={items.length === 1}
                      className="flex items-center justify-center rounded-md text-text-tertiary hover:text-error-text disabled:opacity-30"><Icon name="x" size={16} /></button>
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => setItems((p) => [...p, emptyItem()])} className="mt-3 inline-flex items-center gap-1 text-[12px] font-semibold text-brand hover:underline">
              <Icon name="plus" size={14} /> Agregar ítem
            </button>
          </div>

          {/* TRASLADO: a dónde se muda. La ficha del cliente NO se toca ahora — se
              muda cuando pague, que es cuando nace la orden. Una dirección cambiada
              por una factura que después se anula dejaría al cliente viviendo en una
              casa a la que no se mudó. */}
          {pideDestino && (
            <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <span className="text-[13px] font-bold text-text-primary">Nueva dirección del cliente</span>
                <span className="inline-flex items-center gap-1 text-[12px] text-text-secondary">
                  <Icon name="clipboard-list" size={13} className="text-text-tertiary" />
                  Al pagarse esta factura se abre sola la orden de traslado
                </span>
              </div>
              {dirActual && (
                <p className="mb-2 text-[12px] text-text-tertiary">
                  Hoy vive en <span className="text-text-secondary">{dirActual}</span>. La ficha queda con la dirección nueva cuando pague.
                </p>
              )}
              {!sub && <p className="mb-2 text-[12px] text-text-tertiary">Elige primero el cliente para traer su zona.</p>}
              <DireccionFields value={dir} onChange={(patch) => setDir((p) => ({ ...p, ...patch }))} comercial={false} />
              <p className="mt-2 text-[12px] text-text-secondary">
                Se muda a: <b className="text-text-primary">{direccionNueva || "— escribe la vía y su número —"}</b>
              </p>
              {mismaDireccion && (
                <p className="mt-1 text-[12px] text-text-tertiary">
                  Es la misma dirección que ya tiene. La factura se emite igual —mudarse dentro del mismo
                  inmueble es un traslado—; si cambia de piso o de apartamento, dilo en «Torre / piso»
                  o «Apto / casa» y la ficha lo recoge.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Resumen */}
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="mb-2 text-[13px] font-bold text-text-primary">Datos</div>
            <div className="flex flex-col gap-2">
              {/* POR QUÉ se factura. Va ARRIBA del tipo porque es lo que de verdad se
                  elige: el tipo (fija/recurrente) lo pone solo el motivo. */}
              <Field label="Motivo de la factura" hint={motivoActual?.ayuda ?? "Para qué se le cobra. Queda escrito en la factura."}>
                <Select value={motivo} onChange={(e) => elegirMotivo(e.target.value)}>
                  <option value="">— Sin especificar —</option>
                  {motivos.map((m) => <option key={m.clave} value={m.clave}>{m.etiqueta}</option>)}
                </Select>
              </Field>
              {motivoDeLaLinea && (
                <p className="rounded-lg bg-warning-surface px-2.5 py-2 text-[12px] text-warning-text">
                  Esta factura cobra «{motivoDeLaLinea.producto?.name}» y va sin motivo: no
                  {motivoDeLaLinea.pideDestino ? " pedirá la dirección nueva ni" : ""} abrirá sola la
                  orden de {motivoDeLaLinea.abreOrden?.toLowerCase() ?? "trabajo"} al pagarse.{" "}
                  <button type="button" onClick={() => elegirMotivo(motivoDeLaLinea.clave)} className="font-semibold underline">
                    Marcarla como {motivoDeLaLinea.etiqueta.toLowerCase()}
                  </button>
                </p>
              )}
              <Field label="Tipo de factura" hint={KINDS.find((k) => k.value === kind)?.hint}>
                <Select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                  {KINDS.map((k) => <option key={k.value} value={k.value}>{k.label}</option>)}
                </Select>
              </Field>
              {/* El vencimiento ya no se elige: lo pone el día de corte configurado
                  (`billing.dueDay`), igual para todas las facturas. */}
              <Field label="Fecha factura" hint="El vencimiento lo pone el día de corte configurado">
                <Input type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
              </Field>
              <Field label="Nota"><Input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Opcional" /></Field>
            </div>
          </div>
          <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
            <div className="flex flex-col gap-1.5 text-[13px]">
              <div className="flex justify-between"><span className="text-text-tertiary">Subtotal</span><span className="font-medium">{cop(totals.subtotal)}</span></div>
              <div className="flex justify-between"><span className="text-text-tertiary">IVA</span><span className="font-medium">{cop(totals.tax)}</span></div>
              <div className="mt-1 flex justify-between border-t border-border-subtle pt-2 text-[15px]"><span className="font-bold text-text-primary">Total</span><span className="font-bold text-brand">{cop(totals.total)}</span></div>
            </div>
          </div>
          {err && <p className="text-[12px] text-error-text">{err}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancelar</Button>
            <Button onClick={submit} disabled={saving || !sub}>{saving ? "Creando…" : "Crear factura"}</Button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
