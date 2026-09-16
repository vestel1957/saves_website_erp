"use client";

import { useCallback, useEffect, useState } from "react";
import { Input, Select, Field } from "@/components/ui/Field";
import { useAuth } from "@/context/AuthProvider";

/* Catálogos de valores fijos (tomados literal del legacy customers/edit.php) */
export const NOMENCLATURAS = ["Calle", "Carrera", "Diagonal", "Transversal", "Manzana"];
export const ADICIONALES = ["", "bis", "sur", "a", "a sur", "b", "b sur", "c", "d", "e", "f", "g", "h", "a bis", "b bis", "c bis", "d bis", "oeste"];
export const ADICIONALES2 = ["", "Lote", ...ADICIONALES.slice(1)];
export const RESIDENCIAS = ["", "Casa", "Apartamento", "Edificio", "Oficina", "Vereda"];
/**
 * El INTERIOR del inmueble: torre/piso y apartamento/casa. Son las dos únicas piezas
 * con las que se puede decir "la misma casa, otro piso", así que de ellas depende que
 * la ficha distinga los dos sitios (la dirección que arma `direccionDe` sí las lleva;
 * Residencia y Referencia no).
 *
 * Ya no FRENAN nada: el traslado a la misma dirección se abre igual (`armarTraslado`,
 * 2026-09-08). Siguen importando porque sin ellas la ficha queda diciendo que vive
 * donde vivía, y el técnico de la próxima visita toca la puerta de abajo.
 *
 * **"Piso" es un añadido nuestro** (2026-09-08, pedido del usuario: un traslado a la
 * misma dirección «pero piso 2»). El legacy no lo ofrecía en su desplegable —Torre,
 * Interior, Manzana, Bloque— pero la gente lo venía escribiendo a mano en la casilla
 * de Residencia ('PISO 2', 'PISO', 'PISO2'), donde NO cuenta como dirección: ahí es
 * una referencia para llegar, no un sitio distinto. La columna del legacy es un
 * varchar, así que 'Piso' viaja allá sin problema.
 */
export const DIVICIONES = ["", "Torre", "Piso", "Interior", "Manzana", "Bloque"];
export const DIVICIONES2 = ["", "Apartamento", "Casa", "Piso"];

/** Las 12 casillas en que está partida la dirección (espejo de `CASILLAS_DIRECCION`). */
export const NOM_KEYS = [
  "nomenclatura", "numero1", "adicionauno", "numero2", "adicional2", "numero3",
  "residencia", "referencia", "divicion", "divnum1", "divicion2", "divnum2",
] as const;

/** Los cuatro niveles de zona, que en la ficha viajan como ids del legacy en texto. */
export const ZONA_KEYS = ["departmentRef", "cityRef", "localityRef", "neighborhood"] as const;

export type Geo = { legacyId: number | null; name: string };

/** Un valor de dirección: las casillas + la zona + la línea comercial, todo texto. */
export type DireccionValor = Record<string, string>;

/** Una dirección vacía, con todas las claves puestas (nunca `undefined`). */
export const DIRECCION_VACIA: DireccionValor = Object.fromEntries(
  [...NOM_KEYS, ...ZONA_KEYS, "addressLine"].map((k) => [k, ""]),
);

/**
 * La dirección armada a partir de sus piezas, para poder enseñarla mientras se
 * escribe.
 *
 * Es el espejo de `direccionDe` del backend (`common/subscriber-address.ts`), que
 * es quien manda: esto solo pinta. Si las dos se separan, lo que se guarda sigue
 * siendo lo que arma el servidor.
 */
