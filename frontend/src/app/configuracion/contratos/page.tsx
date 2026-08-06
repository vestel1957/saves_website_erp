"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Icon } from "@/components/Icon";
import { Field, Input } from "@/components/ui/Field";
import { DataTable } from "@/components/ui/DataTable";
import { Modal } from "@/components/Modal";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { cop } from "@/lib/subscribers";
import { mensajeDeError } from "@/lib/errores";

/**
 * Cláusulas de permanencia mínima del contrato.
 *
 * Cada cláusula es una promesa impresa: "si se retira en el mes 4 paga $191.989".
 * Por eso la tabla de valores se edita entera y no por partes, y por eso una
 * cláusula que ya está en contratos firmados no se puede borrar —solo desactivar—:
 * el contrato del cliente tiene que seguir pudiendo imprimirse igual que el día
 * que lo firmó.
 */

type Clausula = {
  id: string;
  legacyId: number | null;
  nombre: string;
  meses: number;
  vTotal: number;
  valores: number[];
  activa: boolean;
  abonados: number;
  delLegacy: boolean;
};

/** Desmonte lineal: del total a cero en N meses, que es como están hechas las del legacy. */
function sugerirValores(vTotal: number, meses: number): number[] {
  if (!meses) return [];
  return Array.from({ length: meses }, (_, i) => Math.round((vTotal * (meses - i)) / meses));
}

