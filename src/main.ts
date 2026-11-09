import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { Request, Response, NextFunction } from 'express';
import { AppModule } from './app.module';

async function bootstrap() {
  for (const key of [
    'VALID_ISSUERS',
    'UPLOAD_SIGNING_SECRET',
    'UPLOAD_PUBLIC_API_URL',
    'SUBMISSION_DMZ_S3_BUCKET',
    'UPLOAD_ATTACHMENT_BUCKET',
    'UPLOAD_FORUM_BUCKET',
    'UPLOAD_PROJECT_BUCKET',
    'UPLOAD_SHOWCASE_BUCKET',
    'UPLOAD_SHOWCASE_CDN_URL',
    'CORS_ORIGINS',
  ]) {
    if (!process.env[key])
      throw new Error(`Missing required configuration: ${key}`);
  }
  if (Buffer.byteLength(process.env.UPLOAD_SIGNING_SECRET!, 'utf8') < 32) {
    throw new Error('UPLOAD_SIGNING_SECRET must contain at least 32 bytes.');
  }
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  const { json } = await import('express');
  app.use(json({ limit: '16kb' }));
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.setGlobalPrefix('v6');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.enableCors({
    origin: process.env.CORS_ORIGINS!.split(',').map((value) => value.trim()),
    credentials: true,
    methods: ['GET', 'POST', 'OPTIONS'],
  });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT || 3000), '0.0.0.0');
}

void bootstrap().catch((error) => {
  console.error(error instanceof Error ? error.message : 'Startup failed');
  process.exitCode = 1;
});