export function direccionArmada(v: DireccionValor): string {
  const p = (k: string) => {
    const s = (v[k] ?? "").trim();
    return s === "0" ? "" : s;
  };
  const via = [p("nomenclatura"), p("numero1"), p("adicionauno")].filter(Boolean).join(" ");
  const numero2 = p("numero2");
  const numero3 = p("numero3");
  const adicional2 = p("adicional2");
  const cruce = numero2 ? `# ${[numero2, adicional2].filter(Boolean).join(" ")}` : "";
  const placa = !numero3 ? "" : cruce ? `- ${numero3}` : [adicional2, numero3].filter(Boolean).join(" ");
  const div1 = p("divnum1") ? [p("divicion") || "Torre", p("divnum1")].join(" ") : "";
  const div2 = p("divnum2") ? [p("divicion2") || "Casa", p("divnum2")].join(" ") : "";
  const cabeza = p("numero1") || cruce || placa ? via : "";
  return [cabeza, cruce, placa, div1, div2].filter(Boolean).join(" ").trim() || (v.addressLine ?? "").trim();
}

/**
 * Las casillas de la DIRECCIÓN de un cliente: zona (departamento → ciudad →
 * localidad → barrio) y la dirección partida en piezas.
 *
 * Vive aparte del formulario de alta porque ya son dos los sitios que escriben
 * dirección: el alta/edición del cliente y la orden de TRASLADO, que captura a
 * dónde se muda. Los catálogos encadenados y las listas de valores fijos son los
 * mismos en ambos, y dos copias acabarían ofreciendo barrios distintos.
 *
 * Es controlado: el padre guarda el valor plano (una clave por casilla) y recibe
 * los cambios como parches. Los catálogos los carga y encadena este componente.
 */
