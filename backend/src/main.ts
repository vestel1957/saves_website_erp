import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import { AppModule } from './app.module';

async function bootstrap() {
  // rawBody: true expone req.rawBody (Buffer) para verificar la firma del
  // webhook de WhatsApp Cloud API (X-Hub-Signature-256).
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Comprime las respuestas (gzip). Los listados JSON viajan ~5-8x más livianos.
  app.use(compression());

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? 'http://localhost:3000',
    credentials: true,
  });

  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`🚀 Nexus API running on http://localhost:${port}/api`);
}

bootstrap();
