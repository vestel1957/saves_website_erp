"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Field";
import { toast } from "@/components/ui/Toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useAuth } from "@/context/AuthProvider";

type OltOption = { id: string; name: string };
type CatvPort = { portId: number; linkState: string; txPower: string };
type OnuInfo = Record<string, string>;

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3 border-b border-border-subtle py-2 last:border-0">
      <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">{label}</span>
      <span className={`min-w-0 break-all text-right text-[13px] text-text-primary ${mono ? "font-mono text-[12px]" : ""}`}>
        {value}
      </span>
    </div>
  );
}

/**
 * Corte de TV por OLT (OMCI) — para las ONTs combo con salida CATV que NO
 * hablan TR-069 (no aparecen en GenieACS). La palanca es el estado operacional
 * del puerto CATV en la OLT: se busca la ONT por serial y se corta/activa.
 * Las escrituras respetan el gate DRY-RUN/LIVE del módulo OLT y quedan
 * auditadas en su historial.
 */
export function OltCatvModal({
  open,
  onClose,
  initialSn,
  initialOltId,
}: {
  open: boolean;
  onClose: () => void;
  /** Al abrir desde una fila del inventario: serial y OLT ya conocidos → busca solo. */
  initialSn?: string;
  initialOltId?: string;
}) {
  const { authFetch } = useAuth();
  const [olts, setOlts] = useState<OltOption[]>([]);
  const [oltId, setOltId] = useState("");
  const [live, setLive] = useState<boolean | null>(null);
  const [sn, setSn] = useState("");
  const [busy, setBusy] = useState<null | "find" | "set">(null);
  const [onu, setOnu] = useState<OnuInfo | null>(null);
  const [ports, setPorts] = useState<CatvPort[] | null>(null);
  const [confirm, setConfirm] = useState<null | { port: CatvPort; enable: boolean }>(null);
  const [autoDone, setAutoDone] = useState(false);
  // Resultado de un corte/alta aplicado DE VERDAD (no dry-run): pinta el banner
  // grande y dispara el autocierre del modal.
  const [result, setResult] = useState<null | { enable: boolean }>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (closeTimer.current) clearTimeout(closeTimer.current); }, []);

  useEffect(() => {
    if (!open) { setAutoDone(false); return; }
    if (initialSn) setSn(initialSn);
    void (async () => {
      try {
        const [list, mode] = await Promise.all([
          authFetch("/network/olt/olts").then((r) => r.json()),
          authFetch("/network/olt/mode").then((r) => r.json()),
        ]);
        const rows: OltOption[] = Array.isArray(list) ? list : list?.items ?? [];
        setOlts(rows);
        setOltId((prev) => initialOltId || prev || rows[0]?.id || "");
        setLive(!!mode?.live);
      } catch {
        toast("No se pudo cargar la lista de OLTs", "x");
      }
    })();
  }, [open, authFetch, initialSn, initialOltId]);

  const buscar = useCallback(async (snArg?: string) => {
    const serial = (snArg ?? sn).trim();
    if (!oltId || !serial) return;
    setBusy("find");
    setOnu(null);
    setPorts(null);
    try {
      const r = await authFetch(`/network/olt/${oltId}/onu/catv-state`, {
        method: "POST",
        body: JSON.stringify({ sn: serial }),
      }).then((x) => x.json());
      if (!r.ok && !r.onu) {
        toast(r.error || "No se encontró la ONT en la OLT", "x");
        return;
      }
      setOnu(r.onu ?? null);
      setPorts(Array.isArray(r.ports) ? r.ports : null);
      if (r.ok && !r.ports?.length) toast(r.error || "La ONT no reporta puertos CATV", "x");
      else if (r.error) toast(r.error, "x");
    } catch (e) {
      toast((e as Error).message, "x");
    } finally {
      setBusy(null);
    }
  }, [authFetch, oltId, sn]);

  // Abierto desde una fila del inventario: el serial ya viene puesto → buscar solo.
  useEffect(() => {
    if (open && initialSn && oltId && !autoDone) {
      setAutoDone(true);
      void buscar(initialSn);
    }
  }, [open, initialSn, oltId, autoDone, buscar]);

  const aplicar = async () => {
    if (!confirm) return;
    setBusy("set");
    try {
      const r = await authFetch(`/network/olt/${oltId}/onu/catv`, {
        method: "POST",
        body: JSON.stringify({ sn: sn.trim(), catvPort: confirm.port.portId, enable: confirm.enable }),
      }).then((x) => x.json());
      if (r.dryRun) {
        toast("DRY-RUN: comandos planificados, no se tocó la OLT", "check");
      } else if (r.ok) {
        if (Array.isArray(r.ports)) setPorts(r.ports);
        // El backend relee el puerto (con reintentos) hasta que la OLT refleje
        // el cambio. Solo se canta victoria si el LinkState leído coincide.
        const leido = Array.isArray(r.ports) ? r.ports.find((x: CatvPort) => x.portId === confirm.port.portId) : null;
        const confirmado = leido?.linkState === (confirm.enable ? "up" : "down");
        if (confirmado) {
          toast(confirm.enable ? "✅ TV ACTIVADA — confirmado por la OLT" : "🔴 TV CORTADA — confirmado por la OLT", "check");
          // Banner grande + autocierre: no hay nada más que hacer dentro del modal.
          setResult({ enable: confirm.enable });
          closeTimer.current = setTimeout(() => cerrar(), 3500);
        } else {
          toast("El comando entró, pero la OLT aún reporta el estado anterior. Dale Buscar en unos segundos para confirmar.", "x");
        }
      } else {
        toast(r.error || "La OLT rechazó el comando", "x");
      }
    } catch (e) {
      toast((e as Error).message, "x");
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const cerrar = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
    setSn("");
    setOnu(null);
    setPorts(null);
    setResult(null);
    onClose();
  };

  return (
    <Modal open={open} onClose={cerrar} title="Corte de TV por OLT (OMCI)" maxWidth="max-w-xl">
      {result && (
        <div className={`flex items-center gap-3 rounded-xl p-4 ${result.enable ? "bg-success-soft text-success-text" : "bg-error-soft text-error-text"}`}>
          <Icon name={result.enable ? "tv" : "ban"} size={30} className="shrink-0" />
          <div className="min-w-0">
            <p className="text-[16px] font-bold leading-tight">{result.enable ? "TV ACTIVADA" : "TV CORTADA"}</p>
            <p className="text-[13px]">
              El puerto CATV quedó {result.enable ? "encendido" : "apagado"} — confirmado leyendo la OLT.
              Este aviso se cierra solo.
            </p>
          </div>
        </div>
      )}

      <p className="text-[13px] text-text-secondary">
        Para las ONTs combo con salida CATV que <strong>no hablan TR-069</strong> (no aparecen en el
        inventario GenieACS): aquí la palanca es el puerto CATV en la OLT. Busca la ONT por serial.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        {olts.length > 1 && (
          <Select value={oltId} onChange={(e) => setOltId(e.target.value)} className="max-w-[180px]">
            {olts.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </Select>
        )}
        <div className="min-w-0 flex-1">
          <Input
            value={sn}
            onChange={(e) => setSn(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void buscar(); }}
            placeholder="Serial de la ONT (ej. 48575443A87599A6)"
            className="font-mono"
          />
        </div>
        <Button disabled={!!busy || !sn.trim() || !oltId} onClick={() => void buscar()}>
          {busy === "find" ? <Icon name="loader" size={15} className="mr-1 animate-spin" /> : <Icon name="search" size={15} className="mr-1" />}
          Buscar
        </Button>
      </div>

      {live === false && (
        <p className="text-[12px] text-text-tertiary">
          El módulo OLT está en DRY-RUN: el corte devolverá el plan sin aplicar cambios.
        </p>
      )}

      {onu && (
        <div className="rounded-xl border border-border-subtle bg-surface-2/40 px-3.5 py-1">
          <Row label="Posición (F/S/P : ONT)" value={`${onu.fsp ?? "?"} : ${onu.ont_id ?? "?"}`} mono />
          <Row
            label="Estado"
            value={<Badge label={onu.run_state ?? "?"} tone={onu.run_state === "online" ? "success" : "error"} />}
          />
          {onu.description && <Row label="Comentario" value={onu.description} />}
          {onu.last_up && <Row label="Última subida" value={onu.last_up} mono />}
          {onu.last_down && <Row label="Última caída" value={`${onu.last_down}${onu.last_down_cause ? ` (${onu.last_down_cause})` : ""}`} mono />}
        </div>
      )}

      {ports && ports.length > 0 && (
        <div className="rounded-xl border border-border-subtle bg-surface-2/40 px-3.5 py-1">
          {ports.map((p) => {
            const up = p.linkState === "up";
            return (
              <div key={p.portId} className="flex items-center justify-between gap-3 border-b border-border-subtle py-2 last:border-0">
                <span className="flex items-center gap-2 text-[13px] text-text-primary">
                  <Icon name="tv" size={15} className="text-text-tertiary" />
                  Puerto CATV {p.portId}
                  <Badge label={up ? `Encendido · ${p.txPower} dBmV` : "Cortado"} tone={up ? "success" : "error"} />
                </span>
                <Button
                  size="sm"
                  variant={up ? "danger" : "secondary"}
                  disabled={!!busy || !!result}
                  onClick={() => setConfirm({ port: p, enable: !up })}
                >
                  <Icon name={up ? "ban" : "tv"} size={14} className="mr-1" />
                  {up ? "Cortar TV" : "Activar TV"}
                </Button>
              </div>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        busy={busy === "set"}
        title={confirm?.enable ? "Activar CATV" : "Cortar CATV"}
        tone={confirm?.enable ? "primary" : "danger"}
        message={
          <p>
            {confirm?.enable
              ? `Se encenderá la salida de TV (puerto CATV ${confirm?.port.portId}) de la ONT ${sn.trim()} desde la OLT.`
              : `Se apagará la salida de TV (puerto CATV ${confirm?.port.portId}) de la ONT ${sn.trim()} desde la OLT. El abonado queda sin señal en el coaxial.`}
            {live === false ? " (DRY-RUN: solo se mostrará el plan)." : ""}
          </p>
        }
        confirmLabel={confirm?.enable ? "Activar" : "Cortar"}
        onConfirm={aplicar}
        onClose={() => setConfirm(null)}
      />
    </Modal>
  );
}
