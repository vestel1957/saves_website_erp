import { redirect } from "next/navigation";
import { SEDES_DISPONIBLES } from "@/lib/nav";

/** El módulo no tiene vista general: cada sede tiene la suya. */
export default function EquiposDisponiblesIndex() {
  redirect(`/red/disponibles/${SEDES_DISPONIBLES[0].slug}`);
}
