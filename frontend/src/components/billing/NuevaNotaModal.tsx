"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Field } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { SubscriberPicker, type PickedSub } from "@/components/cobranzas/SubscriberPicker";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

type Fact = {
  id: string; tid: number; date: string | null; dueDate: string | null;
  total: number; paid: number; balance: number; status: string;
};
type Deuda = {
  name: string; abonado: number | null; docNumber: string | null;
  balance: number; totalDebt: number; scope: "due" | "all"; items: Fact[];
};

/** Cómo se reparte el dinero entre las facturas marcadas. */
type Modo = "CADA" | "SALDO" | "REPARTIR";

/** Lo que le toca a una factura del lote. */
type Reparto = { invoiceId: string; tid: number; amount: number };

const fecha = (s: string | null) => (s ? new Date(s).toLocaleDateString("es-CO") : "—");
const r2 = (n: number) => Math.round(n * 100) / 100;

/** De la más vieja a la más nueva: es el orden en que se cubre la cartera. */
function porAntiguedad(a: Fact, b: Fact) {
  const fa = a.date ? new Date(a.date).getTime() : 0;
  const fb = b.date ? new Date(b.date).getTime() : 0;
  return fa - fb || a.tid - b.tid;
}

/**
 * Cuánto le toca a cada factura marcada.
 *
 * Se calcula AQUÍ, en la pantalla, y viaja al servidor factura por factura: así lo
 * que se ve en la lista antes de aplicar es exactamente lo que se escribe. Devuelve
 * también el `sobrante` (lo que no cupo repartiendo) para poder avisarlo.
 *
 *  - CADA:     el mismo monto en cada factura.
 *  - SALDO:    el saldo de cada una (saldarlas). Sólo tiene sentido en crédito.
 *  - REPARTIR: un monto único entre todas. En crédito cubre saldos empezando por la
 *    más vieja —que es como se abona la cartera—; en débito no hay saldo que llenar,
 *    así que se parte por igual y los centavos sueltos caen en las primeras.
 */
export function repartirNota(
  seleccion: Fact[],
  type: "CREDITO" | "DEBITO",
  modo: Modo,
  monto: number,
): { items: Reparto[]; sobrante: number } {
  const sel = [...seleccion].sort(porAntiguedad);
  if (!sel.length) return { items: [], sobrante: 0 };

  if (modo === "SALDO") {
    return {
      items: sel.filter((f) => f.balance > 0).map((f) => ({ invoiceId: f.id, tid: f.tid, amount: r2(f.balance) })),
      sobrante: 0,
    };
  }

  const total = r2(monto);
  if (!(total > 0)) return { items: [], sobrante: 0 };

  if (modo === "CADA") {
    return { items: sel.map((f) => ({ invoiceId: f.id, tid: f.tid, amount: total })), sobrante: 0 };
  }

  if (type === "CREDITO") {
    let queda = total;
    const items: Reparto[] = [];
    for (const f of sel) {
      if (queda <= 0) break;
      const dar = r2(Math.min(queda, Math.max(f.balance, 0)));
      if (dar <= 0) continue;
      items.push({ invoiceId: f.id, tid: f.tid, amount: dar });
      queda = r2(queda - dar);
    }
    return { items, sobrante: queda };
  }

  // Débito repartido: partes iguales en PESOS enteros y lo que sobre a la primera,
  // para que la suma de las notas dé EXACTAMENTE el monto tecleado sin sembrar
  // centavos por la cartera (aquí no se cobran centavos).
  const base = Math.floor(total / sel.length);
  const resto = r2(total - base * sel.length);
  const items: Reparto[] = [];
  sel.forEach((f, i) => {
    const parte = r2(base + (i === 0 ? resto : 0));
    if (parte <= 0) return;
    items.push({ invoiceId: f.id, tid: f.tid, amount: parte });
  });
  return { items, sobrante: 0 };
}

