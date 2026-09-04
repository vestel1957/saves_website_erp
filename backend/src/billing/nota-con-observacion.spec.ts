/**
 * La observación de una nota crédito/débito es OBLIGATORIA.
 *
 * Contabilidad rebajaba una factura y en el documento quedaba un renglón "Nota
 * Credito" mudo: meses después nadie sabía si fue una depuración de cartera, un
 * descuento autorizado o una retención. Como la nota mueve plata, el porqué es
 * parte del documento y no un campo "por si acaso".
 *
 * Se valida el DTO directo (sin BD ni servidor): es donde vive la regla.
 */
import 'reflect-metadata';
import { validar } from '../core/http/validar';
import { CreateNoteDto } from './dto/facturas.dto';

const nota = (extra: Record<string, unknown>) => ({ type: 'CREDITO', amount: 15000, ...extra });

describe('CreateNoteDto · observación obligatoria', () => {
  it('rechaza la nota sin observación', () => {
    expect(() => validar(CreateNoteDto, nota({}))).toThrow(/observación/i);
  });

  it('rechaza la observación en blanco (sólo espacios)', () => {
    expect(() => validar(CreateNoteDto, nota({ description: '      ' }))).toThrow(/observación/i);
  });

  it('rechaza un motivo demasiado corto para explicar nada', () => {
    expect(() => validar(CreateNoteDto, nota({ description: 'ok' }))).toThrow(/observación/i);
  });

  it('acepta el motivo y lo guarda sin espacios de sobra', () => {
    const dto = validar(CreateNoteDto, nota({ description: '  Depuración de cartera, autoriza cartera  ' }));
    expect(dto.description).toBe('Depuración de cartera, autoriza cartera');
  });
});
