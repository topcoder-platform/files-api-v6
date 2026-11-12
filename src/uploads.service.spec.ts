import {
  BadRequestException,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { CreateMultipartUploadCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHmac } from 'node:crypto';
import { UPLOAD_PART_SIZE, UploadsService } from './uploads.service';
import { UploadControls } from './upload-controls';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('https://signed.example/file'),
}));
const signed = jest.mocked(getSignedUrl);
const member = { userId: '123', isMachine: false };
const file = {
  purpose: 'submission' as const,
  filename: 'solution.zip',
  contentType: 'application/zip',
  size: 15 * 1024 * 1024,
};

describe('Uppy S3 uploads', () => {
  let service: UploadsService;
  let controls: {
    reserve: jest.Mock;
    throttle: jest.Mock;
    state: jest.Mock;
    selectSingle: jest.Mock;
    claimMultipart: jest.Mock;
    saveMultipart: jest.Mock;
    resolveDownload: jest.Mock;
  };
  beforeEach(() => {
    Object.assign(process.env, {
      UPLOAD_SIGNING_SECRET: 'test-only-upload-secret',
      SUBMISSION_DMZ_S3_BUCKET: 'submission-dmz',
      UPLOAD_ATTACHMENT_BUCKET: 'attachments',
      UPLOAD_FORUM_BUCKET: 'forum-files',
      UPLOAD_PROJECT_BUCKET: 'project-files',
      UPLOAD_SHOWCASE_BUCKET: 'showcase-files',
      UPLOAD_SHOWCASE_CDN_URL: 'https://showcase.example',
      UPLOAD_PUBLIC_API_URL: 'https://api.example/v6/uploads/files',
    });
    const downloads = new Map<string, string>();
    controls = {
      reserve: jest
        .fn()
        .mockImplementation(async (_user, _key, _size, _expires, download) => {
          if (download) downloads.set(download.token, download.grant);
        }),
      resolveDownload: jest.fn().mockImplementation(async (token) => {
        if (!downloads.has(token))
          throw new ForbiddenException('Invalid download handle.');
        return downloads.get(token);
      }),
      throttle: jest.fn().mockResolvedValue(undefined),
      state: jest.fn().mockResolvedValue({}),
      selectSingle: jest.fn().mockResolvedValue(undefined),
      claimMultipart: jest.fn().mockResolvedValue(true),
      saveMultipart: jest.fn().mockResolvedValue(undefined),
    };
    service = new UploadsService(controls as unknown as UploadControls);
    signed.mockClear();
  });
  afterEach(() => jest.restoreAllMocks());

  it('reserves the full size before returning server-owned submission keys and private storage URLs', async () => {
    const one = await service.create(file, member);
    expect(one.bucket).toBe('submission-dmz');
    expect(one.url).toMatch(
      /^https:\/\/s3\.amazonaws\.com\/submission-dmz\/uppy\/submission\//,
    );
    expect(one.key).not.toBe((await service.create(file, member)).key);
    expect(one.partSize).toBe(UPLOAD_PART_SIZE);
    expect(controls.reserve).toHaveBeenCalledWith(
      '123',
      one.key,
      file.size,
      expect.any(Number),
      undefined,
    );
  });
  it('requires a member and validates file types and sizes before reserving quota', async () => {
    await expect(service.create(file, undefined as any)).rejects.toThrow(
      UnauthorizedException,
    );
    await expect(
      service.create(file, { ...member, isMachine: true }),
    ).rejects.toThrow(UnauthorizedException);
    for (const input of [
      { ...file, filename: 'code.js' },
      { ...file, purpose: 'cv' as const, filename: 'cv.doc', size: 20 },
      { ...file, purpose: 'cv' as const, filename: 'cv.pdf' },
      { ...file, size: 0 },
    ])
      await expect(service.create(input, member)).rejects.toThrow(
        BadRequestException,
      );
    expect(controls.reserve).not.toHaveBeenCalled();
  });
  it('reserves an inclusive two-MiB Support file and signs only that size in the attachment bucket', async () => {
    const session = await service.create(
      {
        purpose: 'support',
        filename: 'evidence.pdf',
        contentType: 'application/pdf',
        size: 2 * 1024 * 1024,
      },
      member,
    );
    expect(session.bucket).toBe('attachments');
    expect(session.key).toMatch(/^uppy\/support\/[^/]+\/evidence.pdf$/);
    expect(session.url).toMatch(/^https:\/\/api.example\/v6\/uploads\/files\//);
    expect(controls.reserve).toHaveBeenCalledWith(
      '123',
      session.key,
      2 * 1024 * 1024,
      expect.any(Number),
      expect.objectContaining({
        token: expect.any(String),
        grant: expect.any(String),
      }),
    );
    await service.sign(
      { token: session.token, key: session.key, method: 'PUT' },
      member,
    );
    expect((signed.mock.calls[0][1] as any).input.ContentLength).toBe(
      2 * 1024 * 1024,
    );
  });
  it('enforces the Support size and extension/MIME contract before reserving quota', async () => {
    const support = {
      purpose: 'support' as const,
      filename: 'notes.txt',
      contentType: 'text/plain',
      size: 1,
    };
    for (const input of [
      { ...support, size: 0 },
      { ...support, size: 2 * 1024 * 1024 + 1 },
      { ...support, filename: 'image.svg', contentType: 'image/svg+xml' },
      { ...support, filename: 'page.html', contentType: 'text/html' },
      { ...support, contentType: 'application/json' },
      { ...support, filename: 'file.exe' },
    ])
      await expect(service.create(input, member)).rejects.toThrow(
        BadRequestException,
      );
    expect(controls.reserve).not.toHaveBeenCalled();
  });
  it('retains Support archive aliases and safely delivers structured text attachments', async () => {
    for (const [filename, contentType] of [
      ['archive.GZ', 'application/x-gzip'],
      ['archive.rar', 'application/x-rar-compressed'],
      ['data.xml', 'text/xml'],
      ['data.json', 'application/json'],
    ]) {
      const session = await service.create(
        { purpose: 'support', filename, contentType, size: 10 },
        member,
      );
      await service.download(session.url.split('/').at(-1)!);
      const input = (signed.mock.calls.at(-1)?.[1] as any).input;
      expect(input.ResponseContentDisposition).toMatch(/^attachment;/);
      expect(input.ResponseContentType).toBe('application/octet-stream');
    }
  });
  it('never returns a grant when shared quota reservation fails', async () => {
    controls.reserve.mockRejectedValue(new Error('quota unavailable'));
    await expect(service.create(file, member)).rejects.toThrow(
      'quota unavailable',
    );
    expect(signed).not.toHaveBeenCalled();
  });
  it('rejects tampering, other members, expiry and arbitrary keys before spending signing capacity', async () => {
    const session = await service.create(file, member);
    const input = {
      token: session.token,
      key: session.key,
      method: 'PUT' as const,
    };
    await expect(
      service.sign({ ...input, token: `${session.token}x` }, member),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.sign(input, { ...member, userId: '456' }),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.sign({ ...input, key: 'existing/private.zip' }, member),
    ).rejects.toThrow(ForbiddenException);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 25 * 3600000);
    await expect(service.sign(input, member)).rejects.toThrow(
      ForbiddenException,
    );
    expect(signed).not.toHaveBeenCalled();
    expect(controls.throttle).not.toHaveBeenCalled();
  });
  it('bounds signed PUT size and lifetime and never signs multipart allocation URLs for S3', async () => {
    const session = await service.create(file, member);
    const input = {
      token: session.token,
      key: session.key,
      method: 'PUT' as const,
    };
    await service.sign(input, member);
    expect((signed.mock.calls[0][1] as any).input.ContentLength).toBe(
      file.size,
    );
    expect(signed.mock.calls[0][2]).toEqual({ expiresIn: 300 });
    expect(controls.selectSingle).toHaveBeenCalledWith(session.key);
    const start = await service.sign({ ...input, method: 'POST' }, member);
    expect(start.url).toBe(
      `https://api.example/v6/uploads/files/multipart/${session.token}`,
    );
    expect(signed).toHaveBeenCalledTimes(1);
  });
  it('binds multipart signing to the single server-recorded allocation and exact part lengths', async () => {
    const session = await service.create(file, member);
    const input = {
      token: session.token,
      key: session.key,
      method: 'PUT' as const,
      uploadId: 'server-allocation',
    };
    controls.state.mockResolvedValue({
      mode: 'multipart',
      uploadId: 'server-allocation',
    });
    for (const [operation, name] of [
      [{ method: 'PUT', partNumber: 1 }, 'UploadPartCommand'],
      [{ method: 'PUT', partNumber: 2 }, 'UploadPartCommand'],
      [{ method: 'GET' }, 'ListPartsCommand'],
      [{ method: 'POST' }, 'CompleteMultipartUploadCommand'],
      [{ method: 'DELETE' }, 'AbortMultipartUploadCommand'],
    ] as const) {
      await service.sign({ ...input, ...operation }, member);
      expect(signed.mock.calls.at(-1)?.[1].constructor.name).toBe(name);
    }
    expect((signed.mock.calls[0][1] as any).input.ContentLength).toBe(
      UPLOAD_PART_SIZE,
    );
    expect((signed.mock.calls[1][1] as any).input.ContentLength).toBe(
      5 * 1024 * 1024,
    );
    await expect(
      service.sign({ ...input, uploadId: 'unrecorded', partNumber: 1 }, member),
    ).rejects.toThrow(ForbiddenException);
    await expect(
      service.sign({ ...input, partNumber: 3 }, member),
    ).rejects.toThrow(BadRequestException);
  });
  it('returns the recorded upload ID on creation replay without allocating another upload', async () => {
    const session = await service.create(file, member);
    const send = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue({ UploadId: 'one&only' } as never);
    expect(await service.createMultipart(session.token)).toContain(
      '<UploadId>one&amp;only</UploadId>',
    );
    expect(send.mock.calls[0][0]).toBeInstanceOf(CreateMultipartUploadCommand);
    expect(controls.saveMultipart).toHaveBeenCalledWith(
      session.key,
      'one&only',
    );
    controls.state.mockResolvedValue({
      mode: 'multipart',
      uploadId: 'one&only',
    });
    await service.createMultipart(session.token);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('losing concurrent initializers cannot allocate another S3 upload', async () => {
    const session = await service.create(file, member);
    controls.claimMultipart.mockResolvedValue(false);
    controls.state
      .mockResolvedValueOnce({})
      .mockResolvedValue({ mode: 'multipart', uploadId: 'winner' });
    const send = jest.spyOn(S3Client.prototype, 'send');
    expect(await service.createMultipart(session.token)).toContain(
      '<UploadId>winner</UploadId>',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('rejects a single/multipart mode switch and fails closed while initialization is unresolved', async () => {
    const session = await service.create(file, member);
    const send = jest.spyOn(S3Client.prototype, 'send');
    controls.state.mockResolvedValue({ mode: 'single' });
    await expect(service.createMultipart(session.token)).rejects.toThrow(
      ForbiddenException,
    );
    controls.state.mockResolvedValue({ mode: 'multipart' });
    controls.claimMultipart.mockResolvedValue(false);
    await expect(service.createMultipart(session.token)).rejects.toThrow(
      'Multipart initialization is pending',
    );
    expect(send).not.toHaveBeenCalled();
  });
  it('never gives submission grants download access, even with a valid download-scope signature', async () => {
    const session = await service.create(file, member);
    const payload = session.token.split('.')[0];
    const signature = createHmac('sha256', process.env.UPLOAD_SIGNING_SECRET!)
      .update(`download:${payload}`)
      .digest('base64url');
    await expect(service.download(`${payload}.${signature}`)).rejects.toThrow(
      'Use submission download authorization.',
    );
    expect(signed).not.toHaveBeenCalled();
  });
  it('preserves durable attachment links and keeps upload and download scopes separate', async () => {
    const session = await service.create(
      {
        ...file,
        purpose: 'cv',
        filename: 'cv.pdf',
        contentType: 'application/pdf',
        size: 100,
      },
      member,
    );
    const token = session.url.split('/').at(-1)!;
    await expect(service.download(token)).resolves.toBe(
      'https://signed.example/file',
    );
    expect(
      (signed.mock.calls[0][1] as any).input.ResponseContentDisposition,
    ).toMatch(/^inline;/);
    await expect(
      service.sign({ token, key: session.key, method: 'PUT' }, member),
    ).rejects.toThrow(ForbiddenException);
    await expect(service.download(session.token)).rejects.toThrow(
      ForbiddenException,
    );
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 86400000);
    await expect(service.download(token)).resolves.toBe(
      'https://signed.example/file',
    );
  });
  it.each(['forum', 'review', 'project'] as const)(
    'returns compact %s attachment links regardless of filename length',
    async (purpose) => {
      for (const filename of [
        'bird-species-classification-master (2).zip',
        `${'x'.repeat(240)} (1).mp4`,
      ]) {
        const session = await service.create(
          { ...file, purpose, filename, contextId: '1001120' },
          member,
        );
        expect(session.url).toMatch(
          /^https:\/\/api\.example\/v6\/uploads\/files\/[A-Za-z0-9_-]{32}$/,
        );
        const handle = session.url.split('/').at(-1)!;
        await service.download(handle);
        expect((signed.mock.calls.at(-1)?.[1] as any).input).toMatchObject({
          Bucket: session.bucket,
          Key: session.key,
          ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        });
        expect(signed.mock.calls.at(-1)?.[2]).toEqual({ expiresIn: 300 });
        expect(controls.throttle).toHaveBeenLastCalledWith(
          session.key,
          'download',
        );
        const changed = `${handle[0] === 'a' ? 'b' : 'a'}${handle.slice(1)}`;
        await expect(service.download(changed)).rejects.toThrow(
          ForbiddenException,
        );
      }
      const handles = controls.reserve.mock.calls.map((call) => call[4].token);
      expect(new Set(handles).size).toBe(handles.length);
    },
  );
  it('continues resolving legacy long links without a handle lookup after upload expiry', async () => {
    const session = await service.create({ ...file, purpose: 'forum' }, member);
    const payload = session.token.split('.')[0];
    const signature = createHmac('sha256', process.env.UPLOAD_SIGNING_SECRET!)
      .update(`download:${payload}`)
      .digest('base64url');
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 86400000);
    await expect(service.download(`${payload}.${signature}`)).resolves.toBe(
      'https://signed.example/file',
    );
    expect(controls.resolveDownload).not.toHaveBeenCalled();
    await expect(service.download(`${payload}.${signature}x`)).rejects.toThrow(
      ForbiddenException,
    );
  });
  it('does not issue read handles for submission or showcase URLs', async () => {
    for (const purpose of ['submission', 'showcase'] as const) {
      const session = await service.create({ ...file, purpose }, member);
      expect(controls.reserve.mock.calls.at(-1)?.[4]).toBeUndefined();
      expect(session.url).toBe(
        purpose === 'submission'
          ? session.storageUrl
          : `https://showcase.example/${session.key}`,
      );
    }
  });
  it('preserves DOCX MIME type and forces active content to download for every attachment destination', async () => {
    for (const [purpose, bucket] of [
      ['cv', 'attachments'],
      ['forum', 'forum-files'],
      ['project', 'project-files'],
      ['showcase', 'showcase-files'],
      ['engagement', 'attachments'],
      ['review', 'attachments'],
    ] as const) {
      const session = await service.create(
        {
          ...file,
          purpose,
          filename: purpose === 'cv' ? 'cv.docx' : 'notes.html',
          contentType:
            purpose === 'cv'
              ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
              : 'text/html',
          size: 100,
        },
        member,
      );
      expect(session.bucket).toBe(bucket);
      if (purpose !== 'showcase') {
        await service.download(session.url.split('/').at(-1)!);
        const input = (signed.mock.calls.at(-1)?.[1] as any).input;
        expect(input.ResponseContentDisposition).toMatch(/^attachment;/);
        expect(input.ResponseContentType).toBe(
          purpose === 'cv'
            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : 'application/octet-stream',
        );
      }
    }
  });
});
