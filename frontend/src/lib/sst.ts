import { cookies } from "next/headers";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000/api";
const TOKEN_COOKIE = "nexus_token";

/** Raised when the SST API rejects the request for missing/invalid auth. */
export class AuthRequiredError extends Error {
  constructor() {
    super("AUTH_REQUIRED");
    this.name = "AuthRequiredError";
  }
}

/** Server-side GET that forwards the JWT stored in the cookie as a Bearer token. */
async function get<T>(path: string): Promise<T> {
  const token = (await cookies()).get(TOKEN_COOKIE)?.value;
  const res = await fetch(`${API_URL}${path}`, {
    cache: "no-store",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (res.status === 401 || res.status === 403) throw new AuthRequiredError();
  if (!res.ok) throw new Error(`Error ${res.status} al cargar ${path}`);
  return res.json();
}

// ---- dashboard -----------------------------------------------------------
export const getSstOverview = () => get<SstOverview>("/sst/dashboard");

// ---- people / risks ------------------------------------------------------
export const getEmployees = (search = "") =>
  get<Employee[]>(`/sst/employees${search ? `?search=${encodeURIComponent(search)}` : ""}`);
export const getEmployee = (id: string) => get<EmployeeDetail>(`/sst/employees/${id}`);
export const getRiskMatrices = () => get<RiskMatrix[]>("/sst/risks/matrices");
export const getRiskEntries = () => get<RiskEntry[]>("/sst/risks/entries");

// ---- EPP / medical / training -------------------------------------------
export const getEppDeliveries = () => get<EppDelivery[]>("/sst/epp");
export const getMedicalExams = () => get<MedicalExam[]>("/sst/medical");
export const getTrainings = () => get<Training[]>("/sst/training");

// ---- incidents / inspections / CAPA / documents -------------------------
export const getIncidents = () => get<Incident[]>("/sst/incidents");
export const getInspections = () => get<Inspection[]>("/sst/inspections");
export const getFindings = () => get<Finding[]>("/sst/findings");
export const getDocuments = () => get<SstDoc[]>("/sst/documents");

// ---- emergency / brigades / drills / contractors / audits ---------------
export const getEquipment = () => get<Equipment[]>("/sst/emergency");
export const getBrigades = () => get<Brigade[]>("/sst/brigades");
export const getDrills = () => get<Drill[]>("/sst/drills");
export const getContractors = () => get<Contractor[]>("/sst/contractors");
export const getAudits = () => get<Audit[]>("/sst/audits");

// ---- alerts --------------------------------------------------------------
export const getNotifications = () => get<SstNotification[]>("/sst/alerts");

// ============================================================================
//  Types — only the fields the UI renders.
// ============================================================================
export interface SstOverview {
  personal: { examsExpiring: number; certsExpiring: number; certsExpired: number };
  riesgos: { criticalRisks: number; risksWithoutControls: number };
  epp: { deliveriesThisMonth: number; expired: number; active: number };
  incidentes: { thisMonth: number; thisYear: number; byClass: { classification: string; count: number }[] };
  cumplimiento: { compliancePct: number; openActions: number; overdueActions: number; pendingAlerts: number };
  incidentsByMonth: { months: string[]; counts: number[] };
  expirations: { label: string; exams: number; certs: number; epp: number }[];
}

export interface Employee {
  id: string;
  docNumber: string;
  firstName: string;
  lastName: string;
  position?: string | null;
  area?: string | null;
  status: string;
}
export interface EmployeeDetail extends Employee {
  email?: string | null;
  phone?: string | null;
  laborRestrictions?: string | null;
  risks: { riskEntry: RiskEntry }[];
  eppDeliveries: EppDelivery[];
  medicalExams: MedicalExam[];
  trainings: { training: Training; status: string; expiresAt?: string | null }[];
}

export interface RiskMatrix { id: string; name: string; area?: string | null; version: string; _count?: { entries: number } }
export interface RiskEntry {
  id: string; area: string; position?: string | null; activity: string;
  riskType: string; hazard: string; probability: number; impact: number; riskLevel: string;
  existingControls?: string | null;
}
export interface EppDelivery {
  id: string; deliveryDate: string; expiresAt?: string | null; status: string; quantity: number;
  employee?: { firstName: string; lastName: string; docNumber: string };
  product?: { sku: string; name: string };
}
export interface MedicalExam {
  id: string; type: string; date: string; concept: string; nextDueDate?: string | null;
  employee?: { firstName: string; lastName: string; docNumber: string };
}
export interface Training { id: string; title: string; category?: string | null; instructor?: string | null; date: string; _count?: { attendees: number } }
export interface Incident { id: string; number: string; date: string; place: string; classification: string; status: string }
export interface Inspection { id: string; number: string; date: string; targetType?: string | null; area?: string | null; globalResult: string; template?: { name: string } | null }
export interface Finding { id: string; number: string; title: string; sourceType: string; priority: string; status: string; dueAt?: string | null; _count?: { actions: number } }
export interface SstDoc { id: string; code: string; type: string; title: string; currentVersion: string; status: string; expiresAt?: string | null }
export interface Equipment { id: string; code: string; type: string; location: string; status: string; nextInspectionAt?: string | null; expiresAt?: string | null }
export interface Brigade { id: string; name: string; type?: string | null; _count?: { members: number } }
export interface Drill { id: string; number: string; type: string; date: string; scenario: string; participantsCount?: number | null }
export interface Contractor { id: string; company: string; responsibleName?: string | null; status: string; _count?: { documents: number } }
export interface Audit { id: string; number: string; type: string; date: string; auditor: string; score?: number | null }
export interface SstNotification { id: string; type: string; title: string; message: string; status: string; dueDate?: string | null }
