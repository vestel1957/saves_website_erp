"use client";

import { useCallback, useEffect, useState } from "react";
import { PageHeading } from "@/components/ui/PageHeading";
import { Icon } from "@/components/Icon";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";

type Manual = {
  slug: string;
  titulo: string;
  bajada: string;
  referencia: boolean;
  /** El manual que le toca al rol de quien consulta. */
  mio: boolean;
  disponible: boolean;
  peso: number | null;
  actualizado: string | null;
};

const fecha = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString("es-CO", { day: "numeric", month: "long", year: "numeric" }) : "—";

/** "6861 KB" no le dice nada a nadie; "6,7 MB" sí. */
const peso = (kb: number | null) =>
  kb == null ? "—" : kb < 1024 ? `${kb} KB` : `${(kb / 1024).toFixed(1).replace(".", ",")} MB`;

export default function DocumentacionPage() {
  const { authFetch, isSuperadmin: esAdmin } = useAuth();
  const [manuales, setManuales] = useState<Manual[]>([]);
  const [cargando, setCargando] = useState(true);
  const [abriendo, setAbriendo] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await authFetch("/manuals");
      if (r.ok) setManuales(await r.json());
    } finally {
      setCargando(false);
    }
  }, [authFetch]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * El PDF va detrás del token, así que no se puede poner en un `src` a secas: se
   * baja con la sesión y se abre desde un blob. Es el mismo camino que usan las
   * facturas y los cierres de caja.
   */
  async function abrir(m: Manual) {
    setAbriendo(m.slug);
    try {
      const res = await authFetch(`/manuals/${m.slug}/pdf`);
      if (!res.ok) {
        toast("Ese manual todavía no está generado", "x");
        return;
      }
      const url = URL.createObjectURL(new Blob([await res.blob()], { type: "application/pdf" }));
      window.open(url, "_blank", "noopener");
      // Se libera después de que el navegador alcanzó a abrirlo.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch {
      toast("No se pudo abrir el manual", "x");
    } finally {
      setAbriendo(null);
    }
  }

  const mios = manuales.filter((m) => m.mio);
  const otros = manuales.filter((m) => !m.mio && !m.referencia);
  const referencia = manuales.filter((m) => m.referencia);

  const tarjeta = (m: Manual, destacado = false) => (
    <div
      key={m.slug}
      className={`flex flex-col gap-3 rounded-xl border p-5 ${
        destacado ? "border-brand bg-brand-soft" : "border-border bg-surface"
      } ${m.disponible ? "" : "opacity-60"}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-base font-semibold">{m.titulo}</h3>
            {destacado && <Badge label="tu rol" tone="brand" />}
            {!m.disponible && <Badge label="sin generar" tone="warning" />}
          </div>
          <p className="mt-1 text-sm text-text-secondary">{m.bajada}</p>
        </div>
        <Icon name="file-text" className={destacado ? "text-brand" : "text-text-secondary"} />
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 text-xs text-text-secondary">
        <span>
          {m.disponible ? `${peso(m.peso)} · actualizado ${fecha(m.actualizado)}` : "Falta correr el generador"}
        </span>
        <Button
          variant={destacado ? "primary" : "ghost"}
          className="whitespace-nowrap"
          onClick={() => void abrir(m)}
          disabled={!m.disponible || abriendo === m.slug}
        >
          {abriendo === m.slug ? "Abriendo…" : "Abrir PDF"}
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <PageHeading
        icon="book-open"
        title="Documentación"
        subtitle={
          esAdmin
            ? "Manuales de uso del sistema, uno por rol. Cada empleado ve solo el suyo; usted los ve todos."
            : "El manual de uso de su rol: qué puede hacer y cómo, pantalla por pantalla."
        }
      />

      {cargando ? (
        <p className="text-sm text-text-secondary">Cargando manuales…</p>
      ) : manuales.length === 0 ? (
        /* Sin rol reconocido no hay manual que mostrar. Decirlo así, y a quién
           acudir, es más útil que una pantalla vacía que parece rota. */
        <div className="rounded-xl border border-border bg-surface p-6">
          <h2 className="text-base font-semibold">Todavía no hay un manual para su rol</h2>
          <p className="mt-2 text-sm text-text-secondary">
            Su usuario no tiene asignado un rol con manual propio. Pídale a <strong>Sistemas</strong> que le
            asigne el rol que corresponde a su cargo y aquí aparecerá su guía.
          </p>
        </div>
      ) : (
        <>
          {mios.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
                {mios.length > 1 ? "Tus manuales" : "Tu manual"}
              </h2>
              <div className="grid gap-4 md:grid-cols-2">{mios.map((m) => tarjeta(m, true))}</div>
            </section>
          )}

          {/* Solo el superusuario llega aquí: al resto el backend ni le manda estos. */}
          {otros.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">
                Los demás roles
              </h2>
              <p className="text-sm text-text-secondary">
                Usted los ve todos porque administra el sistema. Cada empleado ve únicamente el manual de su
                rol.
              </p>
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{otros.map((m) => tarjeta(m))}</div>
            </section>
          )}

          {referencia.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-text-secondary">Referencia</h2>
              <div className="grid gap-4 md:grid-cols-2">{referencia.map((m) => tarjeta(m))}</div>
            </section>
          )}

          {esAdmin && (
            <p className="text-xs text-text-secondary">
              Los manuales se generan desde texto (<code>documentacion/fuentes/</code>) con{" "}
              <code>python3 documentacion/build_manuales.py</code>. Si cambia una pantalla, se edita el .md y
              se vuelve a generar: nadie edita el PDF a mano.
            </p>
          )}
        </>
      )}
    </div>
  );
}
