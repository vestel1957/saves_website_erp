import { BadRequestException } from '../core/http/errores';
import type { Response } from 'express';
import { memoryStorage } from 'multer';
import { InventoryService } from './inventory.service';
import { InventoryAlertsService } from './alerts.service';
import { CreateMaterialDto, ReceiveActaDto, SimpleCatalogDto, TransferDto, UpdateMaterialDto, WarehouseDto } from './dto/inventory.dto';
import { actaPdf } from '../common/pdf/pdf-docs';
import { AuthUser } from '../auth/current-user.decorator';

/**
 * Inventario / material (migrado de saves-vestel).
 *
 * El área por defecto es administración/técnicos. Caja NO entra al módulo: sólo a
 * los seis endpoints que componen "entregarle material a un técnico" (traspaso +
 * actas), marcados uno a uno con su propio `@RequireArea` — el decorador de método
 * gana sobre el de la clase (`Reflector.getAllAndOverride`). Se hace endpoint por
 * endpoint y no abriendo el controlador entero para que la cajera no pueda crear
 * material, bodegas ni categorías por API aunque la pantalla no se lo ofrezca.
 */
export const TRASPASOS = ['administracion', 'tecnicos', 'caja'] as const;

export class InventoryController {
  constructor(
    private readonly inv: InventoryService,
    private readonly alertsSvc: InventoryAlertsService,
  ) {}

  stats(user?: AuthUser) { return this.inv.stats(user); }

  // ── Alertas de stock (campana del TopNav) ──────────────────────────────────
  // Van antes de `materials/:id` y compañía por claridad; no colisionan porque
  // 'alerts' es un segmento literal.
  alerts() { return this.alertsSvc.list(); }
  runAlerts() { return this.alertsSvc.run(); }
  readAllAlerts() { return this.alertsSvc.readAll(); }

  categories() { return this.inv.categories(); }
  /**
   * Sedes, para decir de cuál es cada bodega (y cuál es la principal, a donde el
   * técnico devuelve). Va aquí y no se toma prestada de otro módulo porque
   * `/auth/branches` exige administrar usuarios y `/network/branches` no trae el
   * `legacyId`, que es justo la llave que guarda `MaterialWarehouse.branchLegacy`.
   */
  branches() { return this.inv.branches(); }
  /** Bodegas: las necesita el selector origen/destino del traspaso. */
  warehouses(user?: AuthUser) { return this.inv.warehouses(user); }
  createCategory(dto: SimpleCatalogDto) { return this.inv.createCategory(dto); }
  updateCategory(id: string, dto: SimpleCatalogDto) { return this.inv.updateCategory(id, dto); }
  deleteCategory(id: string) { return this.inv.deleteCategory(id); }
  createWarehouse(dto: WarehouseDto, user?: AuthUser) { return this.inv.createWarehouse(dto, user); }
  updateWarehouse(id: string, dto: WarehouseDto, user?: AuthUser) { return this.inv.updateWarehouse(id, dto, user); }
  deleteWarehouse(id: string, user?: AuthUser) { return this.inv.deleteWarehouse(id, user); }

  /** Existencias de una bodega: es lo que se elige para entregar en el traspaso. */
  materials(
    search?: string, categoryId?: string, warehouseId?: string,
    lowStock?: string, onlyConsumable?: string,
    page?: string, pageSize?: string,
    sortBy?: string, sortDir?: string,
    user?: AuthUser,
  ) {
    return this.inv.materials({ search, categoryId, warehouseId, lowStock, onlyConsumable, page: Number(page), pageSize: Number(pageSize), sortBy, sortDir }, user);
  }
  materialDetail(id: string, user?: AuthUser) { return this.inv.materialDetail(id, user); }
  createMaterial(dto: CreateMaterialDto, user?: AuthUser) { return this.inv.createMaterial(dto, user); }

  /** Importa materiales desde un Excel (.xlsx). Campo "file". */
  importMaterials(file?: { buffer: Buffer }) {
    if (!file) throw new BadRequestException('Sube un archivo .xlsx en el campo "file".');
    return this.inv.importMaterials(file.buffer);
  }
  updateMaterial(id: string, dto: UpdateMaterialDto, user?: AuthUser) { return this.inv.updateMaterial(id, dto, user); }
  deleteMaterial(id: string, user?: AuthUser) { return this.inv.deleteMaterial(id, user); }

  // ── Traspasos y actas ─────────────────────────────────────────────────────
  // Abiertos también a caja: es la entrega de material al técnico. Recibir sigue
  // siendo del designado (`receiveActa` lo comprueba contra `assignedToId`), así
  // que abrir la ruta no deja a nadie firmar un acta ajena.
  /**
   * Lo que la pantalla de nuevo traspaso puede hacer y ofrecer: modos, bodegas,
   * técnicos de su sede y quién recibe en cada destino. La regla se aplica igual
   * en `transfer()`; esto sólo evita pintarle a la cajera lo que no puede mover.
   */
  transferContext(user: AuthUser) { return this.inv.transferContext(user); }
  transfer(dto: TransferDto, user: AuthUser) { return this.inv.transfer(dto, user); }
  actas(page?: string, pageSize?: string, search?: string, status?: string, sortBy?: string, sortDir?: string, user?: AuthUser) { return this.inv.actas({ page: Number(page), pageSize: Number(pageSize), search, status, sortBy, sortDir }, user); }
  actaDetail(id: string, user: AuthUser) { return this.inv.actaDetail(id, user); }
  receiveActaItem(id: string, itemId: string, user: AuthUser) { return this.inv.receiveActaItem(id, itemId, user); }
  // El acta en PDF: la misma que se le manda por WhatsApp a quien debe firmarla.
  
  async actaPdf(id: string, res: Response) {
    const d = await this.inv.actaPdfData(id);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="acta-traspaso-${d.numero}.pdf"`);
    actaPdf(res, d);
  }
  /** Reenvía el acta por WhatsApp (si no le llegó al designado). */
  
  sendActa(id: string, user: AuthUser) { return this.inv.reenviarActa(id, user); }
  /** Código de firma para cerrar el acta (llega al WhatsApp de quien recibe). */
  
  actaOtp(id: string, user: AuthUser) { return this.inv.pedirCodigoActa(id, user); }
  
  receiveActa(id: string, dto: ReceiveActaDto, user: AuthUser) { return this.inv.receiveActa(id, user, dto?.code); }
}