export function DireccionFields({
  value,
  onChange,
  zona = true,
  comercial = true,
  hintComercial,
}: {
  value: DireccionValor;
  onChange: (patch: DireccionValor) => void;
  /** Enseñar departamento/ciudad/localidad/barrio. */
  zona?: boolean;
  /** Enseñar la "dirección comercial" suelta (`addressLine`). */
  comercial?: boolean;
  hintComercial?: string;
}) {
  const { authFetch } = useAuth();
  const [departments, setDepartments] = useState<Geo[]>([]);
  const [cities, setCities] = useState<Geo[]>([]);
  const [localities, setLocalities] = useState<Geo[]>([]);
  const [neighborhoods, setNeighborhoods] = useState<Geo[]>([]);

  const geo = useCallback(
    (path: string) => authFetch(path).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    [authFetch],
  );

  // Cada nivel se carga a partir del de arriba, y se vuelve a cargar solo si ese
  // cambia. Así vale igual para un alta (que empieza vacía) que para una edición o
  // un traslado (que llegan con la zona ya puesta y tienen que verla escrita).
  useEffect(() => { if (zona) void geo("/subscribers/geo/departments").then(setDepartments); }, [zona, geo]);
  useEffect(() => {
    if (!zona || !value.departmentRef) { setCities([]); return; }
    void geo(`/subscribers/geo/cities?department=${value.departmentRef}`).then(setCities);
  }, [zona, value.departmentRef, geo]);
  useEffect(() => {
    if (!zona || !value.cityRef) { setLocalities([]); return; }
    void geo(`/subscribers/geo/localities?city=${value.cityRef}`).then(setLocalities);
  }, [zona, value.cityRef, geo]);
  useEffect(() => {
    if (!zona || !value.localityRef) { setNeighborhoods([]); return; }
    void geo(`/subscribers/geo/neighborhoods?locality=${value.localityRef}`).then(setNeighborhoods);
  }, [zona, value.localityRef, geo]);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    onChange({ [k]: e.target.value });

  // Cambiar un nivel invalida los de abajo: el barrio de otra ciudad no existe.
  const setNivel = (k: "departmentRef" | "cityRef" | "localityRef") => (e: React.ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value;
    const hijos: Record<string, DireccionValor> = {
      departmentRef: { cityRef: "", localityRef: "", neighborhood: "" },
      cityRef: { localityRef: "", neighborhood: "" },
      localityRef: { neighborhood: "" },
    };
    onChange({ [k]: v, ...hijos[k] });
  };

  const opts = (list: Geo[], current: string) => (
    <>
      <option value="">— Seleccionar —</option>
      {/* si el valor actual no está en la lista cargada, se muestra igual */}
      {current && !list.some((g) => String(g.legacyId) === current) && <option value={current}>({current})</option>}
      {list.map((g) => <option key={g.legacyId} value={String(g.legacyId)}>{g.name}</option>)}
    </>
  );

  return (
    <>
      {zona && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Departamento"><Select value={value.departmentRef ?? ""} onChange={setNivel("departmentRef")}>{opts(departments, value.departmentRef ?? "")}</Select></Field>
          <Field label="Ciudad"><Select value={value.cityRef ?? ""} onChange={setNivel("cityRef")}>{opts(cities, value.cityRef ?? "")}</Select></Field>
          <Field label="Localidad"><Select value={value.localityRef ?? ""} onChange={setNivel("localityRef")}>{opts(localities, value.localityRef ?? "")}</Select></Field>
          <Field label="Barrio"><Select value={value.neighborhood ?? ""} onChange={set("neighborhood")}>{opts(neighborhoods, value.neighborhood ?? "")}</Select></Field>
        </div>
      )}

      <div className={`grid grid-cols-3 gap-2 sm:grid-cols-6 ${zona ? "mt-2" : ""}`}>
        <Field label="Nomencl."><Select value={value.nomenclatura ?? ""} onChange={set("nomenclatura")}><option value="">—</option>{NOMENCLATURAS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
        <Field label="N°"><Input value={value.numero1 ?? ""} onChange={set("numero1")} /></Field>
        <Field label="Adic."><Select value={value.adicionauno ?? ""} onChange={set("adicionauno")}>{ADICIONALES.map((t) => <option key={t} value={t}>{t || "—"}</option>)}</Select></Field>
        <Field label="N°"><Input value={value.numero2 ?? ""} onChange={set("numero2")} /></Field>
        <Field label="Adic."><Select value={value.adicional2 ?? ""} onChange={set("adicional2")}>{ADICIONALES2.map((t) => <option key={t} value={t}>{t || "—"}</option>)}</Select></Field>
        <Field label="N° (placa)"><Input value={value.numero3 ?? ""} onChange={set("numero3")} /></Field>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Field label="Residencia"><Select value={value.residencia ?? ""} onChange={set("residencia")}>{RESIDENCIAS.map((t) => <option key={t} value={t}>{t || "—"}</option>)}</Select></Field>
        <div className="col-span-1 sm:col-span-3"><Field label="Referencia"><Input value={value.referencia ?? ""} onChange={set("referencia")} /></Field></div>
        {/* El INTERIOR. Se rotula por lo que es —torre/piso y apartamento/casa— y no
            "División 1/2", que no le decía a nadie dónde poner el piso: es justo lo
            que hay que llenar para mudar a alguien dentro del mismo edificio. */}
        <Field label="Torre / piso"><Select value={value.divicion ?? ""} onChange={set("divicion")}>{DIVICIONES.map((t) => <option key={t} value={t}>{t || "—"}</option>)}</Select></Field>
        <Field label="Nº"><Input value={value.divnum1 ?? ""} onChange={set("divnum1")} /></Field>
        <Field label="Apto / casa"><Select value={value.divicion2 ?? ""} onChange={set("divicion2")}>{DIVICIONES2.map((t) => <option key={t} value={t}>{t || "—"}</option>)}</Select></Field>
        <Field label="Nº"><Input value={value.divnum2 ?? ""} onChange={set("divnum2")} /></Field>
      </div>
      {comercial && (
        <div className="mt-2">
          <Field label="Dirección del cliente (comercial)" hint={hintComercial}>
            <Input value={value.addressLine ?? ""} onChange={set("addressLine")} />
          </Field>
        </div>
      )}
    </>
  );
}
