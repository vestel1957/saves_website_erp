import type { PrismaService } from '../prisma/prisma.service';

/**
 * LÁPIDA de una fila borrada aquí que también vive en el legacy.
 *
 * El problema que resuelve: borrar en Nexus una fila que vino del legacy no la borraba
 * allá, y la sincronización de ida —que da de alta todo lo que ve en el legacy y no
 * tiene aquí— la volvía a crear en la pasada siguiente. El borrado se deshacía solo en
 * quince minutos y desde la pantalla parecía que no se hubiera guardado.
 *
 * Anotar la lápida ANTES de borrar es lo que hace que el borrado sobreviva: la ida la
 * consulta para no resucitar la fila, y el writeback la usa para llevarse el borrado al
 * legacy cuando su gate está abierto. Las filas nacidas aquí (`legacyId` null) no
 * necesitan lápida: allá no existen.
 *
 * No lanza: un fallo anotando no puede impedir un borrado que el usuario ya autorizó.
 * Lo peor que pasa entonces es lo que pasaba siempre —que la ida la reponga—, y queda
 * en el log.
 */
export async function anotarBorradoLegacy(
  prisma: PrismaService,
  entity: 'material' | 'equipment' | 'supplyOrder' | 'subInvoice' | 'supplier',
  fila: { legacyId: number | null },
  opts: { label?: string | null; deletedBy?: string | null } = {},
): Promise<void> {
  if (fila?.legacyId == null) return;
  try {
    await prisma.legacyDeletion.upsert({
      where: { entity_legacyId: { entity, legacyId: fila.legacyId } },
      create: { entity, legacyId: fila.legacyId, label: opts.label ?? null, deletedBy: opts.deletedBy ?? null },
      // Se vuelve a borrar algo que ya tenía lápida (la ida lo repuso antes de que
      // existiera este registro): se reabre para que el writeback lo intente otra vez.
      update: { deletedAt: new Date(), pushedAt: null, note: null, deletedBy: opts.deletedBy ?? null },
    });
  } catch (e) {
    console.error(`[legacy-deletion] no se pudo anotar ${entity}#${fila.legacyId}: ${(e as Error).message}`);
  }
}
