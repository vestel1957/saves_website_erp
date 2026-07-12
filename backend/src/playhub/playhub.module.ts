import { Module } from '@nestjs/common';
import { PlayhubClient } from './playhub.client';
import { PlayhubService } from './playhub.service';
import { PlayhubController } from './playhub.controller';

/** Integración PlayHub (OTT/IPTV): cliente de la API + lógica de suscripciones. */
@Module({
  controllers: [PlayhubController],
  providers: [PlayhubClient, PlayhubService],
  exports: [PlayhubService],
})
export class PlayhubModule {}
