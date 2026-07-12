import { Module } from '@nestjs/common';
import { EinvoiceController } from './einvoice.controller';
import { EinvoiceService } from './einvoice.service';
import { EinvoiceEmitService } from './einvoice-emit.service';

@Module({
  controllers: [EinvoiceController],
  providers: [EinvoiceService, EinvoiceEmitService],
  exports: [EinvoiceService, EinvoiceEmitService],
})
export class EinvoiceModule {}
