"use client";

import { Facturacion } from "./Facturacion";
import { Recaudo } from "./Recaudo";
import { VentasSede } from "./VentasSede";
import { IngresosEgresos } from "./IngresosEgresos";
import { Ordenes } from "./Ordenes";
import { EstadisticasServicios } from "./EstadisticasServicios";
import { CortesActivaciones } from "./CortesActivaciones";
import { Movimientos } from "./Movimientos";
import { TopDeudores } from "./TopDeudores";
import { CarteraSeguimiento } from "./CarteraSeguimiento";
import { ReporteIva } from "./ReporteIva";
import { RendimientoTecnicos } from "./RendimientoTecnicos";
import { RecaudoFuncionario } from "./RecaudoFuncionario";
import { Anulaciones } from "./Anulaciones";
import { Afiliados } from "./Afiliados";
import { ActividadSistema } from "./ActividadSistema";
import { Tendencias } from "./Tendencias";
import { IndiceRecaudo, Arpu, CapacidadRed, Reincidencia, Permanencia } from "./IspReportes";

/** Elige el cuerpo del reporte. Único sitio que conoce la lista completa. */
export function ReportBody({ rep, data, from, to }: { rep: string; data: any; from: string; to: string }) {
  switch (rep) {
    case "tendencias": return <Tendencias data={data} />;
    case "indice-recaudo": return <IndiceRecaudo data={data} />;
    case "arpu": return <Arpu data={data} />;
    case "capacidad-red": return <CapacidadRed data={data} />;
    case "reincidencia": return <Reincidencia data={data} />;
    case "permanencia": return <Permanencia data={data} />;
    case "facturacion": return <Facturacion data={data} />;
    case "recaudo": return <Recaudo data={data} />;
    case "ventas-sede": return <VentasSede data={data} />;
    case "ingresos-egresos": return <IngresosEgresos data={data} />;
    case "cartera": return <TopDeudores data={data} />;
    case "cartera-seguimiento": return <CarteraSeguimiento data={data} />;
    case "iva": return <ReporteIva data={data} />;
    case "ordenes": return <Ordenes data={data} />;
    case "cortes-activaciones": return <CortesActivaciones data={data} />;
    case "estado-clientes": return <EstadisticasServicios data={data} />;
    case "altas-retiros": return <Movimientos data={data} />;
    case "tecnicos": return <RendimientoTecnicos data={data} from={from} to={to} />;
    case "recaudo-funcionario": return <RecaudoFuncionario data={data} />;
    case "afiliados": return <Afiliados data={data} />;
    case "anulaciones": return <Anulaciones data={data} />;
    case "actividad": return <ActividadSistema data={data} />;
    default: return null;
  }
}
