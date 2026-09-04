"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import {
  type Debt, type DebtInvoice, type CashAccount, PAY_METHODS, BANKS, isBankMethod, previewCascade,
} from "@/lib/cobranzas";
import { mensajeDeError } from "@/lib/errores";
import { descargarPdf, imprimirPdf, nombreDelPdf } from "@/lib/imprimir";
import { useMiCaja } from "@/lib/useMiCaja";

/** Orden de servicio que el sistema deja abierta por lo que no se pudo reconectar. */
type OrdenPendiente = {
  id: string;
  code: number | null;
  type: string;
  nueva: boolean;
  servicio: "INTERNET" | "TV";
};

/** Lo que responde el backend sobre la reconexión automática tras el pago. */
type Reconexion = {
  aplica: boolean;
  ok: boolean;
  enCurso: boolean;
  dryRun: boolean;
  servicios: {
    servicio: "INTERNET" | "TV"; ok: boolean; via: string | null; detalle: string;
    orden?: OrdenPendiente | null;
  }[];
  /** Lo que no volvió por red y quedó como trabajo para un técnico. */
  ordenes?: OrdenPendiente[];
  /** Constancia de lo que SÍ volvió: órdenes que nacen y se cierran solas. */
  registros?: OrdenPendiente[];
  /**
   * Los días del mes que nadie había facturado, cobrados al devolver el servicio
   * (las órdenes "…2" del legacy). La cajera tiene que verlo: el cliente acaba de
   * pagar y se va con un renglón nuevo en su cuenta, y pregunta.
   */
  cobro?: {
    aplica: boolean; cobrado: boolean; dias: number; total: number;
    invoiceTid?: number; facturaNueva?: boolean; mensaje: string;
  } | null;
  mensaje: string;
};

const NOMBRE_SERVICIO: Record<string, string> = { INTERNET: "internet", TV: "televisión" };

/** "internet y televisión" / "televisión" — para contarle a la cajera qué volvió. */
const listar = (nombres: string[]) =>
  nombres.length > 1 ? `${nombres.slice(0, -1).join(", ")} y ${nombres[nombres.length - 1]}` : (nombres[0] ?? "");

