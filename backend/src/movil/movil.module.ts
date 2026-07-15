import { Module } from '@nestjs/common';
import { MovilService } from './movil.service';
import { MovilController } from './movil.controller';

/** Móviles / cuadrillas de técnicos. */
@Module({
  controllers: [MovilController],
  providers: [MovilService],
  exports: [MovilService],
})
export class MovilModule {}
