"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { type CashAccount, PAY_METHODS, BANKS, isBankMethod } from "@/lib/cobranzas";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { BeneficiarioPicker, type Beneficiario } from "@/components/cobranzas/BeneficiarioPicker";
import { mensajeDeError } from "@/lib/errores";
import { useMiCaja } from "@/lib/useMiCaja";
import { ACCEPT_IMAGEN_PDF } from "@/lib/adjuntos";
import { useValidacion, requerido, monto, minimo, cuando } from "@/lib/useValidacion";

const today = () => new Date().toISOString().slice(0, 10);

type TxType = "Income" | "Expense";

/** A quién se le entrega el egreso. Son excluyentes: la plata se le da a UNO. */
type Destino = "proveedor" | "cliente" | "otro";

/**
 * Nueva transacción — porta el formulario `transactions/add` del legacy: UN solo
 * formulario con selector Ingreso/Egreso, no un menú de opciones.
 *
 * Es un asiento libre de tesorería: NO aplica el dinero a facturas (en el legacy
 * eso también es un flujo aparte). Para aplicar un pago a la cartera de un cliente
 * está "Registrar recaudo", en Ingresos, Inicio y la ficha del cliente.
 */
export default function NuevaTransaccionPage() {
  const router = useRouter();
  const { loading: authLoading, authFetch, can } = useAuth();
  // Quien está acotado (la cajera) escribe en SU caja y no puede elegir otra ni
  // dejarla en blanco: un movimiento sin caja no aparecería en su cierre.
  const { bloqueada, acotado, sinCaja } = useMiCaja();

  const [type, setType] = useState<TxType>("Income");
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [method, setMethod] = useState("Cash");
  const [bank, setBank] = useState(BANKS[0]);
  const [cashAccountId, setCashAccountId] = useState("");
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [payerName, setPayerName] = useState("");
  // Egresos: a quién se le paga sale del directorio (proveedores y terceros).
  const [beneficiario, setBeneficiario] = useState<Beneficiario | null>(null);
  // …salvo cuando la plata vuelve a un CLIENTE (devolución: pagó de más, se le
  // cobró algo que no era, se retira con saldo a favor). Es un egreso normal de
  // caja, solo cambia a quién se le entrega, así que se elige explícitamente en
  // vez de dejar los dos selectores a la vez y que nadie sepa cuál manda.
  //
  // Y la tercera: NO REGISTRADO. El directorio no cubre el pago suelto (un
  // domicilio, un arreglo, el señor que vino a pintar) y sin esta salida el
  // egreso simplemente no se podía registrar. Es una pestaña y no un rincón del
  // desplegable para que se VEA que se puede escribir a mano.
  const [destino, setDestino] = useState<Destino>("proveedor");
  const [otroNombre, setOtroNombre] = useState("");
  // Al escribir uno nuevo se ofrece dejarlo en el directorio: la próxima vez ya
  // sale en la lista y el egreso queda ligado a él (estado de cuenta que cuadra).
  // La CAJERA también puede: es quien más egresos de ventanilla registra y sin
  // esto el pago suelto se quedaba con el nombre a secas y el directorio nunca
  // aprendía. Lo suyo entra siempre como TERCERO (el backend se lo fija); dar de
  // alta un PROVEEDOR sigue siendo de contabilidad, en su pantalla.
  const [guardarOtro, setGuardarOtro] = useState(true);
  // NIT o cédula de ese tercero. OBLIGATORIO para dejarlo en el directorio: es lo
  // único que distingue de verdad a dos personas con el mismo nombre, y sin él el
  // directorio se vuelve a llenar de repetidos. Quien no lo tenga a mano no queda
  // bloqueado: desmarca «guardarlo en el directorio» y el egreso se registra como
  // pago suelto, con el nombre escrito.
  const [otroDoc, setOtroDoc] = useState("");
  const puedeGuardarEnDirectorio = can(["area.contabilidad", "area.administracion", "area.caja"]);
  // Para no pisarle la categoría a quien ya la eligió a mano.
  const [catTocada, setCatTocada] = useState(false);
  const [date, setDate] = useState(today());
  const [note, setNote] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (authLoading) return;
    void authFetch("/treasury/cash-accounts").then((r) => (r.ok ? r.json() : [])).then(setAccounts).catch(() => {});
    void authFetch("/treasury/categories")
      .then((r) => (r.ok ? r.json() : []))
      .then((rows: { name: string }[]) => setCategories(rows.map((c) => c.name)))
      .catch(() => {});
  }, [authLoading, authFetch]);

  // A la cajera se le fija la suya; al resto se le propone la primera de la lista.
  useEffect(() => {
    if (bloqueada) { setCashAccountId(String(bloqueada.id)); return; }
    if (accounts.length && !cashAccountId) setCashAccountId(String(accounts[0].id));
  }, [accounts, cashAccountId, bloqueada]);
  useEffect(() => { if (categories.length && !category) setCategory(categories[0]); }, [categories, category]);

  // Lo que antes se comprobaba de golpe al pulsar Guardar (y se avisaba con un
  // renglón rojo al pie, lejos del campo) se comprueba ahora campo por campo: el
  // aviso sale bajo el que falta, al salir de él o al intentar guardar.
  //
  // `type`, `destino` y `guardarOtro` viajan en los valores porque las reglas
  // condicionales los leen: el cliente sólo es obligatorio en una devolución y el
  // documento sólo si el tercero se va a guardar en el directorio.
  const v = useValidacion(
    { amount, category, sub, otroNombre, otroDoc, type, destino, guardarOtro, puedeGuardarEnDirectorio },
    {
      amount: [requerido("Escribe el monto."), monto("El monto debe ser mayor que cero.")],
      // Sin categoría el movimiento quedaría fuera de los reportes, que agrupan por ella.
      category: requerido("Elige una categoría: los reportes agrupan por ella."),
      // Elegir "Cliente" y no decir cuál dejaría un egreso sin destinatario ninguno.
      sub: cuando(
        (f) => f.type === "Expense" && f.destino === "cliente",
        requerido("Elige el cliente al que se le devuelve el dinero."),
      ),
      otroNombre: cuando(
        (f) => f.type === "Expense" && f.destino === "otro",
        requerido("Escribe a quién se le paga."),
      ),
      // Guardarlo en el directorio exige documento; el pago suelto (sin guardar) no.
      otroDoc: [
        cuando(
          (f) => f.type === "Expense" && f.destino === "otro" && f.guardarOtro && f.puedeGuardarEnDirectorio,
          requerido("Escribe el NIT o la cédula del tercero. Si no lo tienes, desmarca «guardarlo en el directorio»."),
        ),
        cuando(
          (f) => f.type === "Expense" && f.destino === "otro" && f.guardarOtro && f.puedeGuardarEnDirectorio,
          minimo(5, "El documento se ve incompleto: escribe el NIT o la cédula completos."),
        ),
      ],
    },
  );

  const submit = useCallback(async () => {
    setErr(null);
    if (!v.revisar()) return;
    const amt = Number(amount) || 0;
    setSaving(true);
    try {
      const body: any = {
        amount: amt, category, method, date,
        cashAccountId: cashAccountId ? Number(cashAccountId) : undefined,
        accountName: accounts.find((a) => String(a.id) === cashAccountId)?.name,
        bankName: isBankMethod(method) ? bank : undefined,
        note: note.trim() || undefined,
      };
      if (type === "Income") {
        // Paridad legacy (`payer_id` + `payer_name`): si se eligió cliente manda su
        // id y su nombre; si no, vale el texto libre para quien no es cliente.
        body.subscriberId = sub?.id;
        body.payerName = sub?.name ?? (payerName.trim() || undefined);
      } else if (destino === "cliente") {
        // Devolución: viaja el id del cliente. El backend lo liga al movimiento
        // (queda en su historial) pero NO le mueve la cartera —el egreso nace
        // `ext: true`—, así que devolver plata no le genera deuda al cliente.
        body.subscriberId = sub?.id;
      } else if (destino === "otro") {
        const nombre = otroNombre.trim();
        // Se intenta dar de alta ANTES de crear el egreso para poder ligarlo por
        // id. El alta es idempotente por nombre (el backend devuelve el que ya
        // existe), así que reescribir un tercero que ya estaba no lo duplica.
        let supplierId: string | undefined;
        if (guardarOtro && puedeGuardarEnDirectorio) {
          try {
            const r = await authFetch("/treasury/beneficiaries", {
              method: "POST",
              body: JSON.stringify({ name: nombre, category: 3, nit: otroDoc.trim() }),
            });
            const d = await r.json();
            if (r.ok && d?.id) supplierId = d.id;
            else toast("No se pudo guardar en el directorio; el egreso se registra con el nombre escrito", "alert-triangle");
          } catch {
            toast("No se pudo guardar en el directorio; el egreso se registra con el nombre escrito", "alert-triangle");
          }
        }
        // Con id manda el directorio (el nombre lo pone el servidor); si no, viaja
        // el texto tal cual, que es el pago suelto de toda la vida.
        if (supplierId) body.supplierId = supplierId;
        else body.payerName = nombre;
      } else {
        // El egreso se le paga a un proveedor o tercero del directorio: viaja el id
        // y el nombre lo pone el servidor. Sólo cae a texto libre en el pago suelto.
        body.supplierId = beneficiario?.id ?? undefined;
        body.payerName = beneficiario && !beneficiario.id ? beneficiario.name : undefined;
      }
      const url = type === "Income" ? "/treasury/income" : "/treasury/expenses";
      const res = await authFetch(url, { method: "POST", body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo registrar el movimiento");

      // El comprobante se adjunta al movimiento ya creado (necesita su id).
      if (file && data?.id) {
        const fd = new FormData();
        fd.append("file", file);
        const up = await authFetch(`/treasury/transactions/${data.id}/attach`, { method: "POST", body: fd });
        if (!up.ok) toast("Movimiento guardado, pero el comprobante no se pudo subir", "alert-triangle");
      }
      toast(`${type === "Income" ? "Ingreso" : "Egreso"} registrado: ${cop(amt)}`, "check");
      router.push(type === "Income" ? "/tesoreria/ingresos" : "/tesoreria/egresos");
    } catch (e) {
      setErr(mensajeDeError(e, "No se pudo registrar el movimiento"));
    } finally {
      setSaving(false);
    }
  }, [v, amount, category, method, date, cashAccountId, accounts, bank, sub, payerName, beneficiario, destino,
      otroNombre, otroDoc, guardarOtro, puedeGuardarEnDirectorio, note, type, file, authFetch, router]);

  const esIngreso = type === "Income";
  const montoNum = Number(amount) || 0;
  const cuentaNombre = bloqueada?.name ?? accounts.find((a) => String(a.id) === cashAccountId)?.name;
  const metodoLabel = PAY_METHODS.find((m) => m.value === method)?.label ?? method;
  const quienLabel = esIngreso
    ? (sub?.name ?? (payerName.trim() || null))
    : destino === "cliente"
      ? (sub?.name ?? null)
      : destino === "otro"
        ? (otroNombre.trim() || null)
        : (beneficiario?.name ?? null);
  const quienTitulo = esIngreso
    ? "Pagador"
    : destino === "cliente" ? "Cliente" : destino === "otro" ? "Se le paga a" : "Proveedor";

  return (
    <>
      <PageHeading icon="plus" title="Nueva transacción" subtitle="Registra un ingreso o un egreso de caja" />

      {sinCaja && (
        <div className="mb-3 flex items-start gap-2 rounded-xl border border-warning-subtle bg-warning-soft px-3.5 py-3 text-[13px] text-warning-text">
          <Icon name="alert-triangle" size={16} className="mt-0.5 shrink-0" />
          <span>No tienes una caja asignada, así que no puedes registrar movimientos. Pídele a administración que te asigne la de tu sede.</span>
        </div>
      )}

      {/* Formulario ancho a la izquierda + resumen sticky a la derecha: aprovecha el
          espacio horizontal y deja el monto y los botones siempre a la vista. */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_320px] xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="rounded-2xl border border-border-subtle bg-surface p-5 shadow-sm sm:p-6">
          {/* Tipo: es lo que decide todo lo demás, así que va primero y bien visible. */}
          <div className="mb-5">
            <span className="mb-1.5 block text-[11px] font-semibold text-text-tertiary">Tipo de movimiento *</span>
            <div className="inline-flex w-full max-w-sm rounded-lg border border-border-default p-0.5">
              {([
                { v: "Income", label: "Ingreso", icon: "trending-up" },
                { v: "Expense", label: "Egreso", icon: "trending-down" },
              ] as const).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  // Al cambiar de tipo se suelta a QUIÉN entero: los campos de la
                  // otra cara desaparecen de la pantalla y no puede quedarse nadie
                  // pegado al movimiento sin que se vea.
                  onClick={() => {
                    setType(o.v);
                    setSub(null); setPayerName(""); setBeneficiario(null);
                    setDestino("proveedor"); setOtroNombre(""); setOtroDoc("");
                  }}
                  className={`inline-flex flex-1 items-center justify-center gap-1.5 rounded-md px-4 py-2 text-[13px] font-semibold transition-colors ${
                    type === o.v ? "bg-brand text-on-brand" : "text-text-secondary hover:bg-surface-2"
                  }`}
                >
                  <Icon name={o.icon} size={15} />
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* QUIÉN va justo detrás del tipo de movimiento: es la segunda decisión
                de quien registra ("un ingreso… ¿de quién?"), y además manda sobre
                el resto —elegir cliente esconde el pagador/beneficiario suelto—.
                Estaba al final, después del método y la caja. */}
            {/* En el EGRESO se le paga a un proveedor o tercero del directorio, que
                es el caso de todos los días; y aparte está la DEVOLUCIÓN a un
                cliente, para cuando hay que regresarle su plata. Son excluyentes:
                el movimiento se le entrega a UNO. */}
            {esIngreso && (
              <>
                <div className="sm:col-span-2">
                  <Field label="Cliente" hint="Opcional. Liga el ingreso a un cliente y le abona saldo a favor.">
                    <SubscriberPicker value={sub} onChange={setSub} />
                  </Field>
                </div>
                {!sub && (
                  <div className="sm:col-span-2">
                    <Field label="Pagador" hint="Para quien no es cliente.">
                      <Input value={payerName} onChange={(e) => setPayerName(e.target.value)} placeholder="Quién paga" />
                    </Field>
                  </div>
                )}
              </>
            )}
            {!esIngreso && (
              <>
                <div className="sm:col-span-2">
                  <span className="mb-1.5 block text-[11px] font-semibold text-text-tertiary">¿A quién se le paga? *</span>
                  <div className="grid w-full grid-cols-1 gap-0.5 rounded-lg border border-border-default p-0.5 sm:max-w-2xl sm:grid-cols-3">
                    {([
                      { v: "proveedor", label: "Del directorio", icon: "briefcase" },
                      { v: "otro", label: "No registrado", icon: "pencil" },
                      { v: "cliente", label: "Cliente (devolución)", icon: "user" },
                    ] as const).map((o) => (
                      <button
                        key={o.v}
                        type="button"
                        onClick={() => {
                          setDestino(o.v);
                          // Se sueltan los otros dos para que no viaje un
                          // destinatario invisible en el cuerpo del POST.
                          if (o.v === "cliente") {
                            setBeneficiario(null); setOtroNombre(""); setOtroDoc("");
                            // Cortesía: la devolución tiene su propia categoría y es
                            // la que va a querer el 99% de las veces. Solo se propone
                            // si nadie ha tocado el selector.
                            if (!catTocada && categories.includes("Devoluciones")) setCategory("Devoluciones");
                          } else if (o.v === "otro") {
                            setSub(null); setBeneficiario(null);
                          } else {
                            setSub(null); setOtroNombre(""); setOtroDoc("");
                          }
                        }}
                        className={`inline-flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[13px] font-semibold transition-colors ${
                          destino === o.v ? "bg-brand text-on-brand" : "text-text-secondary hover:bg-surface-2"
                        }`}
                      >
                        <Icon name={o.icon} size={15} />
                        {o.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="sm:col-span-2">
                  {destino === "cliente" ? (
                    <Field label="Cliente" required error={v.error("sub")} hint="A quién se le devuelve la plata. Queda en su historial; no le mueve la cartera ni le genera deuda.">
                      <SubscriberPicker value={sub} onChange={setSub} />
                    </Field>
                  ) : destino === "otro" ? (
                    <>
                    <Field
                      label="Nombre de quien recibe"
                      required
                      error={v.error("otroNombre")}
                      hint="Para el pago suelto a alguien que no está en el directorio."
                    >
                      <Input
                        value={otroNombre}
                        onChange={(e) => setOtroNombre(e.target.value)}
                        placeholder="Ej.: Ferretería La 20, Juan Pérez…"
                        {...v.campo("otroNombre")}
                      />
                    </Field>
                      {/* El documento sólo tiene dónde guardarse si el tercero
                          entra al directorio: el pago suelto no lo lleva (el
                          movimiento sólo guarda el nombre escrito). */}
                      {puedeGuardarEnDirectorio && guardarOtro && (
                        <div className="mt-2">
                          <span className="mb-1.5 block text-[11px] font-semibold text-text-tertiary">
                            NIT o cédula *
                          </span>
                          <Input
                            value={otroDoc}
                            onChange={(e) => setOtroDoc(e.target.value)}
                            placeholder="Ej.: 900123456-7, 1098765432"
                            inputMode="text"
                            aria-invalid={v.error("otroDoc") ? true : undefined}
                            {...v.campo("otroDoc")}
                          />
                          {v.error("otroDoc") && (
                            <span className="mt-1 block text-[11px] text-error-text">{v.error("otroDoc")}</span>
                          )}
                          <span className="mt-1 block text-[11px] text-text-tertiary">
                            Obligatorio para dejarlo en el directorio: es lo que evita tenerlo repetido. Si ya hay
                            alguien con ese documento, el egreso se le liga a él. ¿No lo tienes? Desmarca la casilla
                            de abajo y el egreso queda con el nombre escrito.
                          </span>
                        </div>
                      )}
                      {puedeGuardarEnDirectorio && (
                        <label className="mt-2 flex cursor-pointer items-start gap-2 text-[12px] text-text-secondary">
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-brand"
                            checked={guardarOtro}
                            onChange={(e) => setGuardarOtro(e.target.checked)}
                          />
                          <span>
                            Guardarlo en el directorio para la próxima vez
                            <span className="block text-[11px] text-text-tertiary">
                              Entra como tercero con su documento: la próxima vez sale en la lista y el egreso
                              queda ligado a él. Si ya existe con ese documento o ese nombre, se usa el que hay
                              (no se duplica).
                            </span>
                          </span>
                        </label>
                      )}
                    </>
                  ) : (
                    <Field label="Proveedor o tercero" hint="Se elige del directorio. Si no está, usa «No registrado».">
                      <BeneficiarioPicker value={beneficiario} onChange={setBeneficiario} />
                    </Field>
                  )}
                </div>
              </>
            )}

            <Field label="Monto" required error={v.error("amount")}>
              <Input type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" autoFocus {...v.campo("amount")} />
            </Field>
            <Field label="Fecha" required>
              <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            </Field>

            <Field label="Categoría" required error={v.error("category")} hint={categories.length ? undefined : "Se administran en Cajas y categorías"}>
              <Select value={category} onChange={(e) => { setCategory(e.target.value); setCatTocada(true); }} disabled={!categories.length} {...v.campo("category")}>
                {!categories.length && <option value="">Cargando…</option>}
                {categories.map((c) => <option key={c} value={c}>{c}</option>)}
              </Select>
            </Field>
            <Field
              label="Caja / cuenta"
              required={acotado}
              hint={bloqueada ? "Tu caja asignada. El movimiento entra en tu cierre." : undefined}
            >
              <Select
                value={cashAccountId}
                onChange={(e) => setCashAccountId(e.target.value)}
                disabled={!!bloqueada}
              >
                {/* "Sin caja" sólo para quien no está acotado: a la cajera le dejaría
                    el movimiento fuera de su propio arqueo. */}
                {!acotado && <option value="">— Sin caja —</option>}
                {bloqueada
                  ? <option value={bloqueada.id}>{bloqueada.name}</option>
                  : accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </Select>
            </Field>

            <Field label="Método" hint={acotado ? "La caja solo maneja efectivo" : undefined}>
              {/* "Saldo a favor" solo aplica al pagar facturas, no a un asiento libre.
                  La cajera solo administra EFECTIVO: consignaciones y cheques los
                  registra contabilidad (el backend lo vuelve a imponer). */}
              <Select value={method} onChange={(e) => setMethod(e.target.value)} disabled={acotado}>
                {PAY_METHODS.filter((m) => m.value !== "Balance")
                  .filter((m) => !acotado || m.value === "Cash")
                  .map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </Select>
            </Field>
            {isBankMethod(method) ? (
              <Field label="Banco">
                <Select value={bank} onChange={(e) => setBank(e.target.value)}>
                  {BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
                </Select>
              </Field>
            ) : <div className="hidden sm:block" />}

            <div className="sm:col-span-2">
              <Field label="Nota">
                <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
              </Field>
            </div>

            <div className="sm:col-span-2">
              <Field label="Comprobante (opcional)" hint="Foto o PDF de la factura, recibo o soporte.">
                <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-border-subtle bg-surface-2 px-3 py-1.5 text-[12px] font-medium text-text-secondary hover:border-brand hover:text-text-primary">
                  <Icon name="upload" size={14} /> {file ? "Cambiar archivo" : "Adjuntar comprobante"}
                  <input type="file" accept={ACCEPT_IMAGEN_PDF} className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </label>
                {file && (
                  <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-text-tertiary">
                    <Icon name="file-text" size={12} /> {file.name}
                    <button type="button" onClick={() => setFile(null)} className="text-error-text hover:underline"><Icon name="x" size={12} /></button>
                  </span>
                )}
              </Field>
            </div>
          </div>
        </div>

        {/* Resumen sticky: espejo en vivo de lo que se va a registrar + acciones. */}
        <aside className="lg:sticky lg:top-4 lg:self-start">
          <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface shadow-sm">
            <div className={`px-5 py-4 ${esIngreso ? "bg-success-soft" : "bg-error-soft"}`}>
              <span className={`inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide ${esIngreso ? "text-success-text" : "text-error-text"}`}>
                <Icon name={esIngreso ? "trending-up" : "trending-down"} size={13} />
                {esIngreso ? "Ingreso" : "Egreso"}
              </span>
              <div className={`mt-1 text-3xl font-bold tabular-nums ${esIngreso ? "text-success-text" : "text-error-text"}`}>
                {esIngreso ? "+" : "−"} {cop(montoNum)}
              </div>
            </div>

            <dl className="divide-y divide-border-subtle px-5 text-[13px]">
              {[
                { k: "Categoría", v: category || "—" },
                { k: "Caja / cuenta", v: cuentaNombre || "Sin caja" },
                { k: "Método", v: isBankMethod(method) ? `${metodoLabel} · ${bank}` : metodoLabel },
                { k: quienTitulo, v: quienLabel || "—" },
                { k: "Fecha", v: date },
              ].map((r) => (
                <div key={r.k} className="flex items-center justify-between gap-3 py-2.5">
                  <dt className="text-text-tertiary">{r.k}</dt>
                  <dd className="truncate text-right font-medium text-text-primary">{r.v}</dd>
                </div>
              ))}
            </dl>

            <div className="border-t border-border-subtle p-4">
              {err && <p className="mb-3 text-[12px] text-error-text">{err}</p>}
              <div className="flex flex-col gap-2">
                <Button variant="primary" onClick={submit} disabled={saving} className="w-full justify-center">
                  <Icon name="check" size={15} />
                  {saving ? "Guardando…" : `Registrar ${esIngreso ? "ingreso" : "egreso"}`}
                </Button>
                <Button variant="secondary" onClick={() => router.push("/tesoreria")} disabled={saving} className="w-full justify-center">
                  <Icon name="x" size={15} /> Cancelar
                </Button>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </>
  );
}
