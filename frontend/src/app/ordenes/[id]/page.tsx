"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field, Textarea } from "@/components/ui/Field";
import { Badge } from "@/components/ui/Badge";
import { Modal } from "@/components/Modal";
import { FirmaOtpModal } from "@/components/FirmaOtpModal";
import { ConsignacionCampos, consignacionVacia, type Consignacion } from "@/components/orders/ConsignacionCampos";
import { DestinoCampos, destinoVacio, useDestinos, type Destino } from "@/components/orders/DestinoCampos";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { DataTable } from "@/components/ui/DataTable";
import { PageSkeleton } from "@/components/skeletons/PageSkeleton";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { PERM } from "@/lib/auth";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";
import { ACCEPT_ADJUNTO, ACCEPT_IMAGEN_PDF } from "@/lib/adjuntos";
import { ComprobanteCell } from "@/components/treasury/ComprobanteCell";

type EditRow = { product: string; qty: string; price: string; taxRate: string };

/** Los estados de una orden. Espejo de `ESTADOS_ORDEN` en el backend. */
const ESTADOS_ORDEN = ["pendiente", "aprobado", "abonado", "recibido parcial", "recibido", "finalizado", "cancelado", "anulado"];

function statusTone(status: string): "default" | "success" | "error" | "warning" {
  if (status === "recibido" || status === "finalizado") return "success";
  if (status === "cancelado" || status === "anulado") return "error";
  if (status === "recibido parcial") return "warning";
  return "default";
}

function fmtDate(d?: string) {
  return d ? new Date(d).toLocaleDateString("es-CO") : "—";
}

