import { Module } from '@nestjs/common';
import { ManualsController } from './manuals.controller';
import { ManualsService } from './manuals.service';

/** Manuales de uso por rol (PDF generados desde documentacion/fuentes/*.md). */
@Module({ controllers: [ManualsController], providers: [ManualsService] })
export class ManualsModule {}
