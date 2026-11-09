import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { AppModule } from './app.module';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/file'),
}));

const secret = 'test-only-member-secret-at-least-32-bytes';
const file = {
  purpose: 'cv',
  filename: 'resume.pdf',
  contentType: 'application/pdf',
  size: 100,
};
function token(claims: Record<string, unknown> = {}) {
  const encode = (value: object) =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    iss: 'https://issuer.example',
    userId: '123',
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  })}`;
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`;
}

describe('Files API HTTP contract', () => {
  let app: INestApplication;
  beforeAll(async () => {
    Object.assign(process.env, {
      AUTH_SECRET: secret,
      VALID_ISSUERS: '["https://issuer.example"]',
      AWS_REGION: 'us-east-1',
      UPLOAD_SIGNING_SECRET: 'test-only-upload-secret-at-least-32-bytes',
      UPLOAD_ATTACHMENT_BUCKET: 'attachments',
      UPLOAD_PUBLIC_API_URL: 'https://api.example/v6/uploads/files',
    });
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('v6');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    await app.init();
  });
  afterAll(async () => app.close());

  it('exposes unauthenticated health only on the new service path', async () => {
    await request(app.getHttpServer())
      .get('/v6/uploads/files/health')
      .expect(200, { status: 'ok' });
    await request(app.getHttpServer())
      .post('/v6/reviews/uploads/sessions')
      .send(file)
      .expect(404);
  });

  it.each([
    ['missing token', undefined],
    ['invalid signature', 'invalid.token.signature'],
    ['expired token', token({ exp: 1 })],
    ['unverified member', token({ email_verified: false })],
    ['wrong issuer', token({ iss: 'https://untrusted.example' })],
    [
      'machine token',
      token({ userId: undefined, gty: 'client-credentials', roles: [] }),
    ],
  ])('rejects %s for session creation', async (_label, authorization) => {
    const call = request(app.getHttpServer()).post(
      '/v6/uploads/files/sessions',
    );
    if (authorization) call.set('Authorization', `Bearer ${authorization}`);
    await call.send(file).expect(401);
  });

  it('creates and signs uploads and resolves a read capability without exposing its upload grant', async () => {
    const auth = `Bearer ${token()}`;
    const session = (
      await request(app.getHttpServer())
        .post('/v6/uploads/files/sessions')
        .set('Authorization', auth)
        .send(file)
        .expect(201)
    ).body;
    expect(session.url).toMatch(
      /^https:\/\/api\.example\/v6\/uploads\/files\/[^/]+$/,
    );
    expect(session.bucket).toBe('attachments');
    await request(app.getHttpServer())
      .post('/v6/uploads/files/sign')
      .set('Authorization', auth)
      .send({ token: session.token, key: session.key, method: 'PUT' })
      .expect(201, { url: 'https://signed.example/file' });
    const download = await request(app.getHttpServer())
      .get(new URL(session.url).pathname)
      .expect(302);
    expect(download.headers.location).toBe('https://signed.example/file');
    expect(download.headers['cache-control']).toBe('private, no-store');
    await request(app.getHttpServer())
      .get(`/v6/uploads/files/${session.token}`)
      .expect(403);
  });

  it('rejects caller-controlled destinations and invalid metadata before creating a grant', async () => {
    for (const input of [
      { ...file, bucket: 'other' },
      { ...file, filename: '../resume.pdf' },
      { ...file, size: 0 },
    ]) {
      await request(app.getHttpServer())
        .post('/v6/uploads/files/sessions')
        .set('Authorization', `Bearer ${token()}`)
        .send(input)
        .expect(400);
    }
  });
});