export default function OrdenDetallePage() {
  const { loading: authLoading, authFetch, can, isSuperadmin } = useAuth();
  const params = useParams();
  const id = String(params?.id ?? "");

  const [order, setOrder] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [receive, setReceive] = useState<Record<string, string>>({});
  // Bodega a la que entra lo recibido: la de la orden, o la que se escoja al recibir.
  const [receiveWarehouse, setReceiveWarehouse] = useState("");
  const destinos = useDestinos();
  // Productos de esa bodega y a cuál se suma cada ítem ("" = crear el producto en la bodega).
  const [bodegaMats, setBodegaMats] = useState<{ id: string; name: string; code: string | null; qty: number }[]>([]);
  const [receiveMat, setReceiveMat] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("Cash");
  const [payCash, setPayCash] = useState("");
  // Fecha del pago y motivo. La fecha manda sobre en qué día (y en qué cierre)
  // entra el egreso, así que hay que poder registrar el de ayer sin que caiga hoy.
  const [payDate, setPayDate] = useState("");
  const [payDesc, setPayDesc] = useState("");
  // Soporte del pago (opcional). No es un adjunto de la orden: se guarda en el EGRESO
  // que crea el pago, que es donde tesorería lo revisa. Antes había que subirlo dos
  // veces —aquí y en el movimiento de caja— para verlo en los dos sitios.
  const [payFile, setPayFile] = useState<File | null>(null);
  const [cashAccounts, setCashAccounts] = useState<{ id: number; name: string }[]>([]);
  const [paying, setPaying] = useState(false);
  // Notas / retenciones
  const [noteOpen, setNoteOpen] = useState(false);
  const [noteType, setNoteType] = useState("Retencion");
  const [noteRetType, setNoteRetType] = useState("Retefuente Servicios");
  const [noteAmount, setNoteAmount] = useState("");
  const [noteDesc, setNoteDesc] = useState("");
  const [notesaving, setNotesaving] = useState(false);
  const [confirmar, setConfirmar] = useState<{ kind: "borrar-nota"; nota: any } | { kind: "cancelar" } | { kind: "finalizar" } | { kind: "borrar-adjunto"; file: any } | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  // Flujo de aprobación / edición / adjuntos
  const [flowBusy, setFlowBusy] = useState(false);
  const [firmarOpen, setFirmarOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [editOpen, setEditOpen] = useState(false);
  const [editRows, setEditRows] = useState<EditRow[]>([]);
  const [editDate, setEditDate] = useState("");
  const [editDue, setEditDue] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editStatus, setEditStatus] = useState("");
  const [editConsig, setEditConsig] = useState<Consignacion>(consignacionVacia);
  const [editDestino, setEditDestino] = useState<Destino>(destinoVacio);
  // Los ítems tal como se abrieron: si nadie los tocó no se mandan, y así cambiar solo
  // el estado no reemplaza las líneas (ni deja un "Ítems reemplazados" falso en la bitácora).
  const [editRowsIniciales, setEditRowsIniciales] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Adjunto elegido que TODAVÍA no se ha subido: mientras esté aquí se pregunta si es
  // el soporte de un pago (ver `elegirAdjunto`). `adjuntoPago` es el pago escogido,
  // "" = va sólo a la orden.
  const [adjuntoPendiente, setAdjuntoPendiente] = useState<File | null>(null);
  const [adjuntoPago, setAdjuntoPago] = useState("");
  const puedeAprobar = can(PERM.PURCHASES_APPROVE);
  // La CAJERA tiene Compras completo desde 2026-09-17 (antes sólo miraba y adjuntaba).

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`/orders/${id}`);
      const d = await res.json();
      setOrder(d);
      const init: Record<string, string> = {};
      for (const it of d?.items ?? []) init[it.id] = String(it.received ?? 0);
      setReceive(init);
      setReceiveWarehouse(d?.warehouse?.id ?? "");
    } finally { setLoading(false); }
  }, [authFetch, id]);

  useEffect(() => {
    if (authLoading || !id) return;
    void load();
  }, [authLoading, id, load]);

  useEffect(() => {
    if (authLoading || !receiveWarehouse) { setBodegaMats([]); return; }
    let vivo = true;
    void authFetch(`/orders/destinations?warehouseId=${encodeURIComponent(receiveWarehouse)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!vivo) return;
        const mats: { id: string; name: string; code: string | null; qty: number }[] = d?.materials ?? [];
        setBodegaMats(mats);
        // Propuesta: el producto ligado al ítem si está en esta bodega, o el del mismo nombre.
        const norm = (t: string) => t.trim().replace(/\s+/g, " ").toLowerCase();
        const prop: Record<string, string> = {};
        for (const it of order?.items ?? []) {
          const m = mats.find((x) => x.id === it.materialId) ?? mats.find((x) => norm(x.name) === norm(it.product ?? ""));
          prop[it.id] = m?.id ?? "";
        }
        setReceiveMat(prop);
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, [authLoading, authFetch, receiveWarehouse, order?.items]);

  // Las órdenes de servicio no traen material: no piden bodega ni mueven stock.
  const llevaBodega = order?.kind !== "servicio";
  const canReceive = useMemo(() => {
    if (!order) return false;
    if (["recibido", "finalizado", "cancelado", "anulado"].includes(order.status)) return false;
    // Órdenes del flujo nuevo: recibir solo después de aprobar.
    if (order.approval?.awaiting) return false;
    return true;
  }, [order]);
  const saldo = useMemo(() => order ? Math.max(0, (order.total ?? 0) - (order.paid ?? 0)) : 0, [order]);

  function openPay() {
    setPayAmount(String(saldo || ""));
    setPayDate(new Date().toISOString().slice(0, 10));
    setPayDesc("");
    setPayFile(null);
    setPayOpen(true);
    void authFetch("/treasury/cash-accounts").then((r) => (r.ok ? r.json() : [])).then((a) => { setCashAccounts(a); if (a[0]) setPayCash(String(a[0].id)); }).catch(() => {});
  }

  async function submitPay() {
    const amount = Number(payAmount) || 0;
    if (amount <= 0) { toast("Ingresa un monto mayor a cero", "alert-triangle"); return; }
    if (!payDate) { toast("Indica la fecha del pago", "alert-triangle"); return; }
    setPaying(true);
    try {
      const res = await authFetch(`/orders/${id}/pay`, {
        method: "POST",
        body: JSON.stringify({
          amount, method: payMethod,
          cashAccountId: payCash ? Number(payCash) : undefined,
          accountName: cashAccounts.find((c) => String(c.id) === payCash)?.name,
          date: payDate || undefined,
          // El servidor le antepone el N° de orden: aquí va sólo el motivo.
          note: payDesc.trim() || undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo registrar el pago");
      // Crear -> adjuntar (el mismo patrón del egreso y de la transferencia): el pago
      // devuelve el id del movimiento y el soporte se cuelga de él. Si falla la subida
      // el pago YA está hecho, así que se avisa sin tumbar nada — el comprobante se
      // puede volver a subir desde la fila del pago.
      if (payFile && d.transactionId) {
        try {
          const fd = new FormData();
          fd.append("file", payFile);
          const up = await authFetch(`/treasury/transactions/${d.transactionId}/attach`, { method: "POST", body: fd });
          if (!up.ok) throw new Error((await up.json().catch(() => null))?.message || "No se pudo subir el comprobante");
        } catch (e) {
          toast(mensajeDeError(e, "El pago quedó registrado, pero el comprobante no se subió"), "alert-triangle");
        }
      }
      toast(`Pago registrado · saldo ${cop(d.balance)}`, "check");
      setPayOpen(false); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setPaying(false); }
  }

  function openNote() {
    setNoteType("Retencion"); setNoteRetType("Retefuente Servicios"); setNoteAmount(""); setNoteDesc("");
    setNoteOpen(true);
  }

  async function submitNote() {
    const amount = Number(noteAmount) || 0;
    if (amount <= 0) { toast("Ingresa un monto mayor a cero", "alert-triangle"); return; }
    // La observación es obligatoria: la nota cambia el total de la orden y sin el
    // porqué queda un ajuste de plata sin explicación.
    if (noteDesc.trim().length < 5) { toast("Escribe la observación: por qué se aplica esta nota", "alert-triangle"); return; }
    setNotesaving(true);
    try {
      const body: any = { type: noteType, amount, description: noteDesc.trim() };
      if (noteType === "Retencion") body.retentionType = noteRetType;
      const res = await authFetch(`/orders/${id}/notes`, { method: "POST", body: JSON.stringify(body) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo agregar la nota");
      toast(`Nota aplicada · nuevo total ${cop(d.total)}`, "check");
      setNoteOpen(false); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setNotesaving(false); }
  }

  async function removeNote(noteId: string) {
    setConfirmBusy(true);
    try {
      const res = await authFetch(`/orders/${id}/notes/${noteId}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo eliminar la nota");
      toast(`Nota eliminada · nuevo total ${cop(d.total)}`, "check");
      void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
    finally { setConfirmBusy(false); setConfirmar(null); }
  }

  const submitReceive = async () => {
    setSaving(true);
    try {
      const items = (order?.items ?? []).map((it: any) => ({ itemId: it.id, received: Number(receive[it.id]) || 0 }));
      const sube = (order?.items ?? []).some((it: any) => (Number(receive[it.id]) || 0) > (it.received ?? 0));
      if (sube && llevaBodega && !receiveWarehouse) { toast("Escoge la bodega a la que llega el material", "alert-triangle"); setSaving(false); return; }
      const conProducto = items.map((x: any) => (receiveMat[x.itemId] ? { ...x, materialId: receiveMat[x.itemId] } : x));
      const res = await authFetch(`/orders/${id}/receive`, { method: "POST", body: JSON.stringify({ items: conProducto, warehouseId: receiveWarehouse || undefined }) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "Error");
      toast(d?.warehouse ? `Recepción registrada · entró a ${d.warehouse}` : "Recepción registrada");
      await load();
    } catch (e) {
      toast(mensajeDeError(e, "No se pudo registrar la recepción"), "alert-triangle");
    } finally { setSaving(false); }
  };

  /** Acciones del flujo (aprobar / cancelar / finalizar). */
  const flowAction = async (path: string, body?: any, okMsg?: string) => {
    setFlowBusy(true);
    try {
      const res = await authFetch(`/orders/${id}/${path}`, { method: "POST", body: JSON.stringify(body ?? {}) });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo completar la acción");
      toast(okMsg ?? "Listo", "check");
      await load();
      return true;
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); return false; }
    finally { setFlowBusy(false); }
  };

  const aprobar = () => flowAction("approve", {}, "Orden aprobada");

  /**
   * Firma con código: pide el OTP y aprueba con él. No usa `flowAction` porque el
   * error tiene que llegar CRUDO al diálogo ("te quedan 3 intentos") en vez de
   * morir en un toast, y el diálogo se cierra solo si la firma entró.
   */
  const pedirCodigoFirma = useCallback(async () => {
    const res = await authFetch(`/orders/${id}/approve/otp`, { method: "POST" });
    const d = await res.json();
    if (!res.ok) throw new Error(d?.message || "No se pudo enviar el código");
    return d;
  }, [authFetch, id]);

  const firmarAprobacion = useCallback(async (otp: string) => {
    const res = await authFetch(`/orders/${id}/approve`, { method: "POST", body: JSON.stringify({ otp }) });
    const d = await res.json();
    if (!res.ok) throw new Error(Array.isArray(d?.message) ? d.message[0] : d?.message || "No se pudo aprobar");
    toast(d?.needsSecond ? "1ª firma registrada · falta la segunda" : "Orden aprobada", "check");
    await load();
  }, [authFetch, id, load]);

  const cancelar = async () => {
    setConfirmBusy(true);
    const ok = await flowAction("cancel", { reason: cancelReason.trim() || undefined }, "Orden cancelada");
    setConfirmBusy(false);
    if (ok) { setConfirmar(null); setCancelReason(""); }
  };
  const finalizar = async () => {
    setConfirmBusy(true);
    const ok = await flowAction("finalize", {}, "Orden finalizada");
    setConfirmBusy(false);
    if (ok) setConfirmar(null);
  };

  const abrirPdf = async () => {
    try {
      const res = await authFetch(`/orders/${id}/pdf`);
      if (!res.ok) throw new Error("No se pudo generar el PDF");
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank");
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
  };

  const abrirEditar = () => {
    const filas = (order?.items ?? []).map((it: any) => ({ product: it.product ?? "", qty: String(it.qty), price: String(it.price), taxRate: String(it.taxRate ?? 0) }));
    setEditRows(filas);
    setEditRowsIniciales(JSON.stringify(filas));
    setEditStatus(order?.status ?? "");
    setEditDate(order?.date ? String(order.date).slice(0, 10) : "");
    setEditDue(order?.dueDate ? String(order.dueDate).slice(0, 10) : "");
    setEditNotes(order?.notes ?? "");
    const c = order?.consignment;
    setEditDestino({ warehouseId: order?.warehouse?.id ?? "", branch: order?.branchRef ?? "" });
    setEditConsig({ payBank: c?.bank ?? "", payAccountType: c?.accountType ?? "", payAccount: c?.account ?? "", payHolder: c?.holder ?? "", payHolderDoc: c?.holderDoc ?? "" });
    setEditOpen(true);
  };

  const guardarEdicion = async () => {
    const items = editRows
      .filter((r) => r.product.trim() && Number(r.qty) > 0)
      .map((r) => ({ product: r.product.trim(), qty: Number(r.qty), price: Number(r.price) || 0, taxRate: Number(r.taxRate) || 0 }));
    if (!items.length) { toast("La orden necesita al menos un ítem", "alert-triangle"); return; }
    const itemsTocados = JSON.stringify(editRows) !== editRowsIniciales;
    setEditSaving(true);
    try {
      const res = await authFetch(`/orders/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          items: itemsTocados ? items : undefined,
          orderDate: editDate || undefined, dueDate: editDue || undefined, notes: editNotes,
          ...editConsig,
          // Solo si cambió: una orden vieja sin sede no se obliga a tenerla para editar otra cosa.
          ...(editDestino.warehouseId !== (order?.warehouse?.id ?? "") ? { warehouseId: editDestino.warehouseId } : {}),
          ...(editDestino.branch !== (order?.branchRef ?? "") ? { branch: editDestino.branch } : {}),
          status: isSuperadmin && editStatus && editStatus !== order?.status ? editStatus : undefined,
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo guardar");
      toast("Orden actualizada", "check");
      setEditOpen(false); void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setEditSaving(false); }
  };

  /**
   * Sube un adjunto de la orden y, si se indicó un pago, lo deja además como
   * comprobante de ESE EGRESO en tesorería.
   *
   * El soporte de un pago se sube una sola vez: aquí. Antes había que cargarlo dos
   * veces —en la orden y otra vez en el movimiento de caja— para que se viera en los
   * dos sitios. Se manda el mismo fichero a los dos endpoints (el patrón de las dos
   * patas de la transferencia); el egreso es *best-effort*: si esa segunda subida
   * falla, el adjunto de la orden YA está y sólo se avisa.
   */
  const subirAdjunto = async (file: File, pagoId?: string) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await authFetch(`/orders/${id}/files`, { method: "POST", body: fd });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo subir el archivo");
      if (pagoId) {
        try {
          const fdTx = new FormData();
          fdTx.append("file", file);
          const up = await authFetch(`/treasury/transactions/${pagoId}/attach`, { method: "POST", body: fdTx });
          if (!up.ok) throw new Error((await up.json().catch(() => null))?.message || "No se pudo cargar el comprobante en el egreso");
          toast(`Adjunto subido: ${d.name} · cargado también en el egreso`, "check");
        } catch (e) {
          toast(mensajeDeError(e, "El adjunto quedó en la orden, pero no se cargó en el egreso"), "alert-triangle");
        }
      } else {
        toast(`Adjunto subido: ${d.name}`, "check");
      }
      void load();
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setUploading(false); }
  };

  /** Pagos a los que se les puede colgar un soporte (una anulada ya no se soporta). */
  const pagosConSoporte = useMemo(
    () => ((order?.payments ?? []) as any[]).filter((p) => p.status !== "ANULADA"),
    [order],
  );

  /** ¿El fichero sirve como comprobante de caja? Allá sólo entran imagen o PDF. */
  const esComprobante = (f: File) =>
    f.type.startsWith("image/") || f.type === "application/pdf" || /\.pdf$/i.test(f.name);

  /**
   * Al elegir el fichero se pregunta a dónde va: sólo a la orden (cotización, factura
   * del proveedor) o también al egreso del pago. Si la orden no tiene pagos, o el
   * fichero no puede ser un comprobante (un .xlsx, un .zip), no hay nada que preguntar.
   */
  const elegirAdjunto = (file: File) => {
    if (pagosConSoporte.length === 0 || !esComprobante(file)) { void subirAdjunto(file); return; }
    setAdjuntoPago(pagosConSoporte.find((p) => !p.attach)?.id ?? "");
    setAdjuntoPendiente(file);
  };

  const verAdjunto = async (f: any) => {
    try {
      const res = await authFetch(`/orders/${id}/files/${f.id}/download`);
      if (!res.ok) throw new Error("No se pudo descargar");
      const blob = await res.blob();
      window.open(URL.createObjectURL(blob), "_blank");
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); }
  };

  const borrarAdjunto = async (f: any) => {
    setConfirmBusy(true);
    try {
      const res = await authFetch(`/orders/${id}/files/${f.id}`, { method: "DELETE" });
      const d = await res.json();
      if (!res.ok) throw new Error(d?.message || "No se pudo eliminar");
      toast("Adjunto eliminado", "check");
      void load();
      setConfirmar(null);
    } catch (e) { toast(mensajeDeError(e), "alert-triangle"); } finally { setConfirmBusy(false); }
  };

  if (authLoading || loading) return <PageSkeleton />;

  if (!order) {
    return (
      <>
        <Link href="/ordenes" className="inline-flex items-center gap-1 text-[13px] font-semibold text-text-secondary hover:text-brand">
          <Icon name="arrow-left" size={15} /> Órdenes
        </Link>
        <div className="rounded-xl border border-dashed border-border-subtle bg-surface p-10 text-center text-[13px] text-text-tertiary">No se encontró la orden.</div>
      </>
    );
  }

  const isCompra = order.kind === "compra";
  const aprob = order.approval ?? {};
  const terminal = ["cancelado", "anulado", "finalizado"].includes(order.status);
  const awaiting = !!aprob.awaiting; // orden nueva sin aprobar: pagar/recibir bloqueados
  const esPendiente = order.status === "pendiente";

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <PageHeading
          icon="receipt"
          title={`Orden ${order.tid}`}
          subtitle={`Creada el ${fmtDate(order.date)}${aprob.createdByName ? ` por ${aprob.createdByName}` : ""}`}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Badge label={isCompra ? "Compra" : "Servicio"} tone={isCompra ? "brand" : "info"} />
          <Badge label={order.status} tone={statusTone(order.status)} />
          <Button variant="secondary" size="sm" onClick={abrirPdf}><Icon name="file-text" size={14} /> PDF</Button>
          {(esPendiente || isSuperadmin) && <Button variant="secondary" size="sm" onClick={abrirEditar}><Icon name="pencil" size={14} /> Editar</Button>}
          {!terminal && <Button variant="secondary" size="sm" onClick={() => setConfirmar({ kind: "cancelar" })}><Icon name="x" size={14} className="text-error-text" /> Cancelar orden</Button>}
          {!terminal && !esPendiente && saldo <= 0 && (
            <Button variant="primary" size="sm" onClick={() => setConfirmar({ kind: "finalizar" })} disabled={flowBusy}><Icon name="check" size={14} /> Finalizar</Button>
          )}
        </div>
      </div>

      {/* Flujo de aprobación: la orden nueva no se paga ni se recibe sin firma(s). */}
      {aprob.enFlujo && !terminal && (
        <div className={`rounded-xl border p-4 shadow-sm ${awaiting ? "border-warning-border bg-warning-soft" : "border-border-subtle bg-surface"}`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <Icon name={awaiting ? "lock" : "check"} size={16} className={awaiting ? "text-warning-text" : "text-success-text"} />
              <div>
                <p className="text-[13px] font-bold text-text-primary">
                  {awaiting
                    ? aprob.firstBy
                      ? "Falta la segunda aprobación"
                      : "Pendiente de aprobación"
                    : "Orden aprobada"}
                </p>
                <p className="text-[12px] text-text-tertiary">
                  {aprob.needsTwo
                    ? `Por su monto (≥ ${cop(aprob.threshold)}) esta orden exige DOS firmas de personas distintas.`
                    : "Esta orden exige una aprobación antes de pagar o recibir."}
                </p>
              </div>
            </div>
            {awaiting && puedeAprobar && (
              <Button variant="primary" size="sm" onClick={() => (aprob.otpRequired ? setFirmarOpen(true) : void aprobar())} disabled={flowBusy}>
                <Icon name={aprob.otpRequired ? "file-signature" : "check"} size={14} />
                {flowBusy ? "Aprobando…" : aprob.firstBy ? "Dar 2ª firma" : aprob.otpRequired ? "Firmar y aprobar" : "Aprobar orden"}
              </Button>
            )}
            {awaiting && !puedeAprobar && (
              <span className="text-[12px] text-text-tertiary">Solo un autorizador de compras puede aprobarla.</span>
            )}
          </div>
          {(aprob.firstBy || aprob.secondBy) && (
            <div className="mt-2 flex flex-wrap gap-4 border-t border-border-subtle pt-2 text-[12px] text-text-secondary">
              {aprob.firstBy && <span><Icon name="check" size={12} className="mr-1 inline text-success-text" />1ª firma: <b>{aprob.firstBy}</b> · {fmtDate(aprob.firstAt)}</span>}
              {aprob.secondBy && <span><Icon name="check" size={12} className="mr-1 inline text-success-text" />2ª firma: <b>{aprob.secondBy}</b> · {fmtDate(aprob.secondAt)}</span>}
            </div>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <h2 className="mb-2 text-[11px] font-semibold uppercase text-text-tertiary">Proveedor</h2>
          <p className="text-[14px] font-bold text-text-primary">{order.supplier?.name ?? "—"}</p>
          <p className="text-[12px] text-text-tertiary">NIT {order.supplier?.nit ?? "—"}</p>
          <p className="text-[12px] text-text-tertiary">Tel. {order.supplier?.phone ?? "—"}</p>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <h2 className="mb-2 text-[11px] font-semibold uppercase text-text-tertiary">Fechas</h2>
          <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Orden</span><span className="text-text-secondary">{fmtDate(order.date)}</span></div>
          <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Vence</span><span className="text-text-secondary">{fmtDate(order.dueDate)}</span></div>
          <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Recibida</span><span className="text-text-secondary">{fmtDate(order.receivedAt)}</span></div>
          <div className="mt-2 flex justify-between gap-2 border-t border-border-subtle pt-2 text-[13px]"><span className="text-text-tertiary">Sede</span><span className={order.branchRef ? "text-text-secondary" : "text-warning-text"}>{order.branchRef || "Sin sede"}</span></div>
          <div className="flex justify-between gap-2 text-[13px]"><span className="text-text-tertiary">Bodega destino</span><span className={order.warehouse || !llevaBodega ? "text-right text-text-secondary" : "text-warning-text"}>{order.warehouse?.title || "Sin bodega"}</span></div>
        </div>
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <h2 className="mb-2 text-[11px] font-semibold uppercase text-text-tertiary">Totales</h2>
          <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Subtotal</span><span className="text-text-secondary">{cop(order.subtotal ?? 0)}</span></div>
          <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">IVA</span><span className="text-text-secondary">{cop(order.tax ?? 0)}</span></div>
          {order.discount ? <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Descuento</span><span className="text-text-secondary">-{cop(order.discount)}</span></div> : null}
          {(order.noteLines ?? []).filter((n: any) => !String(n.type).startsWith("Retención")).map((n: any) => (
            <div key={n.id} className="flex justify-between text-[13px]"><span className="text-text-tertiary">{n.type}</span><span className="text-text-secondary">{n.amount < 0 ? "-" : "+"}{cop(Math.abs(n.amount))}</span></div>
          ))}
          {order.retention > 0 ? <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Retención ({order.retentionType})</span><span className="text-warning-text">-{cop(order.retention)}</span></div> : null}
          <div className="mt-1 flex justify-between border-t border-border-subtle pt-1 text-[14px] font-bold text-text-primary"><span>Total neto</span><span>{cop(order.total ?? 0)}</span></div>
          <div className="mt-1 flex justify-between text-[13px]"><span className="text-text-tertiary">Pagado</span><span className="text-success-text">{cop(order.paid ?? 0)}</span></div>
          <div className="flex justify-between text-[13px]"><span className="text-text-tertiary">Saldo</span><span className={saldo > 0 ? "font-semibold text-error-text" : "text-text-tertiary"}>{cop(saldo)}</span></div>
          {saldo > 0 && !terminal && !awaiting && <Button variant="secondary" size="sm" className="mt-2 w-full" onClick={openPay}><Icon name="hand-coins" size={14} /> Registrar pago</Button>}
          {saldo > 0 && awaiting && <p className="mt-2 text-[11px] text-warning-text">El pago se habilita cuando la orden esté aprobada.</p>}
        </div>
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <h2 className="mb-2 text-[11px] font-semibold uppercase text-text-tertiary">Datos de la consignación</h2>
        {order.consignment ? (
          <>
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 text-[13px] sm:grid-cols-2 lg:grid-cols-3">
              <div className="flex justify-between gap-2"><span className="text-text-tertiary">Banco</span><span className="text-text-primary">{order.consignment.bank || "—"}</span></div>
              <div className="flex justify-between gap-2"><span className="text-text-tertiary">Tipo de cuenta</span><span className="text-text-primary">{order.consignment.accountType || "—"}</span></div>
              <div className="flex justify-between gap-2"><span className="text-text-tertiary">N° de cuenta</span><span className="font-semibold text-text-primary">{order.consignment.account || "—"}</span></div>
              <div className="flex justify-between gap-2"><span className="text-text-tertiary">Titular</span><span className="text-text-primary">{order.consignment.holder || "—"}</span></div>
              <div className="flex justify-between gap-2"><span className="text-text-tertiary">NIT / C.C.</span><span className="text-text-primary">{order.consignment.holderDoc || "—"}</span></div>
            </div>
            {order.consignment.fromSupplier && <p className="mt-2 text-[11px] text-text-tertiary">Esta orden no guardó cuenta: se muestra la que el proveedor tiene hoy.</p>}
          </>
        ) : (
          <p className="text-[12px] text-text-tertiary">Sin datos de consignación. Se agregan con Editar.</p>
        )}
      </div>

      {order.notes ? (
        <div className="rounded-xl border border-border-subtle bg-surface p-4 text-[13px] text-text-secondary shadow-sm">
          <span className="mb-1 block text-[11px] font-semibold uppercase text-text-tertiary">Nota</span>
          {order.notes}
        </div>
      ) : null}

      <div>
        <h2 className="mb-2 text-[13px] font-bold text-text-primary">Ítems</h2>
        <DataTable
          rows={order.items ?? []}
          empty="La orden no tiene ítems."
          columns={[
            { key: "product", header: "Producto", render: (r: any) => <span className="font-medium text-text-primary">{r.product}</span> },
            { key: "qty", header: "Cant.", align: "right", render: (r: any) => r.qty },
            { key: "price", header: "Precio", align: "right", render: (r: any) => cop(r.price) },
            { key: "subtotal", header: "Subtotal", align: "right", render: (r: any) => cop(r.subtotal ?? 0) },
            { key: "received", header: "Recibido", align: "right", render: (r: any) => <span className="text-text-secondary">{r.received ?? 0} / {r.qty}</span> },
          ]}
        />
      </div>

      {/* Pagos: los egresos que ha generado esta orden, con su soporte.
          El comprobante NO se guarda como adjunto de la orden — vive en el movimiento
          de caja, que es el sitio donde tesorería lo revisa. Subirlo desde aquí lo deja
          puesto en los dos sitios de una sola vez. */}
      <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-[13px] font-bold text-text-primary"><Icon name="hand-coins" size={16} /> Pagos</h2>
          {saldo > 0 && !terminal && !awaiting && <Button variant="secondary" size="sm" onClick={openPay}><Icon name="plus" size={14} /> Registrar pago</Button>}
        </div>
        <DataTable
          rows={order.payments ?? []}
          empty="Esta orden todavía no tiene pagos registrados."
          columns={[
            { key: "date", header: "Fecha", render: (r: any) => fmtDate(r.date) },
            { key: "amount", header: "Monto", align: "right", render: (r: any) => <span className="font-semibold text-text-primary">{cop(r.amount)}</span> },
            { key: "method", header: "Método", render: (r: any) => (r.method === "Bank" ? "Consignación" : r.method === "Cash" ? "Efectivo" : (r.method ?? "—")) },
            { key: "account", header: "Caja / cuenta", render: (r: any) => r.account || "—" },
            { key: "note", header: "Descripción", render: (r: any) => <span className="text-text-secondary">{r.note || "—"}</span> },
            { key: "status", header: "Estado", render: (r: any) => (r.status === "ANULADA" ? <Badge tone="error" label="Anulada" /> : <Badge tone="success" label="Vigente" />) },
            {
              key: "comprobante", header: "Comprobante",
              render: (r: any) => <ComprobanteCell id={r.id} attach={r.attach} attachName={r.attachName} onChange={() => void load()} />,
            },
          ]}
        />
      </div>

      <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-[13px] font-bold text-text-primary"><Icon name="file-text" size={16} /> Notas y retenciones</h2>
          <Button variant="secondary" size="sm" onClick={openNote}><Icon name="plus" size={14} /> Agregar nota</Button>
        </div>
        {(order.noteLines ?? []).length === 0 ? (
          <p className="text-[12px] text-text-tertiary">
            Sin notas ni retenciones. Usa «Agregar nota» para registrar una nota crédito/débito o una retención (ReteFuente/ReteICA).
          </p>
        ) : (
          <div className="flex flex-col gap-2">
            {(order.noteLines ?? []).map((n: any) => (
              <div key={n.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle px-3 py-2">
                <div className="min-w-0 flex-1">
                  <span className="text-[13px] font-medium text-text-primary">{n.type}</span>
                  {n.description ? <span className="ml-2 text-[12px] text-text-tertiary">{n.description}</span> : null}
                </div>
                <span className={`text-[13px] font-semibold ${n.amount < 0 ? "text-warning-text" : "text-text-secondary"}`}>{n.amount < 0 ? "-" : "+"}{cop(Math.abs(n.amount))}</span>
                {<button onClick={() => setConfirmar({ kind: "borrar-nota", nota: n })} className="tap text-text-tertiary hover:text-error-text" title="Eliminar nota"><Icon name="trash" size={15} /></button>}
              </div>
            ))}
          </div>
        )}
      </div>

      {canReceive && (
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <h2 className="mb-3 flex items-center gap-1.5 text-[13px] font-bold text-text-primary">
            <Icon name="package" size={16} /> Recibir
          </h2>
          {llevaBodega && (
            <div className="mb-3 sm:max-w-sm">
              <DestinoCampos value={{ warehouseId: receiveWarehouse, branch: order.branchRef ?? "" }} onChange={(v) => setReceiveWarehouse(v.warehouseId)} requireWarehouse destinos={destinos} soloBodega />
              {!order.warehouse && <p className="mt-1 text-[11px] text-warning-text">La orden no tenía bodega destino: la que escojas queda guardada en ella.</p>}
            </div>
          )}
          <div className="flex flex-col gap-2">
            {(order.items ?? []).map((it: any) => (
              <div key={it.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border-subtle px-3 py-2">
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="text-[13px] font-medium text-text-primary">{it.product}</span>
                  {llevaBodega && receiveWarehouse && (Number(receive[it.id]) || 0) > (it.received ?? 0) && (
                    <Select
                      className="max-w-md"
                      aria-label={`Producto de la bodega para ${it.product}`}
                      value={receiveMat[it.id] ?? ""}
                      onChange={(e) => setReceiveMat((p) => ({ ...p, [it.id]: e.target.value }))}
                    >
                      <option value="">Crear «{it.product}» como producto nuevo</option>
                      {bodegaMats.map((m) => <option key={m.id} value={m.id}>Sumar a: {m.name}{m.code ? ` · ${m.code}` : ""} (hay {m.qty})</option>)}
                    </Select>
                  )}
                </span>
                <span className="text-[12px] text-text-tertiary">de {it.qty}</span>
                <Input
                  type="number"
                  min={0}
                  max={it.qty}
                  className="w-24 text-right"
                  value={receive[it.id] ?? "0"}
                  onChange={(e) => setReceive((prev) => ({ ...prev, [it.id]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <Button variant="primary" onClick={submitReceive} disabled={saving}>
              <Icon name="check" size={15} /> {saving ? "Registrando…" : "Registrar recepción"}
            </Button>
          </div>
        </div>
      )}

      {/* Adjuntos: factura del proveedor, cotizaciones, soportes. */}
      <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="flex items-center gap-1.5 text-[13px] font-bold text-text-primary"><Icon name="paperclip" size={16} /> Adjuntos</h2>
          <label className={`inline-flex cursor-pointer items-center gap-1 rounded-lg border border-border-default px-3 py-1.5 text-[12px] font-semibold text-text-secondary hover:bg-surface-2 ${uploading ? "pointer-events-none opacity-60" : ""}`}>
            <Icon name={uploading ? "loader" : "upload"} size={14} className={uploading ? "animate-spin" : ""} />
            {uploading ? "Subiendo…" : "Subir archivo"}
            <input type="file" className="hidden" accept={ACCEPT_ADJUNTO}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) elegirAdjunto(f); e.target.value = ""; }} />
          </label>
        </div>
        {(order.files ?? []).length === 0 ? (
          <p className="text-[12px] text-text-tertiary">Sin adjuntos. Suba aquí la factura del proveedor, la cotización o el soporte de un pago: si es de un pago, se carga también como comprobante del egreso en tesorería y no hay que volver a subirlo allá.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {(order.files ?? []).map((f: any) => (
              <div key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border-subtle px-3 py-2">
                <button onClick={() => void verAdjunto(f)} className="min-w-0 flex-1 truncate text-left text-[13px] font-medium text-brand hover:underline">{f.name}</button>
                <span className="text-[11px] text-text-tertiary">{(f.size / 1024).toFixed(0)} KB · {f.by ?? "—"} · {fmtDate(f.at)}</span>
                {<button onClick={() => setConfirmar({ kind: "borrar-adjunto", file: f })} className="tap text-text-tertiary hover:text-error-text" title="Eliminar adjunto"><Icon name="trash" size={15} /></button>}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Bitácora: rastro de quién hizo qué con la orden. */}
      {(order.events ?? []).length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-surface p-4 shadow-sm">
          <h2 className="mb-3 flex items-center gap-1.5 text-[13px] font-bold text-text-primary"><Icon name="clock" size={16} /> Bitácora</h2>
          <div className="flex flex-col gap-1.5">
            {(order.events ?? []).map((e: any) => (
              <div key={e.id} className="flex flex-wrap items-baseline gap-x-2 border-b border-border-subtle pb-1.5 text-[12px] last:border-b-0">
                <span className="font-semibold text-text-primary">{e.action}</span>
                {e.to && <span className="text-text-tertiary">{e.from ? `${e.from} → ` : ""}{e.to}</span>}
                {e.detail && <span className="min-w-0 text-text-secondary">{e.detail}</span>}
                <span className="ml-auto whitespace-nowrap text-text-tertiary">{e.user ?? "—"} · {new Date(e.at).toLocaleString("es-CO")}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Firma de la aprobación: el código llega al WhatsApp del autorizador. */}
      <FirmaOtpModal
        open={firmarOpen}
        onClose={() => setFirmarOpen(false)}
        titulo={aprob.firstBy ? "Firmar la 2ª aprobación" : "Firmar la aprobación"}
        textoBoton={aprob.firstBy ? "Dar 2ª firma" : "Aprobar orden"}
        queFirma={
          <>
            Orden <b>{order.tid}</b> · {order.supplier?.name ?? "sin proveedor"} · <b>{cop(order.total)}</b>
          </>
        }
        solicitar={pedirCodigoFirma}
        firmar={firmarAprobacion}
      />

      {/* Editar orden (pendiente, o en cualquier estado si es superusuario): cabecera + ítems. */}
      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={`Editar orden ${order.tid}`} maxWidth="max-w-3xl">
        {!esPendiente && (
          <p className="mb-3 rounded-md bg-warning-soft px-3 py-2 text-[12px] text-warning-text">
            Esta orden está <b>{order.status}</b>. La está corrigiendo como superusuario: las firmas de
            aprobación y lo ya recibido se conservan, y el cambio queda en el historial de la orden.
          </p>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Fecha de la orden"><Input type="date" value={editDate} onChange={(e) => setEditDate(e.target.value)} /></Field>
          <Field label="Vence"><Input type="date" value={editDue} onChange={(e) => setEditDue(e.target.value)} /></Field>
          {isSuperadmin && (
            <div className="sm:col-span-2">
              <Field
                label="Estado"
                hint="Solo el superusuario. Cambiarlo aquí NO mueve dinero ni stock: para eso están Aprobar, Registrar pago, Recibir material y Finalizar."
              >
                <Select value={editStatus} onChange={(e) => setEditStatus(e.target.value)}>
                  {ESTADOS_ORDEN.map((e) => <option key={e} value={e}>{e}</option>)}
                </Select>
              </Field>
            </div>
          )}
        </div>
        <div className="mt-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[12px] font-semibold text-text-secondary">Ítems</span>
            <Button variant="secondary" size="sm" onClick={() => setEditRows((p) => [...p, { product: "", qty: "1", price: "0", taxRate: "0" }])}><Icon name="plus" size={13} /> Agregar</Button>
          </div>
          <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pr-1">
            {editRows.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input className="min-w-0 flex-1" placeholder="Descripción" value={r.product} onChange={(e) => setEditRows((p) => p.map((x, idx) => idx === i ? { ...x, product: e.target.value } : x))} />
                <Input type="number" min={0} className="w-20 text-right" title="Cantidad" value={r.qty} onChange={(e) => setEditRows((p) => p.map((x, idx) => idx === i ? { ...x, qty: e.target.value } : x))} />
                <Input type="number" min={0} className="w-28 text-right" title="Precio" value={r.price} onChange={(e) => setEditRows((p) => p.map((x, idx) => idx === i ? { ...x, price: e.target.value } : x))} />
                <Input type="number" min={0} className="w-20 text-right" title="IVA %" value={r.taxRate} onChange={(e) => setEditRows((p) => p.map((x, idx) => idx === i ? { ...x, taxRate: e.target.value } : x))} />
                <button onClick={() => setEditRows((p) => p.length > 1 ? p.filter((_, idx) => idx !== i) : p)} className="tap text-text-tertiary hover:text-error-text" aria-label="Quitar"><Icon name="x" size={15} /></button>
              </div>
            ))}
          </div>
        </div>
        <div className="mt-3">
          <span className="mb-2 block text-[12px] font-semibold text-text-secondary">Destino</span>
          <DestinoCampos value={editDestino} onChange={setEditDestino} requireWarehouse={llevaBodega} destinos={destinos} />
        </div>
        <div className="mt-3">
          <span className="mb-2 block text-[12px] font-semibold text-text-secondary">Datos de la consignación</span>
          <ConsignacionCampos value={editConsig} onChange={setEditConsig} />
        </div>
        <div className="mt-3"><Field label="Nota"><Textarea rows={2} value={editNotes} onChange={(e) => setEditNotes(e.target.value)} /></Field></div>
        {esPendiente && <p className="mt-2 text-[12px] text-text-tertiary">Al editar los ítems, cualquier firma de aprobación previa se reinicia (lo firmado ya no es lo mismo).</p>}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setEditOpen(false)} disabled={editSaving}>Cancelar</Button>
          <Button variant="primary" onClick={guardarEdicion} disabled={editSaving}>{editSaving ? "Guardando…" : "Guardar cambios"}</Button>
        </div>
      </Modal>

      <Modal open={payOpen} onClose={() => setPayOpen(false)} title="Registrar pago a proveedor" maxWidth="max-w-md">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Monto" required><Input type="number" min={0} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} autoFocus /></Field>
          <Field label="Método"><Select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}><option value="Cash">Efectivo</option><option value="Bank">Consignación</option></Select></Field>
          <Field label="Fecha del pago" required>
            <Input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} />
          </Field>
          <Field label="Caja / cuenta">
            <Select value={payCash} onChange={(e) => setPayCash(e.target.value)}>
              <option value="">— Sin caja —</option>
              {cashAccounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </Select>
          </Field>
          <div className="sm:col-span-2">
            <Field label="Descripción" hint="Por qué se paga. Queda en el movimiento de caja y en el historial de la orden.">
              <Textarea rows={2} value={payDesc} onChange={(e) => setPayDesc(e.target.value)} placeholder="Ej.: abono acordado con el proveedor, saldo contra entrega…" />
            </Field>
          </div>
          <div className="sm:col-span-2">
            <Field label="Comprobante (opcional)" hint="Imagen o PDF del soporte. Queda en el egreso de tesorería: no hay que volver a subirlo allá.">
              <Input type="file" accept={ACCEPT_IMAGEN_PDF} onChange={(e) => setPayFile(e.target.files?.[0] ?? null)} />
            </Field>
          </div>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setPayOpen(false)} disabled={paying}>Cancelar</Button>
          <Button variant="primary" onClick={submitPay} disabled={paying}>{paying ? "Guardando…" : "Registrar pago"}</Button>
        </div>
      </Modal>

      {/* ¿Este archivo es el soporte de un pago? Se pregunta —en vez de decidirlo solo—
          porque en Adjuntos también entran cotizaciones y facturas del proveedor, y un
          comprobante equivocado sale luego en el cierre de caja. */}
      <Modal open={!!adjuntoPendiente} onClose={() => setAdjuntoPendiente(null)} title="¿Dónde va este archivo?" maxWidth="max-w-md">
        <p className="truncate text-[13px] font-medium text-text-primary"><Icon name="paperclip" size={14} className="mr-1 inline" />{adjuntoPendiente?.name}</p>
        <div className="mt-3 flex flex-col gap-2">
          <label className={`flex cursor-pointer gap-2 rounded-lg border p-3 ${adjuntoPago === "" ? "border-brand bg-surface-2" : "border-border-subtle"}`}>
            <input type="radio" name="destino-adjunto" className="mt-0.5" checked={adjuntoPago === ""} onChange={() => setAdjuntoPago("")} />
            <span>
              <span className="block text-[13px] font-semibold text-text-primary">Solo adjunto de la orden</span>
              <span className="block text-[12px] text-text-tertiary">Factura del proveedor, cotización, remisión…</span>
            </span>
          </label>
          {pagosConSoporte.map((p: any) => (
            <label key={p.id} className={`flex cursor-pointer gap-2 rounded-lg border p-3 ${adjuntoPago === p.id ? "border-brand bg-surface-2" : "border-border-subtle"}`}>
              <input type="radio" name="destino-adjunto" className="mt-0.5" checked={adjuntoPago === p.id} onChange={() => setAdjuntoPago(p.id)} />
              <span>
                <span className="block text-[13px] font-semibold text-text-primary">Soporte del pago del {fmtDate(p.date)} · {cop(p.amount)}</span>
                <span className="block text-[12px] text-text-tertiary">
                  {p.method === "Bank" ? "Consignación" : p.method === "Cash" ? "Efectivo" : (p.method ?? "—")}{p.account ? ` · ${p.account}` : ""}
                  {p.attach ? " · ya tiene comprobante: se reemplaza" : ""}
                </span>
              </span>
            </label>
          ))}
        </div>
        <p className="mt-2 text-[12px] text-text-tertiary">Si eliges un pago, el archivo queda en la orden <strong>y</strong> como comprobante de su egreso en tesorería. Se sube una sola vez.</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setAdjuntoPendiente(null)} disabled={uploading}>Cancelar</Button>
          <Button variant="primary" disabled={uploading} onClick={() => { const f = adjuntoPendiente; const pago = adjuntoPago; setAdjuntoPendiente(null); if (f) void subirAdjunto(f, pago || undefined); }}>
            {uploading ? "Subiendo…" : "Subir archivo"}
          </Button>
        </div>
      </Modal>

      <Modal open={noteOpen} onClose={() => setNoteOpen(false)} title="Agregar nota / retención" maxWidth="max-w-md">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Tipo" required>
            <Select value={noteType} onChange={(e) => setNoteType(e.target.value)}>
              <option value="Nota Credito">Nota Crédito (descuento)</option>
              <option value="Nota Debito">Nota Débito (aumento)</option>
              <option value="Retencion">Retención</option>
            </Select>
          </Field>
          {noteType === "Retencion" && (
            <Field label="Tipo de retención" required>
              <Select value={noteRetType} onChange={(e) => setNoteRetType(e.target.value)}>
                <option value="Retefuente Servicios">Retefuente Servicios</option>
                <option value="Compras">Compras</option>
                <option value="Personas no declarantes">Personas no declarantes</option>
                <option value="Reteiva">Reteiva</option>
              </Select>
            </Field>
          )}
          <Field label="Monto" required><Input type="number" min={0} value={noteAmount} onChange={(e) => setNoteAmount(e.target.value)} autoFocus /></Field>
          <div className="sm:col-span-2"><Field label="Observación (por qué se aplica)" required><Input value={noteDesc} onChange={(e) => setNoteDesc(e.target.value)} maxLength={500} placeholder="Ej.: descuento pactado con el proveedor por faltante en la entrega" /></Field></div>
        </div>
        <p className="mt-2 text-[12px] text-text-tertiary">Crédito y retención <strong>restan</strong> del total; débito <strong>suma</strong>. El total no puede quedar por debajo de lo ya pagado.</p>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setNoteOpen(false)} disabled={notesaving}>Cancelar</Button>
          <Button variant="primary" onClick={submitNote} disabled={notesaving || noteDesc.trim().length < 5}>{notesaving ? "Guardando…" : "Aplicar nota"}</Button>
        </div>
      </Modal>

      {confirmar?.kind === "cancelar" && (
        <ConfirmDialog
          open
          busy={confirmBusy}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void cancelar()}
          tone="danger"
          icon="x"
          title={`Cancelar la orden ${order.tid}`}
          confirmLabel="Cancelar orden"
          message={<>La orden queda <b>cancelada</b> y no admite pagos, recepciones ni notas. Solo se puede cancelar una orden sin pagos y sin material recibido.</>}
          detail={
            <Field label="Motivo (queda en la bitácora)">
              <Input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="Opcional" />
            </Field>
          }
        />
      )}

      {confirmar?.kind === "finalizar" && (
        <ConfirmDialog
          open
          busy={confirmBusy}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void finalizar()}
          icon="check"
          title={`Finalizar la orden ${order.tid}`}
          confirmLabel="Finalizar"
          message={<>Cierra el ciclo de la orden: exige <b>saldo en cero</b> y, en compras, todo el material recibido. Una orden finalizada ya no se modifica.</>}
        />
      )}

      {confirmar?.kind === "borrar-adjunto" && (
        <ConfirmDialog
          open
          busy={confirmBusy}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void borrarAdjunto(confirmar.file)}
          tone="danger"
          icon="trash"
          title="Eliminar adjunto"
          confirmLabel="Eliminar"
          message={<>Se elimina <b>{confirmar.file.name}</b> de la orden. El archivo no se puede recuperar.</>}
        />
      )}

      {confirmar?.kind === "borrar-nota" && (
        <ConfirmDialog
          open
          busy={confirmBusy}
          onClose={() => setConfirmar(null)}
          onConfirm={() => void removeNote(confirmar.nota.id)}
          tone="danger"
          icon="trash"
          title="Eliminar nota de la orden"
          confirmLabel="Eliminar nota"
          message={
            <>
              La línea se quita de la orden y el <b>total neto se recalcula</b>: el saldo pendiente
              con el proveedor cambia. El total no puede quedar por debajo de lo ya pagado.
            </>
          }
          detail={
            <div className="rounded-lg border border-border-subtle bg-surface-2 p-2.5">
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12px]">
                <dt className="text-text-tertiary">Tipo</dt>
                <dd className="text-right text-text-primary">{confirmar.nota.type}</dd>
                {confirmar.nota.description ? (
                  <>
                    <dt className="text-text-tertiary">Descripción</dt>
                    <dd className="min-w-0 break-words text-right text-text-primary">{confirmar.nota.description}</dd>
                  </>
                ) : null}
                <dt className="text-text-tertiary">Importe</dt>
                <dd className="text-right font-mono text-text-primary">{confirmar.nota.amount < 0 ? "-" : "+"}{cop(Math.abs(confirmar.nota.amount))}</dd>
                <dt className="text-text-tertiary">Total actual</dt>
                <dd className="text-right font-mono text-text-primary">{cop(order.total ?? 0)}</dd>
              </dl>
            </div>
          }
        />
      )}
    </>
  );
}
