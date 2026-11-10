import {
  Injectable,
  HttpException,
  ServiceUnavailableException,
  ForbiddenException,
} from '@nestjs/common';
import {
  DynamoDBClient,
  TransactWriteItemsCommand,
  UpdateItemCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

export class UploadLimitException extends HttpException {
  constructor(readonly retryAfter: number) {
    super(
      {
        statusCode: 429,
        message: 'Upload limit reached. Please try again later.',
        retryAfter,
      },
      429,
    );
  }
}
export const identifier = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export function positiveSetting(name: string, fallback: number): number {
  const value =
    process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error(`Invalid configuration: ${name}`);
  return value;
}
export interface GrantState {
  mode?: string;
  uploadId?: string;
}

/** Shared, atomic reservations: never fall back to a per-process quota. */
@Injectable()
export class UploadControls {
  private readonly db = new DynamoDBClient({
    region: process.env.AWS_REGION || 'us-east-1',
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 1000, requestTimeout: 3000 },
  });
  private table(): string {
    const table = process.env.UPLOAD_QUOTA_TABLE;
    if (!table)
      throw new ServiceUnavailableException('Upload controls are unavailable.');
    return table;
  }
  private window(seconds: number) {
    const now = Math.floor(Date.now() / 1000);
    const start = Math.floor(now / seconds) * seconds;
    return {
      start,
      retryAfter: start + seconds - now,
      ttl: start + seconds + 2 * 86400,
    };
  }
  private counter(
    key: string,
    count: number,
    bytes: number,
    maxCount: number,
    maxBytes: number,
    ttl: number,
  ) {
    return {
      TableName: this.table(),
      Key: { pk: { S: key } },
      UpdateExpression: 'SET #ttl = :ttl ADD #count :count, #bytes :bytes',
      ConditionExpression:
        '(attribute_not_exists(#count) OR #count <= :countLimit) AND (attribute_not_exists(#bytes) OR #bytes <= :byteLimit)',
      ExpressionAttributeNames: {
        '#ttl': 'ttl',
        '#count': 'count',
        '#bytes': 'bytes',
      },
      ExpressionAttributeValues: {
        ':ttl': { N: String(ttl) },
        ':count': { N: String(count) },
        ':bytes': { N: String(bytes) },
        ':countLimit': { N: String(maxCount - count) },
        ':byteLimit': { N: String(maxBytes - bytes) },
      },
    };
  }
  private unavailable(): never {
    throw new ServiceUnavailableException(
      'Upload controls are unavailable. Please try again later.',
    );
  }
  async reserve(
    userId: string,
    key: string,
    size: number,
    expires: number,
  ): Promise<void> {
    const day = this.window(86400);
    const minute = this.window(60);
    const user = identifier(userId);
    const memberBytes = positiveSetting(
      'UPLOAD_MAX_BYTES_PER_DAY',
      5 * 1024 ** 3,
    );
    const globalBytes = positiveSetting(
      'UPLOAD_MAX_GLOBAL_BYTES_PER_DAY',
      100 * 1024 ** 3,
    );
    if (size > memberBytes || size > globalBytes)
      throw new UploadLimitException(day.retryAfter);
    try {
      await this.reserveTransaction(
        new TransactWriteItemsCommand({
          ClientRequestToken: identifier(key).slice(0, 36),
          TransactItems: [
            {
              Update: this.counter(
                `sessions:${user}:${minute.start}`,
                1,
                0,
                positiveSetting('UPLOAD_MAX_SESSIONS_PER_MINUTE', 20),
                1,
                minute.ttl,
              ),
            },
            {
              Update: this.counter(
                `member:${user}:${day.start}`,
                1,
                size,
                positiveSetting('UPLOAD_MAX_FILES_PER_DAY', 100),
                memberBytes,
                day.ttl,
              ),
            },
            {
              Update: this.counter(
                `global:${day.start}`,
                1,
                size,
                positiveSetting('UPLOAD_MAX_GLOBAL_FILES_PER_DAY', 10000),
                globalBytes,
                day.ttl,
              ),
            },
            {
              Put: {
                TableName: this.table(),
                Item: {
                  pk: { S: `grant:${identifier(key)}` },
                  expires: { N: String(expires) },
                  ttl: { N: String(Math.ceil(expires / 1000) + 2 * 86400) },
                },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (error) {
      const e = error as {
        name?: string;
        CancellationReasons?: { Code?: string }[];
      };
      if (e.name === 'TransactionCanceledException') {
        const failures = e.CancellationReasons || [];
        if (failures.some((r) => r.Code === 'ConditionalCheckFailed')) {
          throw new UploadLimitException(
            failures[1]?.Code === 'ConditionalCheckFailed' ||
              failures[2]?.Code === 'ConditionalCheckFailed'
              ? day.retryAfter
              : minute.retryAfter,
          );
        }
      }
      this.unavailable();
    }
  }
  private async reserveTransaction(
    command: TransactWriteItemsCommand,
  ): Promise<void> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await this.db.send(command);
        return;
      } catch (error) {
        const e = error as {
          name?: string;
          CancellationReasons?: { Code?: string }[];
        };
        const reasons = e.CancellationReasons || [];
        // Retry only contention, with the exact same idempotency token and payload.
        if (
          attempt >= 3 ||
          e.name !== 'TransactionCanceledException' ||
          !reasons.some((r) => r.Code === 'TransactionConflict') ||
          reasons.some((r) => r.Code === 'ConditionalCheckFailed')
        )
          throw error;
        await delay(25 * 2 ** attempt + Math.floor(Math.random() * 25));
      }
    }
  }
  async throttle(
    userId: string,
    scope: 'sign' | 'download' | 'multipart',
  ): Promise<void> {
    const w = this.window(60);
    const limit = positiveSetting(
      scope === 'download'
        ? 'UPLOAD_MAX_DOWNLOADS_PER_MINUTE'
        : 'UPLOAD_MAX_SIGN_REQUESTS_PER_MINUTE',
      300,
    );
    try {
      await this.db.send(
        new UpdateItemCommand(
          this.counter(
            `${scope}:${identifier(userId)}:${w.start}`,
            1,
            0,
            limit,
            1,
            w.ttl,
          ),
        ),
      );
    } catch (error) {
      if ((error as Error).name === 'ConditionalCheckFailedException')
        throw new UploadLimitException(w.retryAfter);
      this.unavailable();
    }
  }
  async state(key: string): Promise<GrantState> {
    let item;
    try {
      item = (
        await this.db.send(
          new GetItemCommand({
            TableName: this.table(),
            Key: { pk: { S: `grant:${identifier(key)}` } },
            ConsistentRead: true,
          }),
        )
      ).Item;
    } catch {
      this.unavailable();
    }
    if (!item || Number(item.expires?.N || 0) < Date.now())
      throw new ForbiddenException(
        'Upload session expired. Create a new upload session.',
      );
    return { mode: item.mode?.S, uploadId: item.uploadId?.S };
  }
  async selectSingle(key: string): Promise<void> {
    try {
      await this.db.send(
        new UpdateItemCommand({
          TableName: this.table(),
          Key: { pk: { S: `grant:${identifier(key)}` } },
          UpdateExpression: 'SET #mode = :mode',
          ConditionExpression:
            'attribute_exists(pk) AND expires >= :now AND (attribute_not_exists(#mode) OR #mode = :mode)',
          ExpressionAttributeNames: { '#mode': 'mode' },
          ExpressionAttributeValues: {
            ':mode': { S: 'single' },
            ':now': { N: String(Date.now()) },
          },
        }),
      );
    } catch (error) {
      if ((error as Error).name === 'ConditionalCheckFailedException')
        throw new ForbiddenException(
          'Upload session cannot change upload mode.',
        );
      this.unavailable();
    }
  }
  /** Claim exactly once; ambiguous S3 failures never unlock a second allocation. */
  async claimMultipart(key: string): Promise<boolean> {
    try {
      await this.db.send(
        new UpdateItemCommand({
          TableName: this.table(),
          Key: { pk: { S: `grant:${identifier(key)}` } },
          UpdateExpression: 'SET #mode = :mode',
          ConditionExpression:
            'attribute_exists(pk) AND expires >= :now AND attribute_not_exists(#mode)',
          ExpressionAttributeNames: { '#mode': 'mode' },
          ExpressionAttributeValues: {
            ':mode': { S: 'multipart' },
            ':now': { N: String(Date.now()) },
          },
        }),
      );
      return true;
    } catch (error) {
      if ((error as Error).name === 'ConditionalCheckFailedException')
        return false;
      this.unavailable();
    }
  }
  async saveMultipart(key: string, uploadId: string): Promise<void> {
    try {
      await this.db.send(
        new UpdateItemCommand({
          TableName: this.table(),
          Key: { pk: { S: `grant:${identifier(key)}` } },
          UpdateExpression: 'SET uploadId = :id',
          ConditionExpression:
            '#mode = :mode AND attribute_not_exists(uploadId)',
          ExpressionAttributeNames: { '#mode': 'mode' },
          ExpressionAttributeValues: {
            ':mode': { S: 'multipart' },
            ':id': { S: uploadId },
          },
        }),
      );
    } catch {
      this.unavailable();
    }
  }
}