function ClausulaModal({
  open,
  onClose,
  inicial,
  onSaved,
}: {
  open: boolean;
  onClose: () => void;
  inicial: Clausula | null;
  onSaved: () => void;
}) {
  const { authFetch } = useAuth();
  const [nombre, setNombre] = useState("");
  const [meses, setMeses] = useState(12);
  const [vTotal, setVTotal] = useState(0);
  const [valores, setValores] = useState<number[]>([]);
  const [guardando, setGuardando] = useState(false);

  useEffect(() => {
    if (!open) return;
    setNombre(inicial?.nombre ?? "");
    setMeses(inicial?.meses ?? 12);
    setVTotal(inicial?.vTotal ?? 0);
    setValores(inicial?.valores ?? []);
  }, [open, inicial]);

  // Al cambiar los meses la tabla tiene que tener esa longitud exacta: el backend
  // la rechaza si no cuadra, y un mes de más o de menos es una cifra sin pactar.
  useEffect(() => {
    setValores((v) => (v.length === meses ? v : Array.from({ length: meses }, (_, i) => v[i] ?? 0)));
  }, [meses]);

  async function guardar() {
    setGuardando(true);
    try {
      const body = JSON.stringify({ nombre, meses, vTotal, valores });
      const res = await authFetch(inicial ? `/clausulas/${inicial.id}` : "/clausulas", {
        method: inicial ? "PATCH" : "POST",
        body,
      });
      if (!res.ok) {
        const m = await res.json().catch(() => null);
        throw new Error(Array.isArray(m?.message) ? m.message.join(", ") : m?.message);
      }
      toast(inicial ? "Cláusula actualizada" : "Cláusula creada");
      onSaved();
      onClose();
    } catch (e) {
      toast(mensajeDeError(e) ?? "No se pudo guardar", "alert-circle");
    } finally {
      setGuardando(false);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={inicial ? `Editar ${inicial.nombre}` : "Nueva cláusula"} maxWidth="max-w-2xl">
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="sm:col-span-1">
            <Field label="Nombre">
              <Input value={nombre} onChange={(e) => setNombre(e.target.value)} placeholder="Familiar 12 meses" />
            </Field>
          </div>
          <Field label="Meses de permanencia">
            <Input type="number" min={1} max={12} value={meses} onChange={(e) => setMeses(Math.max(1, Math.min(12, Number(e.target.value) || 1)))} />
          </Field>
          <Field label="Cargo por conexión" hint="Lo que se le descuenta o difiere al cliente.">
            <Input type="number" min={0} value={vTotal} onChange={(e) => setVTotal(Number(e.target.value) || 0)} />
          </Field>
        </div>

        <div>
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12px] font-semibold text-text-primary">Valor a pagar si se retira en cada mes</span>
            <Button variant="secondary" className="!py-1 !text-[11px]" onClick={() => setValores(sugerirValores(vTotal, meses))}>
              <Icon name="wand-sparkles" size={13} /> Calcular desmonte lineal
            </Button>
          </div>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
            {valores.map((v, i) => (
              <Field key={i} label={`Mes ${i + 1}`}>
                <Input
                  type="number"
                  min={0}
                  value={v}
                  onChange={(e) => {
                    const n = Number(e.target.value) || 0;
                    setValores((prev) => prev.map((x, k) => (k === i ? n : x)));
                  }}
                />
              </Field>
            ))}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={guardando}>Cancelar</Button>
          <Button onClick={() => void guardar()} disabled={guardando || !nombre.trim()}>
            {guardando ? "Guardando…" : "Guardar"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export default function ClausulasPage() {
  const { authFetch } = useAuth();
  const [rows, setRows] = useState<Clausula[] | null>(null);
  const [editando, setEditando] = useState<Clausula | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [borrar, setBorrar] = useState<Clausula | null>(null);
  const [borrando, setBorrando] = useState(false);

  const cargar = useCallback(() => {
    void authFetch("/clausulas")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then(setRows)
      .catch(() => setRows([]));
  }, [authFetch]);

  useEffect(cargar, [cargar]);

  const conPermanencia = useMemo(() => (rows ?? []).reduce((t, c) => t + c.abonados, 0), [rows]);

  async function alternarActiva(c: Clausula) {
    try {
      const res = await authFetch(`/clausulas/${c.id}`, { method: "PATCH", body: JSON.stringify({ activa: !c.activa }) });
      if (!res.ok) throw new Error();
      cargar();
    } catch {
      toast("No se pudo cambiar", "alert-circle");
    }
  }

  async function eliminar() {
    if (!borrar) return;
    setBorrando(true);
    try {
      const res = await authFetch(`/clausulas/${borrar.id}`, { method: "DELETE" });
      if (!res.ok) {
        const m = await res.json().catch(() => null);
        throw new Error(m?.message);
      }
      toast("Cláusula eliminada");
      cargar();
    } catch (e) {
      toast(mensajeDeError(e) ?? "No se pudo eliminar", "alert-circle");
    } finally {
      setBorrando(false);
      setBorrar(null);
    }
  }

  return (
    <>
      <PageHeading
        icon="file-signature"
        title="Cláusulas de permanencia"
        subtitle="Lo que paga el cliente si termina el contrato antes de tiempo. Se imprime en su contrato."
      />

      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12px] text-text-tertiary">
          {rows?.length ?? 0} cláusulas · {conPermanencia.toLocaleString("es-CO")} abonados con permanencia
        </span>
        <Button onClick={() => { setEditando(null); setAbierto(true); }}>
          <Icon name="plus" size={15} /> Nueva cláusula
        </Button>
      </div>

      <DataTable<Clausula>
        rows={rows ?? []}
        loading={rows === null}
        empty="No hay cláusulas. Crea la primera o impórtalas del legacy con scripts/etl-clausulas.js."
        columns={[
          {
            key: "nombre",
            header: "Cláusula",
            render: (c) => (
              <span className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium text-text-primary">{c.nombre}</span>
                {c.delLegacy && <Badge label="Del legacy" tone="default" />}
                {!c.activa && <Badge label="Inactiva" tone="warning" />}
              </span>
            ),
          },
          { key: "meses", header: "Meses", align: "right", render: (c) => c.meses },
          { key: "vTotal", header: "Cargo por conexión", align: "right", render: (c) => cop(c.vTotal) },
          {
            key: "valores",
            header: "Desmonte",
            render: (c) => (
              <span className="text-[11px] text-text-tertiary">
                {c.valores.length ? `${cop(c.valores[0])} → ${cop(c.valores[c.valores.length - 1])}` : "—"}
              </span>
            ),
          },
          { key: "abonados", header: "Abonados", align: "right", render: (c) => c.abonados.toLocaleString("es-CO") },
          {
            key: "acciones",
            header: "",
            align: "right",
            render: (c) => (
              <span className="flex justify-end gap-1.5">
                <button type="button" title={c.activa ? "Desactivar" : "Activar"} onClick={() => void alternarActiva(c)} className="tap text-text-tertiary hover:text-text-secondary">
                  <Icon name={c.activa ? "toggle-right" : "toggle-left"} size={16} />
                </button>
                <button type="button" title="Editar" onClick={() => { setEditando(c); setAbierto(true); }} className="tap text-text-tertiary hover:text-text-secondary">
                  <Icon name="pencil" size={15} />
                </button>
                <button type="button" title="Eliminar" onClick={() => setBorrar(c)} className="tap text-text-tertiary hover:text-error-text">
                  <Icon name="trash" size={15} />
                </button>
              </span>
            ),
          },
        ]}
      />

      <ClausulaModal open={abierto} onClose={() => setAbierto(false)} inicial={editando} onSaved={cargar} />

      <ConfirmDialog
        open={!!borrar}
        title="Eliminar cláusula"
        message={
          borrar?.abonados
            ? `${borrar.nombre} está en el contrato de ${borrar.abonados} abonado(s): no se puede borrar. Desactívala para dejar de ofrecerla.`
            : `Se eliminará "${borrar?.nombre}". Esta acción no se puede deshacer.`
        }
        confirmLabel="Eliminar"
        busy={borrando}
        onConfirm={() => void eliminar()}
        onClose={() => setBorrar(null)}
      />
    </>
  );
}
