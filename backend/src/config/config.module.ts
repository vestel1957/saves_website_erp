import { Module } from '@nestjs/common';
import { ConfigController } from './config.controller';
import { ConfigDataService } from './config.service';

@Module({ controllers: [ConfigController], providers: [ConfigDataService], exports: [ConfigDataService] })
export class ConfigDataModule {}
