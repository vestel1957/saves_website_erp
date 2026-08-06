"use client";

import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/Modal";
import { Button } from "@/components/ui/Button";
import { Input, Select, Field } from "@/components/ui/Field";
import { Icon } from "@/components/Icon";
import { toast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthProvider";
import { mensajeDeError } from "@/lib/errores";

/* Catálogos de valores fijos (tomados literal del legacy customers/edit.php) */
const CUSTOMER_TYPES = ["Natural", "Juridico", "Gubernamental", "Militar"];
const DOC_TYPES = ["CC", "CE", "NIT", "PAS", "PPT"];
const SUSCRIPCIONES = ["Residencial", "Corporativo", "Dedicado"];
const ESTRATOS = ["Estrato 1", "Estrato 2", "Estrato 3", "Estrato 4", "Estrato 5", "Estrato 6", "Estrato 7", "Estrato 8"];
const NOMENCLATURAS = ["Calle", "Carrera", "Diagonal", "Transversal", "Manzana"];
const ADICIONALES = ["", "bis", "sur", "a", "a sur", "b", "b sur", "c", "d", "e", "f", "g", "h", "a bis", "b bis", "c bis", "d bis", "oeste"];
const ADICIONALES2 = ["", "Lote", ...ADICIONALES.slice(1)];
const RESIDENCIAS = ["", "Casa", "Apartamento", "Edificio", "Oficina", "Vereda"];
const DIVICIONES = ["", "Torre", "Interior", "Manzana", "Bloque"];
const DIVICIONES2 = ["", "Apartamento", "Casa"];

type Geo = { legacyId: number | null; name: string };
type Branch = { id: string; name: string };

const NOM_KEYS = [
  "nomenclatura", "numero1", "adicionauno", "numero2", "adicional2", "numero3",
  "residencia", "referencia", "divicion", "divnum1", "divicion2", "divnum2",
] as const;

/** Tecnologías de instalación (enum InstallTech del backend). */
const INSTALL_TECHS = ["GPON", "EPON", "EOC", "RADIO", "FIBRA"];

const EMPTY: Record<string, any> = {
  abonado: "", firstName: "", secondName: "", lastName1: "", lastName2: "", companyName: "",
  customerType: "", docType: "CC", docNumber: "", email: "", phone1: "", phone2: "",
  birthDate: "", estrato: "", suscripcion: "", contractDate: "",
  departmentRef: "", cityRef: "", localityRef: "", neighborhood: "", addressLine: "",
  clausula: "", gpsLat: "", gpsLng: "", branchId: "",
  pppUsername: "", pppPassword: "", pppProfile: "", ipRemote: "", installTech: "",
  ...Object.fromEntries(NOM_KEYS.map((k) => [k, ""])),
};

const dateInput = (d?: string | null) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const str = (v: any) => (v == null ? "" : String(v));

const STEPS = ["Datos personales", "Ubicación / dirección", "Conectividad", "Revisión"];

/** Resultado del chequeo de duplicados del backend. */
type DupCheck = {
  document?: { count: number; message: string | null } | null;
  address?: { count: number; message: string | null } | null;
  pppUsername?: { taken: boolean; router: string; message: string } | null;
};

export function ClienteWizardModal({
  mode, subscriberId, open, onClose, onDone,
}: {
  mode: "create" | "edit";
  subscriberId?: string;
  open: boolean;
  onClose: () => void;
  onDone: (id?: string) => void;
}) {
  const { authFetch } = useAuth();
  const [step, setStep] = useState(0);
  const [f, setF] = useState<Record<string, any>>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [departments, setDepartments] = useState<Geo[]>([]);
  const [cities, setCities] = useState<Geo[]>([]);
  const [localities, setLocalities] = useState<Geo[]>([]);
  const [neighborhoods, setNeighborhoods] = useState<Geo[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [clausulas, setClausulas] = useState<{ legacyId: number | null; nombre: string; meses: number }[]>([]);
  const [dup, setDup] = useState<DupCheck>({});
  const [checkingPpp, setCheckingPpp] = useState(false);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));

  /**
   * Chequeo de duplicados contra el servidor. Documento y dirección sólo AVISAN (igual que
   * el legacy: el mismo titular puede tener varias cuentas y la facturación electrónica las
   * mapea a sucursales de Siigo). El usuario PPP sí bloquea el guardado.
   */
  const checkDup = useCallback(
    async (payload: Record<string, any>) => {
      try {
        const res = await authFetch("/subscribers/check-duplicates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!res.ok) return;
        const d = await res.json();
        setDup((prev) => ({ ...prev, ...d }));
      } catch { /* el chequeo es informativo; nunca debe frenar el wizard */ }
    },
    [authFetch],
  );

  const geo = useCallback(
    (path: string) => authFetch(path).then((r) => (r.ok ? r.json() : [])).catch(() => []),
    [authFetch],
  );

  // Cargar catálogos base + precargar (edición) al abrir.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    // El catálogo llega acotado a las sedes del usuario. Si sólo tiene una (la
    // cajera), se elige sola: no hay decisión que tomar y dejarla en "—" sólo
    // conseguiría que el alta fallara con un 403 por no indicar sede.
    void geo("/subscribers/branches").then((bs: Branch[]) => {
      setBranches(bs);
      if (bs.length === 1) setF((p) => (p.branchId ? p : { ...p, branchId: bs[0].id }));
    });
    void geo("/subscribers/geo/departments").then(setDepartments);
    // Solo las activas: el catálogo puede tener cláusulas retiradas que siguen
    // imprimiéndose en contratos viejos pero ya no se ofrecen en un alta.
    void geo("/clausulas?soloActivas=1").then(setClausulas);

    if (mode === "edit" && subscriberId) {
      void authFetch(`/subscribers/${subscriberId}/form`)
        .then((r) => (r.ok ? r.json() : Promise.reject()))
        .then((d) => {
          const nom = (d.nomenclature ?? {}) as Record<string, any>;
          setF({
            ...EMPTY,
            abonado: str(d.abonado), firstName: str(d.firstName), secondName: str(d.secondName),
            lastName1: str(d.lastName1), lastName2: str(d.lastName2), companyName: str(d.companyName),
            customerType: str(d.customerType), docType: str(d.docType) || "CC", docNumber: str(d.docNumber),
            email: str(d.email), phone1: str(d.phone1), phone2: str(d.phone2),
            birthDate: dateInput(d.birthDate), estrato: str(d.estrato), suscripcion: str(d.suscripcion),
            contractDate: dateInput(d.contractDate), departmentRef: str(d.departmentRef), cityRef: str(d.cityRef),
            localityRef: str(d.localityRef), neighborhood: str(d.neighborhood), addressLine: str(d.addressLine),
            clausula: str(d.clausula), gpsLat: str(d.gpsLat), gpsLng: str(d.gpsLng), branchId: str(d.branchId),
            pppUsername: str(d.pppUsername), pppPassword: str(d.pppPassword), pppProfile: str(d.pppProfile),
            ipRemote: str(d.ipRemote), installTech: str(d.installTech),
            ...Object.fromEntries(NOM_KEYS.map((k) => [k, str(nom[k])])),
          });
          // Cargar los niveles dependientes para que los selects muestren el valor actual.
          if (d.departmentRef) void geo(`/subscribers/geo/cities?department=${d.departmentRef}`).then(setCities);
          if (d.cityRef) void geo(`/subscribers/geo/localities?city=${d.cityRef}`).then(setLocalities);
          if (d.localityRef) void geo(`/subscribers/geo/neighborhoods?locality=${d.localityRef}`).then(setNeighborhoods);
        })
        .catch(() => toast("No se pudo cargar el cliente", "alert-circle"));
    } else {
      setF(EMPTY);
      setCities([]); setLocalities([]); setNeighborhoods([]);
    }
  }, [open, mode, subscriberId, authFetch, geo]);

  // Cascada dependiente.
  function onDepartment(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    setF((p) => ({ ...p, departmentRef: v, cityRef: "", localityRef: "", neighborhood: "" }));
    setCities([]); setLocalities([]); setNeighborhoods([]);
    if (v) void geo(`/subscribers/geo/cities?department=${v}`).then(setCities);
  }
  function onCity(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    setF((p) => ({ ...p, cityRef: v, localityRef: "", neighborhood: "" }));
    setLocalities([]); setNeighborhoods([]);
    if (v) void geo(`/subscribers/geo/localities?city=${v}`).then(setLocalities);
  }
  function onLocality(e: React.ChangeEvent<HTMLSelectElement>) {
    const v = e.target.value;
    setF((p) => ({ ...p, localityRef: v, neighborhood: "" }));
    setNeighborhoods([]);
    if (v) void geo(`/subscribers/geo/neighborhoods?locality=${v}`).then(setNeighborhoods);
  }

  // Validación de campos obligatorios (paso 1) — igual que los `required` del legacy.
  // La razón social solo aplica a empresas/entidades (o si ya trae valor guardado).
  const showCompany = ["Juridico", "Gubernamental", "Militar"].includes(f.customerType) || !!f.companyName?.trim();

  const missing: string[] = [];
  if (!f.firstName.trim()) missing.push("1er nombre");
  if (!f.lastName1.trim()) missing.push("1er apellido");
  if (!f.phone1.trim()) missing.push("celular");
  if (!f.email.trim()) missing.push("correo");
  if (!f.birthDate) missing.push("nacimiento");

  function buildPayload() {
    const nomenclature = Object.fromEntries(NOM_KEYS.map((k) => [k, f[k] || null]));
    return {
      firstName: f.firstName, secondName: f.secondName, lastName1: f.lastName1, lastName2: f.lastName2,
      companyName: f.companyName, customerType: f.customerType || undefined, docType: f.docType,
      docNumber: f.docNumber, email: f.email, phone1: f.phone1, phone2: f.phone2, birthDate: f.birthDate,
      estrato: f.estrato, suscripcion: f.suscripcion || undefined, contractDate: f.contractDate || undefined,
      // "" = sin permanencia, y eso hay que poder GUARDARLO: mandar undefined
      // dejaría puesta la cláusula anterior al quitarla en una edición.
      clausula: f.clausula === "" ? null : Number(f.clausula),
      departmentRef: f.departmentRef, cityRef: f.cityRef, localityRef: f.localityRef, neighborhood: f.neighborhood,
      addressLine: f.addressLine, branchId: f.branchId || undefined, nomenclature,
      // Conectividad (legacy `create.php`: name_s, contra, perfil, Ipremota, tegnologia).
      // Sin pppUsername el cliente no se puede aprovisionar en el Mikrotik.
      pppUsername: f.pppUsername || undefined, pppPassword: f.pppPassword || undefined,
      pppProfile: f.pppProfile || undefined, ipRemote: f.ipRemote || undefined,
      installTech: f.installTech || undefined,
    };
  }

  async function submit() {
    if (missing.length) { setStep(0); toast(`Faltan campos: ${missing.join(", ")}`, "alert-circle"); return; }
    setSaving(true);
    try {
      const payload = buildPayload();
      const url = mode === "edit" ? `/subscribers/${subscriberId}` : `/subscribers`;
      const res = await authFetch(url, { method: mode === "edit" ? "PATCH" : "POST", body: JSON.stringify(payload) });
      if (!res.ok) {
        const m = await res.json().catch(() => null);
        throw new Error(Array.isArray(m?.message) ? m.message[0] : m?.message ?? "No se pudo guardar");
      }
      const out = await res.json().catch(() => ({}));
      toast(mode === "edit" ? "Cliente actualizado" : `Cliente creado (abonado ${out.abonado ?? ""})`);
      onDone(out.id ?? subscriberId);
      onClose();
    } catch (e) {
      toast(mensajeDeError(e) ?? "Error al guardar", "alert-circle");
    } finally {
      setSaving(false);
    }
  }

  const geoOpts = (list: Geo[], current: string) => (
    <>
      <option value="">— Seleccionar —</option>
      {/* si el valor actual no está en la lista cargada, lo mostramos igual */}
      {current && !list.some((g) => String(g.legacyId) === current) && <option value={current}>({current})</option>}
      {list.map((g) => <option key={g.legacyId} value={String(g.legacyId)}>{g.name}</option>)}
    </>
  );

  return (
    <Modal open={open} onClose={onClose} title={mode === "edit" ? "Editar cliente" : "Nuevo cliente"} maxWidth="max-w-3xl">
      {/* Barra de pasos */}
      <div className="mb-1 flex items-center gap-2">
        {STEPS.map((s, i) => (
          <button
            key={s}
            type="button"
            onClick={() => setStep(i)}
            className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-semibold transition-colors ${
              i === step ? "bg-brand text-on-brand" : "bg-surface-2 text-text-secondary hover:brightness-95"
            }`}
          >
            <span className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] ${i === step ? "bg-white/25" : "bg-border-subtle"}`}>{i + 1}</span>
            <span className="hidden sm:inline">{s}</span>
          </button>
        ))}
      </div>

      {/* Paso 1 — human-first: nombre → documento → contacto → clasificación */}
      {step === 0 && (
        <div className="flex flex-col gap-4">
          <Section title="Nombre">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="1er nombre *"><Input value={f.firstName} onChange={set("firstName")} autoFocus /></Field>
              <Field label="2º nombre"><Input value={f.secondName} onChange={set("secondName")} /></Field>
              <Field label="1er apellido *"><Input value={f.lastName1} onChange={set("lastName1")} /></Field>
              <Field label="2º apellido"><Input value={f.lastName2} onChange={set("lastName2")} /></Field>
            </div>
          </Section>

          <Section title="Documento e identificación">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Tipo cliente"><Select value={f.customerType} onChange={set("customerType")}><option value="">—</option>{CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
              <Field label="Tipo doc."><Select value={f.docType} onChange={set("docType")}>{DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
              <Field label="N° documento"><Input value={f.docNumber} onChange={set("docNumber")} /></Field>
              {showCompany && <Field label="Empresa / razón social"><Input value={f.companyName} onChange={set("companyName")} /></Field>}
            </div>
          </Section>

          <Section title="Contacto">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Celular *"><Input value={f.phone1} onChange={set("phone1")} inputMode="tel" /></Field>
              <Field label="Celular (adi)"><Input value={f.phone2} onChange={set("phone2")} inputMode="tel" /></Field>
              <div className="col-span-2"><Field label="Correo *"><Input value={f.email} onChange={set("email")} type="email" /></Field></div>
            </div>
          </Section>

          <Section title="Clasificación y contrato">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Nacimiento *"><Input value={f.birthDate} onChange={set("birthDate")} type="date" /></Field>
              <Field label="Estrato"><Select value={f.estrato} onChange={set("estrato")}><option value="">—</option>{ESTRATOS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
              <Field label="Suscripción"><Select value={f.suscripcion} onChange={set("suscripcion")}><option value="">—</option>{SUSCRIPCIONES.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
              <Field label="Fecha contrato"><Input value={f.contractDate} onChange={set("contractDate")} type="date" /></Field>
              <div className="col-span-2">
                <Field label="Cláusula de permanencia" hint="Lo que paga el cliente si se retira antes de tiempo. Sin cláusula puede irse cuando quiera.">
                  <Select value={f.clausula} onChange={set("clausula")}>
                    <option value="">Sin permanencia</option>
                    {clausulas.map((c) => (
                      <option key={c.legacyId ?? c.nombre} value={String(c.legacyId ?? "")}>
                        {c.nombre} · {c.meses} meses
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            </div>
          </Section>
        </div>
      )}

      {/* Paso 2 — Sede/zona → dirección → adicionales */}
      {step === 1 && (
        <div className="flex flex-col gap-4">
          <Section title="Sede y zona">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Field label="Sede"><Select value={f.branchId} onChange={set("branchId")}><option value="">—</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
              <Field label="Departamento"><Select value={f.departmentRef} onChange={onDepartment}>{geoOpts(departments, f.departmentRef)}</Select></Field>
              <Field label="Ciudad"><Select value={f.cityRef} onChange={onCity}>{geoOpts(cities, f.cityRef)}</Select></Field>
              <Field label="Localidad"><Select value={f.localityRef} onChange={onLocality}>{geoOpts(localities, f.localityRef)}</Select></Field>
              <Field label="Barrio"><Select value={f.neighborhood} onChange={set("neighborhood")}>{geoOpts(neighborhoods, f.neighborhood)}</Select></Field>
            </div>
          </Section>

          <Section title="Dirección">
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              <Field label="Nomencl."><Select value={f.nomenclatura} onChange={set("nomenclatura")}><option value="">—</option>{NOMENCLATURAS.map((t) => <option key={t} value={t}>{t}</option>)}</Select></Field>
              <Field label="N°"><Input value={f.numero1} onChange={set("numero1")} /></Field>
              <Field label="Adic."><Select value={f.adicionauno} onChange={set("adicionauno")}>{ADICIONALES.map((t) => <option key={t} value={t}>{t || "—"}</option>)}</Select></Field>
              <Field label="N°"><Input value={f.numero2} onChange={set("numero2")} /></Field>
              <Field label="Adic."><Select value={f.adicional2} onChange={set("adicional2")}>{ADICIONALES2.map((t) => <option key={t} value={t}>{t || "—"}</option>)}</Select></Field>
              <Field label="N° (placa)"><Input value={f.numero3} onChange={set("numero3")} /></Field>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Field label="Residencia"><Select value={f.residencia} onChange={set("residencia")}>{RESIDENCIAS.map((t) => <option key={t} value={t}>{t || "—"}</option>)}</Select></Field>
              <div className="col-span-1 sm:col-span-3"><Field label="Referencia"><Input value={f.referencia} onChange={set("referencia")} /></Field></div>
              <Field label="División 1"><Select value={f.divicion} onChange={set("divicion")}>{DIVICIONES.map((t) => <option key={t} value={t}>{t || "—"}</option>)}</Select></Field>
              <Field label="Nº div1"><Input value={f.divnum1} onChange={set("divnum1")} /></Field>
              <Field label="División 2"><Select value={f.divicion2} onChange={set("divicion2")}>{DIVICIONES2.map((t) => <option key={t} value={t}>{t || "—"}</option>)}</Select></Field>
              <Field label="Nº div2"><Input value={f.divnum2} onChange={set("divnum2")} /></Field>
            </div>
            <div className="mt-2">
              <Field label="Dirección del cliente (comercial)" hint="Las coordenadas GPS las registra el técnico en la instalación."><Input value={f.addressLine} onChange={set("addressLine")} /></Field>
            </div>
          </Section>
        </div>
      )}

      {/* Paso 3 — conectividad (PPP / Mikrotik) */}
      {step === 2 && (
        <div className="flex flex-col gap-2">
          <Section title="Conexión PPP">
            <p className="mb-2 text-[12px] text-text-tertiary">
              Sin usuario PPP el cliente no se puede aprovisionar en el Mikrotik. El nombre de
              usuario debe ser único: se valida contra la base de datos y contra el router de la sede.
            </p>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              <Field label="Usuario PPP">
                <Input
                  value={f.pppUsername}
                  onChange={set("pppUsername")}
                  onBlur={() => {
                    if (!f.pppUsername?.trim()) { setDup((p) => ({ ...p, pppUsername: null })); return; }
                    setCheckingPpp(true);
                    void checkDup({ pppUsername: f.pppUsername, branchId: f.branchId || undefined, installTech: f.installTech || undefined })
                      .finally(() => setCheckingPpp(false));
                  }}
                />
              </Field>
              <Field label="Clave PPP"><Input value={f.pppPassword} onChange={set("pppPassword")} /></Field>
              <Field label="Perfil / velocidad"><Input value={f.pppProfile} onChange={set("pppProfile")} /></Field>
              <Field label="IP remota"><Input value={f.ipRemote} onChange={set("ipRemote")} /></Field>
              <Field label="Tecnología">
                <Select value={f.installTech} onChange={set("installTech")}>
                  <option value="">— Seleccionar —</option>
                  {INSTALL_TECHS.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
              </Field>
            </div>
            {checkingPpp && <p className="mt-2 text-[12px] text-text-tertiary">Verificando disponibilidad…</p>}
            {!checkingPpp && dup.pppUsername && (
              <div className={`mt-2 rounded-lg px-3 py-2 text-[12px] ${
                dup.pppUsername.taken
                  ? "bg-error-soft text-error-text"
                  : dup.pppUsername.router === "unreachable"
                    ? "border border-warning-border bg-warning-soft text-text-secondary"
                    : "bg-success-soft text-success-text"
              }`}>
                {dup.pppUsername.message}
              </div>
            )}
          </Section>
        </div>
      )}

      {/* Paso 4 — revisión */}
      {step === 3 && (
        <div className="flex flex-col gap-2 text-[13px]">
          {missing.length > 0 && (
            <div className="rounded-lg bg-error-soft px-3 py-2 text-[12px] text-error-text">Faltan campos obligatorios: {missing.join(", ")}.</div>
          )}
          {/* Avisos NO bloqueantes (paridad legacy: el mismo titular puede tener varias cuentas). */}
          {dup.document?.message && (
            <div className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-text-secondary">{dup.document.message}</div>
          )}
          {dup.address?.message && (
            <div className="rounded-lg border border-warning-border bg-warning-soft px-3 py-2 text-[12px] text-text-secondary">{dup.address.message}</div>
          )}
          {dup.pppUsername?.taken && (
            <div className="rounded-lg bg-error-soft px-3 py-2 text-[12px] text-error-text">{dup.pppUsername.message}</div>
          )}
          <div className="grid grid-cols-2 gap-x-4 gap-y-1">
            <Rev k="Nombre" v={[f.firstName, f.secondName, f.lastName1, f.lastName2].filter(Boolean).join(" ")} />
            <Rev k="Documento" v={`${f.docType} ${f.docNumber}`} />
            <Rev k="Celular" v={f.phone1} />
            <Rev k="Correo" v={f.email} />
            <Rev k="Nacimiento" v={f.birthDate} />
            <Rev k="Tipo cliente" v={f.customerType} />
            <Rev k="Suscripción" v={f.suscripcion} />
            <Rev k="Permanencia" v={clausulas.find((c) => String(c.legacyId) === String(f.clausula))?.nombre ?? "Sin permanencia"} />
            <Rev k="Estrato" v={f.estrato} />
            <Rev k="Dirección" v={[f.nomenclatura, f.numero1, f.adicionauno, "#", f.numero2, f.adicional2, "-", f.numero3].filter(Boolean).join(" ")} />
            <Rev k="Barrio (id)" v={f.neighborhood} />
            <Rev k="Sede" v={branches.find((b) => b.id === f.branchId)?.name} />
            <Rev k="Usuario PPP" v={f.pppUsername} />
            <Rev k="Tecnología" v={f.installTech} />
            <Rev k="Perfil" v={f.pppProfile} />
            <Rev k="IP remota" v={f.ipRemote} />
          </div>
        </div>
      )}

      {/* Navegación */}
      <div className="mt-2 flex items-center justify-between gap-2">
        <Button variant="secondary" onClick={onClose} disabled={saving}>Cancelar</Button>
        <div className="flex gap-2">
          {step > 0 && <Button variant="secondary" onClick={() => setStep((s) => s - 1)} disabled={saving}><Icon name="arrow-left" size={15} /> Atrás</Button>}
          {step < STEPS.length - 1 ? (
            <Button
              onClick={() => {
                const next = step + 1;
                // Al entrar a la revisión, consultar duplicados de documento y dirección
                // (avisan, no bloquean).
                if (next === STEPS.length - 1) {
                  void checkDup({
                    docNumber: f.docNumber || undefined,
                    addressLine: f.addressLine || undefined,
                    departmentRef: f.departmentRef || undefined,
                    cityRef: f.cityRef || undefined,
                    localityRef: f.localityRef || undefined,
                    neighborhood: f.neighborhood || undefined,
                  });
                }
                setStep(next);
              }}
            >
              Siguiente <Icon name="arrow-right" size={15} /></Button>
          ) : (
            <Button onClick={submit} disabled={saving}>
              <Icon name={saving ? "loader" : "check"} size={15} className={saving ? "animate-spin" : ""} />
              {saving ? "Guardando…" : mode === "edit" ? "Guardar cambios" : "Crear cliente"}
            </Button>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** Sub-sección con título, separada por una línea guía y espacio (menos la primera). */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border-subtle pt-4 first:border-t-0 first:pt-0">
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">
        <span className="h-1.5 w-1.5 rounded-full bg-brand" />
        {title}
      </div>
      {children}
    </div>
  );
}

function Rev({ k, v }: { k: string; v?: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border-subtle py-1">
      <span className="text-text-tertiary">{k}</span>
      <span className="text-right font-medium text-text-primary">{v || "—"}</span>
    </div>
  );
}
