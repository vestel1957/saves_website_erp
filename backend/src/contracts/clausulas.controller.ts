import { ContractsService } from './contracts.service';
import { ClausulaDto, UpdateClausulaDto } from './dto/clausula.dto';
import { APP_PERMISSIONS } from '../auth/permissions.catalog';

/**
 * Catálogo de cláusulas de permanencia mínima.
 *
 * LEER lo puede cualquiera que dé de alta clientes (la cajera elige la cláusula al
 * crear el abonado); ESCRIBIR exige `contracts.manage`, porque una cifra mal puesta
 * aquí es lo que se le cobra a un cliente que quiere retirarse.
 */
export class ClausulasController {
  constructor(private readonly contracts: ContractsService) {}

  list(soloActivas?: string) {
    return this.contracts.clausulas(soloActivas === '1' || soloActivas === 'true');
  }

  create(dto: ClausulaDto) {
    return this.contracts.crearClausula(dto);
  }

  update(id: string, dto: UpdateClausulaDto) {
    return this.contracts.actualizarClausula(id, dto);
  }

  remove(id: string) {
    return this.contracts.eliminarClausula(id);
  }
}
