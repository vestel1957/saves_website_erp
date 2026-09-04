"use client";

import { useEffect, useMemo, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Field, Input, Select } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { fullCurrency } from "@/lib/format";
import { type Plan, type ChangePlanResult } from "@/lib/plans";
import { type ServicioAsignado } from "@/lib/servicio-asignado";

/**
 * "Asignar servicio" desde la factura — el bloque ASIGNAR SERVICIO del legacy.
 *
 * Es el sitio donde se registra que un cliente cambió de plan: no toca esta factura
 * ni ninguna ya emitida, fija lo que se le cobrará de la próxima facturación en
 * adelante. Un selector por servicio (internet, televisión) más los puntos, igual que
 * allá, con la opción "No" para quitarle uno.
 */
export function AsignarServicioModal({
  invoiceId,
  actual,
  open,
  onClose,
  onDone,
}: {
  invoiceId: string;
  actual: ServicioAsignado | null;
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
}) {
  const { authFetch } = useAuth();
  const [plans, setPlans] = useState<Plan[] | null>(null);
  // "" = no se toca. Un id de plan = ese plan. "no" = quitarle el servicio.
  const [internet, setInternet] = useState("");
  const [tv, setTv] = useState("");
  const [puntos, setPuntos] = useState<string>("");
  const [pushRouter, setPushRouter] = useState(true);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  /** Respuesta de la asignación: lo que quedó contratado + qué dijo el router. */
  const [hecho, setHecho] = useState<(ServicioAsignado & { routers: ChangePlanResult["router"][] }) | null>(null);

  useEffect(() => {
    if (!open) return;
    setInternet(""); setTv(""); setPuntos(""); setReason(""); setPushRouter(true); setHecho(null);
    // El catálogo COMPLETO, no sólo lo que está en venta: esto no vende, corrige el
    // plan de quien ya factura, y la mayoría de los abonados vive en planes ocultos
    // (los del legacy). Con `activeOnly` el desplegable ofrecía 13 de 85 planes y no
    // había forma de dejarle a un cliente el mismo plan que su factura ya le cobra.
    void authFetch(`/plans`)
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setPlans(Array.isArray(d) ? d : []))
      .catch(() => setPlans([]));
  }, [open, authFetch]);

  const porKind = useMemo(() => {
    const m = new Map<string, Plan[]>();
    for (const p of plans ?? []) {
      if (!m.has(p.kind)) m.set(p.kind, []);
      m.get(p.kind)!.push(p);
    }
    return m;
  }, [plans]);

  const actualDe = (kind: string) => actual?.servicios.find((s) => s.kind === kind) ?? null;
  const puntosActuales = actualDe("PUNTOS")?.qty ?? 0;
  const puntosNum = puntos === "" ? null : Math.max(0, Math.trunc(Number(puntos) || 0));
  const hayCambio = Boolean(internet || tv || (puntosNum !== null && puntosNum !== puntosActuales));

  /** ¿El cambio mueve la velocidad? Solo entonces tiene sentido ofrecer el router. */
  const cambiaInternet = Boolean(internet) && internet !== "no";

  async function aplicar() {
    if (!hayCambio) return;
    setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (internet) body.internet = internet;
      if (tv) body.tv = tv;
      if (puntosNum !== null && puntosNum !== puntosActuales) body.puntos = puntosNum;
      if (cambiaInternet && !pushRouter) body.pushRouter = false;
      if (reason.trim()) body.reason = reason.trim();

      const res = await authFetch(`/billing/invoices/${invoiceId}/servicio`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message || "No se pudo asignar el servicio");
      setHecho({ ...data, routers: data.routers ?? [] });
      toast("Servicio asignado: se cobra desde la próxima facturación", "check");
      onDone?.();
    } catch (e) {
      toast((e as Error).message, "alert-circle");
    } finally {
      setBusy(false);
    }
  }

  const selector = (
    kind: "INTERNET" | "TV",
    etiqueta: string,
    valor: string,
    set: (v: string) => void,
  ) => {
    const lista = porKind.get(kind) ?? [];
    // En venta arriba; los ocultos aparte, para no ofrecer un plan retirado como si
    // fuera de catálogo pero sin esconderlo de quien viene justo a ponerlo.
    const enVenta = lista.filter((p) => p.active);
    const ocultos = lista.filter((p) => !p.active);
    const opcion = (p: Plan) => (
      <option key={p.id} value={p.id}>
        {p.name} · {fullCurrency(p.price)}
      </option>
    );
    const suyo = actualDe(kind);
    return (
      <Field
        label={etiqueta}
        hint={
          suyo
            ? <>Hoy: <b>{suyo.planName}</b> · {fullCurrency(suyo.price)}/mes</>
            : <>Hoy no tiene {etiqueta.toLowerCase()}.</>
        }
      >
        <Select value={valor} onChange={(e) => set(e.target.value)}>
          <option value="">— Dejar como está —</option>
          <option value="no">No (quitar el servicio)</option>
          {enVenta.length > 0 && <optgroup label="En venta">{enVenta.map(opcion)}</optgroup>}
          {ocultos.length > 0 && (
            <optgroup label="Ocultos (ya no se venden, pero se siguen facturando)">
              {ocultos.map(opcion)}
            </optgroup>
          )}
        </Select>
      </Field>
    );
  };

  return (
    <Modal open={open} onClose={onClose} title="Asignar servicio">
      {hecho ? (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-text-primary">
            Listo. El abonado queda con <b>{resumen(hecho)}</b> y así se le cobrará desde la próxima
            facturación mensual. Las facturas ya emitidas no cambian.
          </p>
          {hecho.routers.filter(Boolean).map((r, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-border-subtle bg-surface-2 p-2.5">
              <Icon name="router" size={14} />
              <span className="text-[11px] font-semibold text-text-secondary">Router</span>
              <Badge
                tone={r!.dryRun ? "warning" : r!.ok ? "success" : "error"}
                label={r!.dryRun ? "DRY-RUN" : r!.ok ? "APLICADO" : "ERROR"}
              />
              <span className="truncate text-[11px] text-text-tertiary">{r!.message}</span>
            </div>
          ))}
          <div className="flex justify-end">
            <Button onClick={onClose}>Listo</Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-[12px] text-text-tertiary">
            Cambia el plan contratado del abonado. No modifica esta factura ni ninguna ya
            emitida: se cobra a partir de la próxima facturación mensual.
          </p>

          {!plans && <p className="text-[12px] text-text-tertiary">Cargando planes…</p>}

          {plans && (
            <>
              {selector("INTERNET", "Internet", internet, setInternet)}
              {selector("TV", "Televisión", tv, setTv)}

              <Field
                label="Puntos adicionales de TV"
                hint={`Hoy: ${puntosActuales}. Déjalo vacío para no tocarlos; 0 los quita.`}
              >
                <Input
                  type="number" min={0} max={200} inputMode="numeric"
                  placeholder={String(puntosActuales)}
                  value={puntos}
                  onChange={(e) => setPuntos(e.target.value)}
                />
              </Field>

              {/* El legacy no toca el router al asignar servicio; aquí sí, porque cobrarle
                  300 megas a quien navega a 100 es el error que esto viene a evitar. Se
                  puede apagar cuando la velocidad la cambia el técnico en la visita. */}
              {cambiaInternet && (
                <label className="flex items-start gap-2 text-[12px] text-text-secondary">
                  <input
                    type="checkbox" className="mt-0.5"
                    checked={pushRouter}
                    onChange={(e) => setPushRouter(e.target.checked)}
                  />
                  <span>
                    Aplicar la velocidad en el router ahora
                    <span className="block text-[11px] text-text-tertiary">
                      Desmárcalo si el cambio de velocidad lo hará el técnico en una visita.
                    </span>
                  </span>
                </label>
              )}

              <Field label="Motivo (opcional)">
                <Input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Ej.: el cliente pidió subir a 300 megas"
                />
              </Field>

              {/* Qué factura recibe el snapshot que lee el legacy: sin esto, asignar el
                  servicio desde una fija parecería no hacer nada al mirar allá. */}
              {actual?.dicta && !actual.dicta.esEsta && (
                <p className="rounded-lg border border-border-subtle bg-surface-2 p-2.5 text-[11px] text-text-secondary">
                  El plan queda registrado también en la factura mensual #{actual.dicta.tid}, que
                  es de la que el sistema anterior lee qué cobrar el mes siguiente.
                </p>
              )}
              {actual && !actual.dicta && (
                <p className="rounded-lg border border-warning-border bg-warning-soft p-2.5 text-[11px] text-warning-text">
                  El abonado todavía no tiene ninguna factura mensual, así que el plan queda
                  solo en su ficha. Aquí se cobra igual; en el sistema anterior no hay dónde
                  registrarlo.
                </p>
              )}
            </>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose} disabled={busy}>Cancelar</Button>
            <Button onClick={aplicar} disabled={!hayCambio || busy}>
              {busy ? <><Icon name="loader" size={14} className="animate-spin" /> Asignando…</> : "Asignar servicio"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function resumen(actual: ServicioAsignado | null) {
  const s = (actual?.servicios ?? []).filter((x) => x.kind !== "PUNTOS");
  const puntos = actual?.servicios.find((x) => x.kind === "PUNTOS")?.qty ?? 0;
  const partes = s.map((x) => x.planName).filter(Boolean) as string[];
  if (puntos) partes.push(`${puntos} punto${puntos === 1 ? "" : "s"} de TV`);
  return partes.length ? partes.join(" + ") : "sin servicios contratados";
}