/**
 * Aplica una nota crédito (rebaja) o débito (recargo) sobre una o VARIAS facturas
 * del mismo cliente. Se abre desde el botón "Nueva nota" del listado de notas.
 *
 * La factura NO se escribe por número: se busca el cliente (nombre, cédula o
 * abonado) y se marcan las suyas. Escribir el `tid` a mano era el flujo del legacy y
 * obligaba a irse a otra pantalla a averiguarlo — y un dígito mal puesto aplicaba la
 * nota a la factura de otro cliente.
 *
 * Varias a la vez porque el caso normal es la depuración de cartera: perdonar los
 * seis meses que arrastra un abonado eran seis pasadas por este modal, reescribiendo
 * la misma observación, y a la tercera el cliente se quedaba a medio limpiar. El
 * lote entero va en una transacción del servidor: entran todas o no entra ninguna.
 */
export function NuevaNotaModal({
  open,
  onClose,
  onDone,
  inicial,
}: {
  open: boolean;
  onClose: () => void;
  /** Se llama tras aplicar con éxito para refrescar el listado. */
  onDone?: () => void;
  /**
   * Arranque ya lleno: lo usa la solicitud de nota de la pestaña Cobranza, que ya
   * sabe el cliente, el tipo, el monto sugerido y el porqué.
   */
  inicial?: { sub: PickedSub; type: "CREDITO" | "DEBITO"; amount?: number | null; description?: string };
}) {
  const { authFetch } = useAuth();
  const [sub, setSub] = useState<PickedSub | null>(null);
  const [deuda, setDeuda] = useState<Deuda | null>(null);
  const [cargando, setCargando] = useState(false);
  const [todas, setTodas] = useState(false);
  const [invoiceIds, setInvoiceIds] = useState<string[]>([]);
  const [type, setType] = useState<"CREDITO" | "DEBITO">("CREDITO");
  const [modo, setModo] = useState<Modo>("CADA");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [retentionType, setRetentionType] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset al cerrar para que la próxima apertura arranque limpia.
  useEffect(() => {
    if (open) {
      if (inicial) {
        setSub(inicial.sub); setType(inicial.type);
        setAmount(inicial.amount ? String(inicial.amount) : ""); setDescription(inicial.description ?? "");
      }
      return;
    }
    setSub(null); setDeuda(null); setTodas(false); setInvoiceIds([]);
    setType("CREDITO"); setModo("CADA"); setAmount(""); setDescription(""); setRetentionType("");
    setErr(null); setSaving(false);
    // `inicial` sólo cuenta al abrir: re-rellenar mientras se edita borraría lo tecleado.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Facturas del cliente elegido. `todas` alterna entre lo que debe y el histórico.
  useEffect(() => {
    if (!sub) { setDeuda(null); setInvoiceIds([]); return; }
    let vivo = true;
    setCargando(true); setErr(null);
    authFetch(`/billing/subscribers/${sub.id}/invoices${todas ? "?scope=all" : ""}`)
      .then((r) => r.json())
      .then((d: Deuda) => {
        if (!vivo) return;
        setDeuda(d);
        // Las marcadas que ya no estén en la lista nueva se sueltan.
        setInvoiceIds((prev) => prev.filter((id) => d.items?.some((i) => i.id === id)));
      })
      .catch((e) => { if (vivo) setErr(mensajeDeError(e)); })
      .finally(() => { if (vivo) setCargando(false); });
    return () => { vivo = false; };
  }, [sub, todas, authFetch]);

  const elegidas = useMemo(
    () => (deuda?.items ?? []).filter((i) => invoiceIds.includes(i.id)),
    [deuda, invoiceIds],
  );
  const varias = elegidas.length > 1;

  const { items: reparto, sobrante } = useMemo(
    () => repartirNota(elegidas, type, modo, Number(amount) || 0),
    [elegidas, type, modo, amount],
  );
  const montoDe = useMemo(() => new Map(reparto.map((r) => [r.invoiceId, r.amount])), [reparto]);
  const totalLote = useMemo(() => r2(reparto.reduce((s, r) => s + r.amount, 0)), [reparto]);
  // Marcadas que se quedarían fuera: en "repartir" crédito, aquellas a las que ya no
  // les alcanzó el monto (o que no tienen saldo que cubrir).
  const fuera = elegidas.length - reparto.length;

  // La nota crédito rebaja el total: pasarse del saldo lo deja en cero y sobra plata
  // sin aplicar. Se avisa, no se bloquea (el legacy lo permitía).
  const excedidas = type === "CREDITO" ? reparto.filter((r) => {
    const f = elegidas.find((e) => e.id === r.invoiceId);
    return f ? r.amount > f.balance : false;
  }).length : 0;

  const saldoElegido = useMemo(() => r2(elegidas.reduce((s, f) => s + Math.max(f.balance, 0), 0)), [elegidas]);

  function alternar(id: string) {
    setErr(null);
    setInvoiceIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  }

  async function submit() {
    setErr(null);
    if (!sub) { setErr("Busca y elige el cliente."); return; }
    if (!elegidas.length) { setErr("Marca al menos una factura."); return; }
    if (modo !== "SALDO" && (Number(amount) || 0) <= 0) { setErr("Ingresa un monto válido."); return; }
    if (!reparto.length) {
      setErr(modo === "SALDO"
        ? "Las facturas marcadas no tienen saldo pendiente."
        : "El monto no alcanza para ninguna de las facturas marcadas.");
      return;
    }
    if (reparto.length > 50) { setErr("No se pueden aplicar más de 50 notas de una vez."); return; }
    // La observación es obligatoria: una nota mueve el total de la factura y sin el
    // porqué el renglón queda mudo para quien abra el documento después.
    if (description.trim().length < 5) { setErr("Escribe la observación: por qué se aplica esta nota."); return; }
    setSaving(true);
    try {
      const res = await authFetch("/billing/notes", {
        method: "POST",
        body: JSON.stringify({
          type, description: description.trim(),
          retentionType: retentionType || undefined,
          items: reparto.map((r) => ({ invoiceId: r.invoiceId, amount: r.amount })),
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo crear la nota");
      const n = d?.count ?? reparto.length;
      const tipo = type === "CREDITO" ? "crédito" : "débito";
      toast(n > 1
        ? `${n} notas ${tipo} aplicadas · ${type === "CREDITO" ? "-" : "+"}${cop(d?.total ?? totalLote)}`
        : `Nota ${tipo} aplicada · nuevo total ${cop(d?.results?.[0]?.newTotal ?? 0)}`);
      onClose();
      onDone?.();
    } catch (e) { setErr(mensajeDeError(e)); } finally { setSaving(false); }
  }

  return (
    <Modal open={open} onClose={onClose} title="Aplicar nota crédito / débito" maxWidth="max-w-2xl">
      <div className="flex flex-col gap-2.5">
        <Field label="Cliente" required>
          <SubscriberPicker
            value={sub}
            onChange={(s) => { setSub(s); setTodas(false); setInvoiceIds([]); }}
            placeholder="Elige el cliente…"
          />
        </Field>

        {sub && (
          <div className="rounded-lg border border-border-subtle bg-surface">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border-subtle px-3 py-2">
              <span className="flex items-center gap-1.5 text-[12px] font-semibold text-text-secondary">
                <Icon name="file-text" size={13} />
                {todas ? "Facturas del cliente" : "Facturas que debe"}
              </span>
              <div className="flex items-center gap-3">
                {deuda && !todas && (
                  <span className="text-[11px] text-text-tertiary">
                    Debe <span className="font-semibold text-error-text">{cop(deuda.totalDebt)}</span>
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setTodas((v) => !v)}
                  className="text-[11px] font-medium text-brand hover:underline"
                >
                  {todas ? "Sólo las que debe" : "Ver todas"}
                </button>
              </div>
            </div>

            {/* Marcar en bloque: la depuración de cartera casi siempre son TODAS las
                que debe, y marcarlas de a una era el trabajo que se quería evitar. */}
            {!!deuda?.items.length && (
              <div className="flex flex-wrap items-center gap-3 border-b border-border-subtle bg-surface-subtle px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => { setErr(null); setInvoiceIds(deuda.items.map((i) => i.id)); }}
                  className="text-[11px] font-medium text-brand hover:underline"
                >
                  Marcar todas ({deuda.items.length})
                </button>
                {invoiceIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => { setErr(null); setInvoiceIds([]); }}
                    className="text-[11px] font-medium text-text-tertiary hover:underline"
                  >
                    Quitar selección
                  </button>
                )}
                <span className="ml-auto text-[11px] text-text-tertiary">
                  {elegidas.length === 0
                    ? "Ninguna marcada"
                    : <>
                        <span className="font-semibold text-text-secondary">{elegidas.length}</span> marcada{elegidas.length === 1 ? "" : "s"}
                        {saldoElegido > 0 && <> · saldo <span className="font-semibold text-error-text">{cop(saldoElegido)}</span></>}
                      </>}
                </span>
              </div>
            )}

            {cargando ? (
              <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">Cargando facturas…</div>
            ) : !deuda?.items.length ? (
              <div className="px-3 py-6 text-center text-[12px] text-text-tertiary">
                {todas ? "El cliente no tiene facturas." : "El cliente no tiene facturas pendientes."}
              </div>
            ) : (
              <div className="max-h-56 overflow-y-auto">
                {deuda.items.map((f) => {
                  const marcada = invoiceIds.includes(f.id);
                  const toca = montoDe.get(f.id);
                  return (
                    <label
                      key={f.id}
                      className={`flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 border-b border-border-subtle px-3 py-2 text-[12px] last:border-0 ${marcada ? "bg-surface-2" : "hover:bg-surface-2"}`}
                    >
                      <input
                        type="checkbox"
                        className="h-4 w-4 shrink-0 cursor-pointer accent-brand"
                        checked={marcada}
                        onChange={() => alternar(f.id)}
                      />
                      <span className="font-mono font-medium text-text-primary">#{f.tid}</span>
                      <span className="text-text-tertiary">{fecha(f.date)}</span>
                      <span className="text-text-secondary">total {cop(f.total)}</span>
                      <span className="ml-auto flex items-center gap-2">
                        {/* Lo que le tocaría a ESTA factura con el reparto de arriba. */}
                        {marcada && (
                          toca != null
                            ? <span className={`font-semibold ${type === "CREDITO" ? "text-success-text" : "text-warning-text"}`}>
                                {type === "CREDITO" ? "-" : "+"}{cop(toca)}
                              </span>
                            : <span className="text-[11px] text-text-tertiary">sin monto</span>
                        )}
                        {f.balance > 0 && <span className="font-semibold text-error-text">saldo {cop(f.balance)}</span>}
                        <Badge
                          label={f.status === "PAID" ? "Pagada" : f.status === "PARTIAL" ? "Abonada" : f.status === "CANCELED" ? "Anulada" : "Pendiente"}
                          tone={f.status === "PAID" ? "success" : f.status === "PARTIAL" ? "warning" : f.status === "CANCELED" ? "default" : "error"}
                        />
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <Field label="Tipo" required>
          {/* "El saldo de cada factura" sólo existe en la nota crédito (una débito no
              salda nada), así que al pasar a débito se vuelve al monto por factura. */}
          <Select
            value={type}
            onChange={(e) => {
              const t = e.target.value as "CREDITO" | "DEBITO";
              setType(t);
              if (t === "DEBITO" && modo === "SALDO") setModo("CADA");
            }}
          >
            <option value="CREDITO">Nota crédito (rebaja)</option>
            <option value="DEBITO">Nota débito (recargo)</option>
          </Select>
        </Field>
        {/* Retención: paridad legacy — se captura aquí (no al facturar) y el valor lo
            digita el usuario en "Monto"; el sistema no lo calcula. */}
        <Field label="¿Tiene retención? ¿Qué tipo?">
          <Select value={retentionType} onChange={(e) => setRetentionType(e.target.value)}>
            <option value="">- Seleccionar -</option>
            <option value="Retefuente Servicios">Retefuente Servicios</option>
            <option value="Compras">Compras</option>
            <option value="Personas no declarantes">Personas no declarantes</option>
            <option value="Reteiva">Reteiva</option>
          </Select>
        </Field>

        {/* Con una sola factura marcada el reparto no tiene sentido: se pide el monto
            y ya. El selector aparece cuando hay varias, que es cuando hay algo que
            decidir. */}
        {varias && (
          <Field label="Monto de cada nota" required>
            <Select value={modo} onChange={(e) => { setModo(e.target.value as Modo); setErr(null); }}>
              <option value="CADA">El mismo monto en cada factura</option>
              {type === "CREDITO" && <option value="SALDO">El saldo de cada factura (saldarlas)</option>}
              <option value="REPARTIR">
                {type === "CREDITO"
                  ? "Repartir un monto entre ellas (cubre saldos, de la más vieja)"
                  : "Repartir un monto por igual entre ellas"}
              </option>
            </Select>
          </Field>
        )}

        {modo !== "SALDO" && (
          <Field label={varias && modo === "REPARTIR" ? "Monto total a repartir" : "Monto"} required>
            <div className="flex items-center gap-2">
              <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" />
              {/* El atajo del saldo sólo se ofrece cuando hay UN saldo que copiar: con
                  varias marcadas y "el mismo monto en cada una" no significa nada
                  (para saldarlas está su propio modo). */}
              {type === "CREDITO" && saldoElegido > 0 && (!varias || modo === "REPARTIR") && (
                <Button
                  variant="secondary"
                  size="sm"
                  className="shrink-0 whitespace-nowrap"
                  onClick={() => setAmount(String(varias ? saldoElegido : (elegidas[0]?.balance ?? saldoElegido)))}
                >
                  {varias ? "Todo el saldo" : "Saldo de la factura"}
                </Button>
              )}
            </div>
          </Field>
        )}

        {/* Resumen de lo que se va a escribir: cuántas notas, por cuánto y qué queda
            fuera. Es lo último que se ve antes de aplicar, y aplicar mueve plata. */}
        {elegidas.length > 0 && (
          <div className="rounded-lg border border-border-subtle bg-surface-subtle px-3 py-2 text-[12px]">
            {reparto.length > 0 ? (
              <p className="text-text-secondary">
                Se {reparto.length === 1 ? "aplicará" : "aplicarán"}{" "}
                <span className="font-semibold text-text-primary">{reparto.length}</span>{" "}
                nota{reparto.length === 1 ? "" : "s"} {type === "CREDITO" ? "crédito" : "débito"} por{" "}
                <span className={`font-semibold ${type === "CREDITO" ? "text-success-text" : "text-warning-text"}`}>
                  {type === "CREDITO" ? "-" : "+"}{cop(totalLote)}
                </span>{" "}
                en total.
              </p>
            ) : (
              <p className="text-text-tertiary">Aún no hay nada que aplicar: pon el monto o marca una factura con saldo.</p>
            )}
            {fuera > 0 && reparto.length > 0 && (
              <p className="mt-1 text-warning-text">
                {fuera} de las marcadas {fuera === 1 ? "queda" : "quedan"} fuera: {modo === "SALDO" ? "no tienen saldo pendiente" : "el monto no alcanza para ellas"}.
              </p>
            )}
            {sobrante > 0 && (
              <p className="mt-1 text-warning-text">
                Sobran {cop(sobrante)} sin aplicar: los saldos de las facturas marcadas no llegan a ese monto.
              </p>
            )}
            {excedidas > 0 && (
              <p className="mt-1 text-warning-text">
                {excedidas === 1 ? "Una nota supera" : `${excedidas} notas superan`} el saldo de su factura: ese total quedará en cero.
              </p>
            )}
          </div>
        )}

        {/* Obligatoria: es lo único que le explica a contabilidad —o a quien abra la
            factura meses después— por qué se rebajó (o recargó) ese dinero. Sale en el
            renglón de la factura, en su historial y en el listado de notas. La misma
            observación se copia en todas las notas del lote. */}
        <Field label="Observación (por qué se aplica)" required>
          <Textarea
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            maxLength={500}
            placeholder="Ej.: depuración de cartera, número apagado sin contrato. Autoriza Ing. Paula Niño."
          />
        </Field>
        {err && <p className="text-[12px] text-error-text">{err}</p>}
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>Cancelar</Button>
          <Button onClick={submit} disabled={saving || !reparto.length || description.trim().length < 5}>
            {saving
              ? "Aplicando…"
              : reparto.length > 1 ? `Aplicar ${reparto.length} notas` : "Aplicar nota"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
