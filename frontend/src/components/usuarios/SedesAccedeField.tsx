"use client";

import { useEffect, useState } from "react";
import { useAuth } from "@/context/AuthProvider";
import { Icon } from "@/components/Icon";

type Sede = { legacyId: number; name: string };

/**
 * Selector de las sedes a las que accede un usuario (`User.sedesAccede`).
 *
 * OJO con la semántica, que es contraintuitiva y por eso se explica en pantalla:
 * **ninguna sede marcada = acceso a TODAS**, no a ninguna. Es la regla que aplica
 * el filtro del backend (`treasury/caja-scope.ts`): una lista vacía significa "sin
 * restricción". Marcar sedes es lo que ACOTA.
 *
 * Se usa tanto al crear el usuario como al editar sus permisos, así que vive aparte
 * en vez de duplicarse en las dos pantallas.
 */
export function SedesAccedeField({
  value,
  onChange,
  disabled = false,
}: {
  value: number[];
  onChange: (sedes: number[]) => void;
  disabled?: boolean;
}) {
  const { authFetch } = useAuth();
  const [sedes, setSedes] = useState<Sede[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let vigente = true;
    (async () => {
      try {
        const res = await authFetch("/auth/branches");
        if (!res.ok) throw new Error("No se pudieron cargar las sedes");
        const data = (await res.json()) as Sede[];
        if (vigente) setSedes(data);
      } catch (e) {
        if (vigente) setError(e instanceof Error ? e.message : "No se pudieron cargar las sedes");
      } finally {
        if (vigente) setCargando(false);
      }
    })();
    // Evita que una respuesta lenta pise el estado si el modal ya se cerró.
    return () => {
      vigente = false;
    };
  }, [authFetch]);

  const todas = value.length === 0;

  function alternar(legacyId: number) {
    onChange(
      value.includes(legacyId) ? value.filter((s) => s !== legacyId) : [...value, legacyId].sort((a, b) => a - b),
    );
  }

  return (
    <div>
      <span className="mb-1.5 block text-[12px] font-semibold text-text-secondary">
        Sedes a las que accede
      </span>

      <p className="mb-2 flex items-start gap-1.5 text-[12px] text-text-secondary">
        <Icon name="info" size={13} className="mt-[2px] shrink-0" />
        <span>
          {todas ? (
            <>
              Sin sedes marcadas: <strong className="text-text-primary">accede a todas</strong>. Marca
              sedes para limitarlo.
            </>
          ) : (
            <>
              Limitado a <strong className="text-text-primary">{value.length}</strong>{" "}
              {value.length === 1 ? "sede" : "sedes"}. Desmárcalas todas para darle acceso completo.
            </>
          )}
        </span>
      </p>

      {cargando && <p className="text-[12px] text-text-secondary">Cargando sedes…</p>}
      {error && <p className="text-[12px] text-error-text">{error}</p>}

      {!cargando && !error && (
        <>
          <div className="flex max-h-44 flex-col gap-1 overflow-y-auto rounded-md border border-border-subtle p-1.5">
            {sedes.map((s) => (
              <label
                key={s.legacyId}
                className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] hover:bg-surface-2"
              >
                <input
                  type="checkbox"
                  checked={value.includes(s.legacyId)}
                  onChange={() => alternar(s.legacyId)}
                  disabled={disabled}
                  className="accent-brand"
                />
                <span className="font-medium text-text-primary">{s.name}</span>
              </label>
            ))}
            {sedes.length === 0 && (
              <p className="px-2 py-1.5 text-[12px] text-text-secondary">No hay sedes registradas.</p>
            )}
          </div>

          {!todas && (
            <button
              type="button"
              onClick={() => onChange([])}
              disabled={disabled}
              className="mt-1.5 text-[12px] font-medium text-brand hover:underline"
            >
              Quitar la restricción (acceso a todas las sedes)
            </button>
          )}
        </>
      )}
    </div>
  );
}
