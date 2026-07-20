import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import compression from 'compression';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';

async function bootstrap() {
  // rawBody: true expone req.rawBody (Buffer) para verificar la firma del
  // webhook de WhatsApp Cloud API (X-Hub-Signature-256).
  const app = await NestFactory.create(AppModule, { rawBody: true });

  // Comprime las respuestas (gzip). Los listados JSON viajan ~5-8x más livianos.
  app.use(compression());

  // Cabeceras de seguridad. Dos ajustes conscientes sobre los valores por defecto:
  //  - `crossOriginResourcePolicy` en 'cross-origin': el frontend corre en otro
  //    puerto (3060) que la API (3061), o sea otro origen. Con el 'same-origin' que
  //    trae helmet por defecto, el navegador bloquearía los adjuntos y PDFs.
  //  - CSP desactivada: esta app sólo sirve JSON y ficheros de descarga, nunca HTML
  //    propio, así que una CSP aquí no protege nada y sí puede romper clientes.
  app.use(
    helmet({
      crossOriginResourcePolicy: { policy: 'cross-origin' },
      contentSecurityPolicy: false,
    }),
  );

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );
  // Traduce los errores de Prisma al HTTP que les toca (P2002 -> 409, P2025 -> 404…)
  // en vez de devolver 500 con el stack. Va después del pipe para no alterar la forma
  // de los errores de validación, que el frontend ya sabe leer.
  app.useGlobalFilters(new AllExceptionsFilter());

  app.enableCors({
    origin: process.env.CORS_ORIGIN?.split(',') ?? 'http://localhost:3000',
    credentials: true,
  });

  const port = process.env.PORT ? Number(process.env.PORT) : 4000;
  await app.listen(port);
  console.log(`🚀 Nexus API running on http://localhost:${port}/api`);
}

bootstrap();