export function RegistrarPagoModal({
  subscriberId, open, onClose, onDone,
}: {
  subscriberId: string;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const { authFetch, isSuperadmin } = useAuth();
  // La cajera recauda SIEMPRE contra su caja (el backend además lo impone con 403).
  // El selector de caja sólo lo ve el superusuario: al resto se le muestra la suya y
  // el servidor la resuelve solo, para que nadie mande un recaudo a otro cajón.
  const { mi } = useMiCaja();
  const [debt, setDebt] = useState<Debt | null>(null);
  const [accounts, setAccounts] = useState<CashAccount[]>([]);
  const [amount, setAmount] = useState<string>("");
  const [method, setMethod] = useState("Cash");
  const [bank, setBank] = useState(BANKS[0]);
  const [cashAccountId, setCashAccountId] = useState<string>("");
  /** Facturas marcadas para pagar (ids). El pago se aplica SOLO sobre estas. */
  const [elegidas, setElegidas] = useState<string[]>([]);
  const [note, setNote] = useState("");
  /**
   * ¿Se le devuelve el servicio al cobrar? Por defecto SÍ: el cliente que paga se
   * pone al día y vuelve a navegar. Se apaga para el que llega a saldar y RETIRARSE:
   * antes el recaudo lo reconectaba igual y quedaba activo sin haberlo pedido.
   */
  const [reconectar, setReconectar] = useState(true);
  /**
   * "Pagar también el mes siguiente": el cliente deja cubierto un mes que todavía no
   * se ha facturado y por adelantarlo se le rebaja un % (lo dice el backend). El monto
   * se re-cuadra solo — la cajera no tiene que sumar nada de cabeza.
   */
  const [adelantar, setAdelantar] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** Pago aplicado pero el servicio NO volvió: se muestra en vez del formulario. */
  const [fallo, setFallo] = useState<Reconexion | null>(null);
  /** Recibo listo que el navegador no dejó abrir: se ofrece como botón. */
  const [reciboUrl, setReciboUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDebt(null); setErr(null); setFallo(null); setReciboUrl(null); setAmount(""); setNote(""); setMethod("Cash");
    setElegidas([]); setReconectar(true); setAdelantar(false);
    void authFetch(`/treasury/subscribers/${subscriberId}/debt`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("No se pudo cargar la deuda"))))
      .then((d: Debt) => {
        setDebt(d);
        // Se abre con TODAS marcadas: es el caso normal (el cliente se pone al día) y
        // deja el monto ya cuadrado con la deuda. Desmarcar es un clic.
        setElegidas(d.invoices.map((i) => i.id));
        // Se propone lo que hay que COBRAR, no lo que se debe: con el descuento de la
        // promoción la caja recibe el valor rebajado, y proponer el total le dejaba al
        // cliente la diferencia como saldo a favor en vez de como descuento.
        const aCobrar = d.totalConDescuento ?? d.totalDebt;
        setAmount(aCobrar > 0 ? String(aCobrar) : "");
      })
      .catch((e) => setErr(mensajeDeError(e)));
    // El listado de cajas sólo hace falta para el selector del superusuario.
    if (!isSuperadmin) return;
    void authFetch(`/treasury/cash-accounts`)
      .then((r) => (r.ok ? r.json() : []))
      .then((a: CashAccount[]) => {
        setAccounts(a);
        setCashAccountId((prev) => prev || (a.length ? String(a[0].id) : ""));
      })
      .catch(() => {});
  }, [open, subscriberId, authFetch, isSuperadmin]);

  // Su caja manda sobre "la primera de la lista": ordenada alfabéticamente, la
  // primera puede ser un banco, y el recaudo se le iría fuera del cajón. Va en su
  // propio efecto porque `mi` llega por otra petición: metido en el de arriba,
  // volvería a cargar la deuda al llegar y borraría lo que ya se hubiera marcado.
  useEffect(() => {
    if (!open || !isSuperadmin || !mi?.caja) return;
    setCashAccountId(String(mi.caja.id));
  }, [open, isSuperadmin, mi]);

  const amountNum = Number(amount) || 0;
  /**
   * Cliente al día: no hay ninguna factura que cubrir. No es un callejón sin salida —
   * el pago se le recibe igual y queda como saldo a favor, que se aplica solo cuando
   * nazca la factura del mes siguiente. Es el caso del que viene a dejar pagado el mes
   * que viene antes de la corrida del día 1.
   */
  const sinFacturas = !!debt && debt.invoices.length === 0;
  /** Las facturas marcadas, en el orden en que se listan (más antigua primero). */
  const seleccionadas = useMemo<DebtInvoice[]>(
    () => (debt ? debt.invoices.filter((i) => elegidas.includes(i.id)) : []),
    [debt, elegidas],
  );
  /** Lo que hay que cobrar por lo marcado: el saldo menos el descuento que se gana. */
  const deudaElegida = useMemo(
    () => Math.round(seleccionadas.reduce((s, i) => s + i.balance - (i.descuento ?? 0), 0) * 100) / 100,
    [seleccionadas],
  );
  /**
   * El mes que se puede adelantar y lo que cuesta. Sólo se ofrece cuando el pago deja
   * al cliente EN CERO —todas las facturas marcadas, o ninguna pendiente—: si le queda
   * deuda, esa deuda se comería el adelanto (el backend lo rechaza por lo mismo).
   */
  const adelanto = debt?.adelanto ?? null;
  const todasMarcadas = !!debt && debt.invoices.length > 0 && elegidas.length === debt.invoices.length;
  const puedeAdelantar = !!adelanto && adelanto.meses.length > 0 && (sinFacturas || todasMarcadas);
  const netoAdelanto = puedeAdelantar && adelantar ? (adelanto?.neto ?? 0) : 0;
  const preview = useMemo(
    () => previewCascade(seleccionadas, amountNum - netoAdelanto),
    [seleccionadas, amountNum, netoAdelanto],
  );
  const totalPreview = preview.reduce((s, p) => s + p.applied, 0);
  /** Lo que el cliente se ahorra con este pago (las facturas que quedan saldadas). */
  const descuentoPreview = preview.reduce((s, p) => s + p.descuento, 0);
  const excedente = Math.max(0, Math.round((amountNum - deudaElegida - netoAdelanto) * 100) / 100);

  /**
   * Lo que hay que cobrar por las facturas `ids` (ya con su descuento) más, si se
   * pidió, el mes que se adelanta. Es la única cuenta del formulario: la escriben la
   * casilla "Todas", el marcado de cada factura y la de adelantar, para que las tres
   * no se contradigan.
   */
  function montoCuadrado(ids: string[], conAdelanto: boolean): string {
    const deuda = (debt?.invoices ?? [])
      .filter((i) => ids.includes(i.id))
      .reduce((s, i) => s + i.balance - (i.descuento ?? 0), 0);
    const total = Math.round((deuda + (conAdelanto ? (adelanto?.neto ?? 0) : 0)) * 100) / 100;
    return total > 0 ? String(total) : "";
  }

  /**
   * Marcar/desmarcar una factura. El monto se re-cuadra con lo elegido: quien marca
   * facturas espera ver el total de ESAS facturas, no el que quedó de la selección
   * anterior. Si necesita abonar menos, reescribe el monto después.
   *
   * Desmarcar una apaga el adelanto: adelantar sólo se ofrece al que queda en cero, y
   * dejar la casilla puesta mandaría un recaudo que el backend rechaza.
   */
  function alternar(id: string) {
    const next = elegidas.includes(id) ? elegidas.filter((x) => x !== id) : [...elegidas, id];
    const sigueAdelantando = adelantar && next.length === (debt?.invoices.length ?? 0);
    setElegidas(next);
    setAdelantar(sigueAdelantando);
    setAmount(montoCuadrado(next, sigueAdelantando));
  }

  /**
   * Monto, método, banco, caja y nota. Va en una función porque el formulario es el
   * mismo con facturas pendientes y sin ellas (ahí el recaudo entra entero como saldo
   * a favor): duplicarlo era la vía segura para que los dos se fueran separando.
   */
  function camposDePago(hintMonto: string) {
    // "Balance" paga una factura CON el saldo a favor que el cliente ya tiene. Sin
    // factura no hay nada que pagar con él, así que no se ofrece (el backend además
    // lo rechaza).
    const metodos = sinFacturas ? PAY_METHODS.filter((m) => m.value !== "Balance") : PAY_METHODS;
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Monto a recaudar" required hint={hintMonto}>
          <Input type="number" min={0} inputMode="numeric" value={amount}
            onChange={(e) => setAmount(e.target.value)} placeholder="0" autoFocus />
        </Field>
        <Field label="Método de pago" required>
          <Select value={method} onChange={(e) => setMethod(e.target.value)}>
            {metodos.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
          </Select>
        </Field>
        {isBankMethod(method) && (
          <Field label="Banco">
            <Select value={bank} onChange={(e) => setBank(e.target.value)}>
              {BANKS.map((b) => <option key={b} value={b}>{b}</option>)}
            </Select>
          </Field>
        )}
        {/* La caja NO se elige: el recaudo entra en la de quien lo registra y
            el servidor la resuelve. Sólo el superusuario puede mandarlo a
            otra —él sí administra todas las cajas—. */}
        {isSuperadmin && (
          <Field label="Caja / cuenta" hint="Sólo tú ves este selector.">
            <Select value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)}>
              <option value="">— Sin caja —</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
        )}
        <Field label="Nota (opcional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Referencia…" />
        </Field>
      </div>
    );
  }

  /**
   * La casilla de adelantar. Es la misma con facturas pendientes y sin ellas, así que
   * se arma una vez: el cliente al día que viene a dejar pagado el mes que viene es
   * exactamente el mismo caso que el que se pone al día y de paso adelanta.
   */
  const bloqueAdelanto = puedeAdelantar && adelanto && (
    <label
      className={`flex cursor-pointer items-start gap-2 rounded-lg border p-3 text-[12px] ${
        adelantar ? "border-brand bg-surface-2" : "border-border-subtle bg-surface"
      }`}
    >
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-brand"
        checked={adelantar}
        onChange={(e) => {
          const v = e.target.checked;
          setAdelantar(v);
          setAmount(montoCuadrado(elegidas, v));
        }}
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-1.5 font-semibold text-text-primary">
          <Icon name="calendar-plus" size={14} className="text-text-tertiary" />
          Pagar también {listar(adelanto.meses.map((m) => m.label))} por adelantado
          {adelanto.pct > 0 && <Badge label={`−${adelanto.pct}% por adelantar`} tone="success" />}
        </span>
        <span className="block text-[11px] text-text-tertiary">
          {adelanto.pct > 0 ? (
            <>
              {cop(adelanto.bruto)} − {cop(adelanto.descuento)} de descuento ={" "}
              <b className="text-text-primary">{cop(adelanto.neto)}</b>, que se suman al monto.
            </>
          ) : (
            <><b className="text-text-primary">{cop(adelanto.neto)}</b> que se suman al monto.</>
          )}{" "}
          Esa factura todavía no existe: nace el día 1 ya pagada y el mes sale en el recibo.
        </span>
      </span>
    </label>
  );

  /** En qué caja cae el recaudo. La cajera no elige, así que se le dice. */
  const avisoCaja = !isSuperadmin && (
    <p className="flex items-center gap-1.5 text-[11px] text-text-tertiary">
      <Icon name="wallet" size={13} />
      {mi?.caja
        ? <>El recaudo entra en tu caja <span className="font-semibold text-text-secondary">{mi.caja.name}</span> con la fecha de hoy.</>
        : <>El recaudo entra en la caja que tengas asignada, con la fecha de hoy.</>}
    </p>
  );

  /**
   * Entrega el recibo de caja: lo GUARDA y lo manda a la impresora.
   *
   * Antes esto era un `window.open` envuelto en un `catch {}` vacío: si el navegador
   * bloqueaba la pestaña —lo hace siempre, porque la llamada ocurre después de un
   * `await`— la cajera cobraba y no salía ningún papel, sin ningún aviso. Ahora se
   * imprime desde un iframe oculto y, si algo falla, se DICE.
   *
   * El PDF se descarga ADEMÁS de imprimirse, y en ese orden: el papel de 80 mm es del
   * cliente y se lo lleva, así que del cobro no quedaba ningún archivo de este lado.
   * Guardar primero es a propósito — `print()` abre un diálogo que retiene el hilo
   * hasta que alguien lo atiende, y si el recibo se guardara después, un diálogo
   * cancelado o cerrado se llevaría por delante la copia.
   */
  async function imprimirRecibo(receiptId?: string | null): Promise<boolean> {
    if (!receiptId) {
      toast("El pago quedó registrado pero no se generó el recibo: imprímelo desde la factura.", "alert-circle");
      return true;
    }
    try {
      const pdf = await authFetch(`/treasury/receipts/${receiptId}/pdf`);
      if (!pdf.ok) {
        toast("El pago quedó registrado, pero el recibo no se pudo generar.", "alert-circle");
        return true;
      }
      const blob = await pdf.blob();
      // El nombre lo pone el propio recibo (`recibo-<consecutivo>.pdf`): es el número
      // por el que se busca cuando el cliente vuelve a reclamar, no el id interno.
      descargarPdf(blob, nombreDelPdf(pdf, `recibo-${receiptId}.pdf`));
      const r = await imprimirPdf(blob);
      if (r.ok) return true;
      // Última salida: el navegador bloqueó todo. El enlace queda a un clic, que sí
      // cuenta como gesto del usuario y nunca se bloquea — y el modal se queda
      // abierto para que ese botón exista.
      setReciboUrl(r.url);
      toast("El recibo está listo: el navegador bloqueó la ventana, ábrelo con el botón.", "alert-circle");
      return false;
    } catch {
      toast("El pago quedó registrado, pero el recibo no se pudo imprimir.", "alert-circle");
      return true;
    }
  }

  async function submit() {
    setErr(null);
    // Sin facturas pendientes el recaudo entra ENTERO como saldo a favor: no hay nada
    // que marcar, así que la exigencia de marcar una factura no aplica.
    if (!sinFacturas && !seleccionadas.length) { setErr("Marca al menos una factura a pagar."); return; }
    if (amountNum <= 0) { setErr("Ingresa un monto mayor a cero."); return; }
    if (method === "Balance" && amountNum > (debt?.balance ?? 0)) {
      setErr("El saldo a favor del cliente no alcanza para ese monto."); return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`/treasury/collect`, {
        method: "POST",
        body: JSON.stringify({
          subscriberId, amount: amountNum, method,
          // Sólo el superusuario elige caja; para el resto la pone el servidor (la
          // suya). La fecha tampoco se manda: el pago se registra con el día en que
          // se registra, no con uno escrito a mano.
          cashAccountId: isSuperadmin && cashAccountId ? Number(cashAccountId) : undefined,
          accountName: isSuperadmin ? accounts.find((a) => String(a.id) === cashAccountId)?.name : undefined,
          bankName: isBankMethod(method) ? bank : undefined,
          invoiceIds: elegidas.length ? seleccionadas.map((i) => i.id) : undefined,
          note: note || undefined,
          // Opt-in explícito: el backend sólo acepta un recaudo sin factura pendiente
          // si se le pide que lo deje como saldo a favor.
          comoAnticipo: sinFacturas ? true : undefined,
          // Sólo CUÁNTOS meses: el precio y el descuento los pone el servidor, que
          // los recalcula y rechaza el recaudo si el monto no da.
          adelantarMeses: adelantar && puedeAdelantar ? adelanto.meses.length : undefined,
          // Sólo se manda cuando se pide NO reconectar: el silencio significa
          // "reconecta", que es lo de siempre.
          reconectar: reconectar ? undefined : false,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "No se pudo registrar el pago");
      /** ['septiembre'] → "septiembre"; ['septiembre','octubre'] → "septiembre y octubre". */
      const mesesPagados: string[] = data.advanceMonths ?? [];
      toast(
        sinFacturas
          ? `Recaudo registrado: ${cop(data.advance ?? amountNum)}`
            + (mesesPagados.length ? ` · queda pagado ${listar(mesesPagados)}` : " como saldo a favor")
          : `Recaudo registrado: ${cop(data.totalApplied)} (${data.applied.length} factura(s))`,
      );
      // El cliente llega creyendo que debe el valor con descuento; si la promoción
      // ya venció, el sistema se lo retiró al cobrar y hay que poder explicárselo
      // en el acto, no cuando reclame.
      // Excedente: el cliente pagó por adelantado. Se dice en el acto porque es lo que
      // la cajera le tiene que contestar cuando pregunte "¿y el mes que viene?".
      if (data.advance > 0 && !sinFacturas) {
        const aplicado = data.advanceApplied > 0 ? ` · ${cop(data.advanceApplied)} ya imputados` : "";
        toast(
          mesesPagados.length
            ? `${cop(data.advance)} por adelantado: le queda pagado ${listar(mesesPagados)}`
              + ` (va en el recibo)${aplicado}`
            : `Saldo a favor de ${cop(data.advance)}: se aplicará solo a su próxima factura${aplicado}`,
          "wallet",
        );
      }
      // El mes adelantado y su rebaja. Va en su propio aviso: es lo que el cliente
      // pregunta al salir ("¿entonces ya no vuelvo hasta noviembre?").
      if (data.adelanto?.meses?.length) {
        const a = data.adelanto;
        toast(
          `Queda pagado ${listar(a.meses)} por adelantado`
          + (a.descuento > 0 ? ` con ${cop(a.descuento)} de descuento (${a.pct}%)` : ""),
          "calendar-plus",
        );
      }
      const premio = data.promo;
      if (premio?.total > 0) {
        toast(
          `Descuento aplicado: se le rebajaron ${cop(premio.total)} `
          + `en ${premio.facturas.length === 1 ? "la factura" : "las facturas"} `
          + premio.facturas.map((f: { tid: number }) => `#${f.tid}`).join(", ")
          + ` (${premio.facturas[0]?.promocion ?? "promoción"})`,
          "gift",
        );
      }
      const retirados = data.descuentosRetirados;
      if (retirados?.revertidas > 0) {
        toast(
          `Se retiró el descuento de ${retirados.promociones.join(", ")} (${cop(retirados.monto)}): la promoción ya había vencido`,
          "alert-circle",
        );
      }
      // El recibo de caja se guarda y sale a la impresora. Va por `imprimirPdf` y no
      // por `window.open`: después de un `await`, el navegador trata la pestaña nueva
      // como emergente y la bloquea — así se quedaba la caja sin voucher.
      const reciboListo = await imprimirRecibo(data.receiptId);
      onDone();

      // Reconexión automática: al pagar se le devuelve internet y/o TV según lo que
      // tenga cortado. Lo que el equipo no acepte queda como ORDEN DE SERVICIO —la
      // TV casi nunca se puede restablecer por red—, así que eso no es un fallo que
      // haya que gritar: es trabajo que ya está abierto y se avisa de paso.
      //
      // El muro rojo se reserva para lo que quedó sin reconectar Y sin orden: ahí sí
      // no hay nada abierto y quien recibió la plata tiene que enterarse en el acto.
      const rec: Reconexion | null = data.reconexion ?? null;
      // Se cobró a propósito sin devolver el servicio: se dice, para que nadie se
      // quede esperando que el cliente vuelva a navegar.
      if (!reconectar) toast("Pago registrado SIN reconexión: el cliente sigue cortado.", "wifi-off");
      const pendientes = rec?.ordenes ?? [];
      if (rec?.aplica && !rec.ok && !pendientes.length) { setFallo(rec); return; }
      if (rec?.aplica) {
        const volvieron = rec.servicios
          .filter((s) => s.ok)
          .map((s) => NOMBRE_SERVICIO[s.servicio] ?? s.servicio.toLowerCase());
        if (pendientes.length) {
          const texto = pendientes
            .map((o) => `${NOMBRE_SERVICIO[o.servicio] ?? o.servicio.toLowerCase()} → orden #${o.code}`)
            .join(", ");
          toast(`Pago aplicado · queda pendiente de visita: ${texto}`, "clipboard-list");
        } else if (rec.enCurso) toast("Pago aplicado · reconectando el servicio, puede tardar un momento", "loader");
        else if (rec.dryRun) toast(`Pago aplicado · reconexión de ${listar(volvieron)} SIMULADA (modo pruebas)`, "flask-conical");
        else if (volvieron.length) {
          // El número de orden se dice en el acto: es el registro que queda del
          // trabajo, y la cajera puede nombrarlo si el cliente pregunta.
          const constancia = (rec.registros ?? []).map((o) => `#${o.code}`).join(", ");
          toast(
            `Servicio reconectado: ${listar(volvieron)}${constancia ? ` · orden ${constancia}` : ""}`,
            "wifi",
          );
        }
      }
      // El prorrateo va en su propio aviso y después del de la reconexión: es plata
      // que el cliente todavía no sabe que debe, y sale del mostrador creyendo que
      // quedó al día si nadie se lo dice.
      if (rec?.cobro?.cobrado) {
        const c = rec.cobro;
        toast(
          `Se le cobraron ${c.dias} día(s) de servicio del mes: $${c.total.toLocaleString("es-CO")}` +
          `${c.invoiceTid ? ` · factura #${c.invoiceTid}${c.facturaNueva ? " (nueva)" : ""}` : ""}`,
          "receipt",
        );
      }

      // Si el recibo quedó esperando un clic, el modal NO se cierra: ahí está el
      // botón para abrirlo.
      if (!reciboListo) return;
      onClose();
    } catch (e) {
      setErr(mensajeDeError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Registrar pago" maxWidth="max-w-2xl">
      {/* El recibo se generó pero el navegador no dejó abrirlo solo. Un clic sí es
          gesto del usuario, así que desde aquí nunca lo bloquea. */}
      {reciboUrl && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning-border bg-warning-soft p-3">
          <span className="flex items-center gap-2 text-[12px] font-semibold text-warning-text">
            <Icon name="printer" size={16} /> El recibo está listo pero el navegador bloqueó la ventana.
          </span>
          <Button size="sm" onClick={() => { window.open(reciboUrl, "_blank"); setReciboUrl(null); onClose(); }}>
            <Icon name="receipt" size={14} /> Abrir recibo
          </Button>
        </div>
      )}
      {/* El pago quedó, el servicio no. Se muestra en lugar del formulario para que
          nadie cierre la ventana creyendo que el cliente ya está navegando. */}
      {fallo ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-start gap-3 rounded-lg border border-error-border bg-error-soft p-3">
            <Icon name="alert-triangle" size={18} className="mt-0.5 shrink-0 text-error-text" />
            <div className="min-w-0">
              <p className="text-[13px] font-bold text-error-text">El pago quedó registrado, pero el servicio NO se reconectó</p>
              <p className="mt-0.5 text-[12px] text-text-secondary">
                El cliente sigue cortado. Reintenta desde Red (Mikrotik / GenieACS) o avisa a soporte.
              </p>
            </div>
          </div>

          <div className="rounded-lg border border-border-subtle">
            {fallo.servicios.map((s) => (
              <div key={s.servicio} className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2 text-[12px] last:border-0">
                <span className="flex items-center gap-1.5 font-semibold text-text-primary">
                  <Icon name={s.servicio === "TV" ? "tv" : "wifi"} size={14} />
                  {NOMBRE_SERVICIO[s.servicio] ?? s.servicio}
                  {s.via && <span className="font-normal text-text-tertiary">· {s.via}</span>}
                </span>
                <Badge
                  label={s.ok ? "reconectado" : s.orden ? `orden #${s.orden.code}` : "falló"}
                  tone={s.ok ? "success" : s.orden ? "warning" : "error"}
                />
                <span className="w-full text-text-tertiary">{s.detalle}</span>
              </div>
            ))}
          </div>

          <div className="flex justify-end pt-1">
            <Button onClick={onClose}>Entendido</Button>
          </div>
        </div>
      ) : (
      <>
      {!debt && !err && <div className="py-6 text-center text-[13px] text-text-tertiary">Cargando deuda…</div>}
      {debt && (
        <div className="flex flex-col gap-3">
          {/* Resumen deuda */}
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-surface-2 px-3 py-2">
            <span className="text-[13px] font-semibold text-text-primary">{debt.name}</span>
            <div className="flex gap-4 text-right">
              <div><div className="text-[10px] text-text-tertiary">Deuda total</div><div className="text-[14px] font-bold text-error-text">{cop(debt.totalDebt)}</div></div>
              <div
                title={(debt.advance ?? 0) > 0
                  ? `${cop(debt.advance ?? 0)} pagados por adelantado (se aplican solos a su próxima factura)`
                  : undefined}
              >
                <div className="text-[10px] text-text-tertiary">Saldo a favor</div>
                <div className="text-[14px] font-bold text-text-primary">{cop(debt.balance + (debt.advance ?? 0))}</div>
              </div>
            </div>
          </div>

          {sinFacturas ? (
            <>
              {/* No hay factura que cubrir, pero el cliente vino a pagar: la plata se
                  recibe igual y queda como saldo a favor. Antes esto era un cartel
                  muerto y la cajera tenía que emitirle a mano la factura del mes que
                  aún no se ha corrido. */}
              <div className="flex items-start gap-2 rounded-lg border border-border-subtle bg-surface p-3 text-[12px] text-text-secondary">
                <Icon name="wallet" size={15} className="mt-px shrink-0 text-text-tertiary" />
                <span>
                  <b className="text-text-primary">El cliente no tiene facturas pendientes.</b>{" "}
                  Puedes cobrarle igual el mes que viene: <b>el recibo sale con ese mes</b> y la
                  factura nace ya pagada cuando se corra la facturación. No hay que emitirla
                  a mano por adelantado.
                </span>
              </div>
              {bloqueAdelanto}
              {camposDePago("Los meses que alcance salen en el recibo")}
              {avisoCaja}
            </>
          ) : (
            <>
              {/* Facturas a pagar: se marcan las que se van a cubrir. El monto se
                  reparte SOLO entre las marcadas (el backend recibe sus ids). */}
              <div>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5 text-[11px] font-semibold text-text-tertiary">
                    <Icon name="list" size={13} /> Facturas a pagar
                  </span>
                  <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-text-secondary">
                    <input
                      type="checkbox"
                      className="h-4 w-4 cursor-pointer accent-brand"
                      checked={elegidas.length === debt.invoices.length}
                      onChange={(e) => {
                        const todas = e.target.checked;
                        const ids = todas ? debt.invoices.map((i) => i.id) : [];
                        const sigueAdelantando = todas && adelantar;
                        setElegidas(ids);
                        setAdelantar(sigueAdelantando);
                        setAmount(montoCuadrado(ids, sigueAdelantando));
                      }}
                    />
                    Todas
                  </label>
                </div>
                <div className="max-h-48 overflow-y-auto rounded-lg border border-border-subtle">
                  {debt.invoices.map((inv) => {
                    const marcada = elegidas.includes(inv.id);
                    const p = marcada ? preview.find((x) => x.tid === inv.tid) : undefined;
                    return (
                      <label
                        key={inv.id}
                        className={`flex cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 border-b border-border-subtle px-3 py-2 text-[12px] last:border-0 ${marcada ? "bg-surface-2" : ""}`}
                      >
                        <input
                          type="checkbox"
                          className="h-4 w-4 shrink-0 cursor-pointer accent-brand"
                          checked={marcada}
                          onChange={() => alternar(inv.id)}
                        />
                        <span className="font-mono text-text-secondary">#{inv.tid}</span>
                        {/* Qué mes se está pagando: la cajera lo canta en voz alta al
                            cobrar y antes tenía que abrir la factura para saberlo. El
                            concepto sólo aparece en las fijas, que no son mensualidad. */}
                        {inv.mes && <span className="text-text-primary">· {inv.mes}</span>}
                        {inv.concepto && (
                          <span className="text-text-tertiary">· {inv.concepto}</span>
                        )}
                        <span className="text-text-tertiary">· saldo {cop(inv.balance)}</span>
                        <span className="ml-auto">
                          {p ? (
                            <span className="flex flex-wrap items-center justify-end gap-1">
                              {p.descuento > 0 && (
                                <Badge label={`−${cop(p.descuento)}${inv.promocionLabel ? ` ${inv.promocionLabel}` : ""}`} tone="info" />
                              )}
                              <Badge label={`+${cop(p.applied)}${p.willBePaid ? " · saldada" : " · parcial"}`} tone={p.willBePaid ? "success" : "warning"} />
                            </span>
                          ) : (
                            <span className="text-[11px] text-text-tertiary">—</span>
                          )}
                        </span>
                      </label>
                    );
                  })}
                </div>
                {excedente > 0 && (
                  <p className="mt-1 text-[11px] text-warning-text">
                    Excedente de {cop(excedente)}: paga por adelantado los meses que alcance. Salen
                    en el recibo y esas facturas nacen ya pagadas (no hay que emitirlas a mano).
                  </p>
                )}
                <p className="mt-1 text-[11px] text-text-tertiary">
                  Marcadas {seleccionadas.length} de {debt.invoices.length} · total a aplicar{" "}
                  <span className="font-semibold text-text-primary">{cop(totalPreview)}</span>
                  {descuentoPreview > 0 && (
                    <> · se le rebajan{" "}
                      <span className="font-semibold text-success-text">{cop(descuentoPreview)}</span>
                      {debt.invoices.find((i) => i.promocion)?.promocion
                        ? ` de ${debt.invoices.find((i) => i.promocion)!.promocion}`
                        : " por promoción"}
                    </>
                  )}
                </p>
              </div>

              {bloqueAdelanto}

              {/* Formulario */}
              {camposDePago(
                adelantar
                  ? `Deuda marcada ${cop(deudaElegida)} + adelanto ${cop(adelanto?.neto ?? 0)}`
                  : `Deuda marcada: ${cop(deudaElegida)}`,
              )}

              {/* Qué pasa con el SERVICIO al cobrar. Se pregunta siempre porque quien
                  atiende es la única que sabe a qué vino el cliente: el que se pone al
                  día quiere volver a navegar, y el que se retira viene a saldar y ya.
                  Antes no había manera de decirlo y todo pago reconectaba. */}
              <div className="rounded-lg border border-border-subtle">
                <div className="flex items-center gap-1.5 border-b border-border-subtle px-3 py-2 text-[11px] font-semibold text-text-tertiary">
                  <Icon name="wifi" size={13} /> Servicio del cliente
                </div>
                <label className={`flex cursor-pointer items-start gap-2 border-b border-border-subtle px-3 py-2 text-[12px] ${reconectar ? "bg-surface-2" : ""}`}>
                  <input
                    type="radio" name="reconectar" className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-brand"
                    checked={reconectar} onChange={() => setReconectar(true)}
                  />
                  <span className="min-w-0">
                    <span className="font-semibold text-text-primary">Reconectar el servicio</span>
                    <span className="block text-[11px] text-text-tertiary">
                      Si está cortado, le vuelve internet y/o televisión al aplicar el pago.
                    </span>
                  </span>
                </label>
                <label className={`flex cursor-pointer items-start gap-2 px-3 py-2 text-[12px] ${!reconectar ? "bg-surface-2" : ""}`}>
                  <input
                    type="radio" name="reconectar" className="mt-0.5 h-4 w-4 shrink-0 cursor-pointer accent-brand"
                    checked={!reconectar} onChange={() => setReconectar(false)}
                  />
                  <span className="min-w-0">
                    <span className="font-semibold text-text-primary">Sólo recibir el pago, sin reconectar</span>
                    <span className="block text-[11px] text-text-tertiary">
                      Para el cliente que paga lo que debe pero se retira o no quiere el servicio de vuelta.
                    </span>
                  </span>
                </label>
              </div>
              {!reconectar && (
                <p className="flex items-start gap-1.5 rounded-lg border border-warning-border bg-warning-soft p-2 text-[11px] text-warning-text">
                  <Icon name="alert-circle" size={13} className="mt-px shrink-0" />
                  <span>
                    El cliente <b>seguirá cortado</b> después de pagar. Esto no lo retira ni le cambia el
                    estado: el retiro se tramita aparte.
                  </span>
                </p>
              )}

              {avisoCaja}
            </>
          )}

          {err && <p className="text-[12px] text-error-text">{err}</p>}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
            <Button
              onClick={submit}
              disabled={saving || amountNum <= 0 || (!sinFacturas && seleccionadas.length === 0)}
            >
              {saving
                ? "Registrando…"
                : sinFacturas
                  ? "Cobrar mes adelantado"
                  : reconectar ? "Registrar pago y reconectar" : "Registrar pago sin reconectar"}
            </Button>
          </div>
        </div>
      )}
      {err && !debt && <p className="py-4 text-center text-[12px] text-error-text">{err}</p>}
      </>
      )}
    </Modal>
  );
}
