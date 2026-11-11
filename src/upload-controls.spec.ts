import {
  DynamoDBClient,
  GetItemCommand,
  TransactWriteItemsCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ForbiddenException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  identifier,
  UploadControls,
  UploadLimitException,
} from './upload-controls';

describe('Shared upload controls failure behavior', () => {
  beforeEach(() => {
    process.env.UPLOAD_QUOTA_TABLE = 'unit-test-controls';
  });
  afterEach(() => jest.restoreAllMocks());
  it('returns the daily reset for member/global quota failures', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-01T23:59:30Z'));
    jest.spyOn(DynamoDBClient.prototype, 'send').mockRejectedValue({
      name: 'TransactionCanceledException',
      CancellationReasons: [
        { Code: 'None' },
        { Code: 'ConditionalCheckFailed' },
        { Code: 'None' },
        { Code: 'None' },
      ],
    } as never);
    await expect(
      new UploadControls().reserve('member', 'key', 10, Date.now() + 60000),
    ).rejects.toMatchObject({ retryAfter: 30, status: 429 });
  });
  it('fails closed when the shared store fails, instead of minting unlimited grants', async () => {
    jest
      .spyOn(DynamoDBClient.prototype, 'send')
      .mockRejectedValue(new Error('DynamoDB unreachable') as never);
    const controls = new UploadControls();
    await expect(
      controls.reserve('member', 'key', 10, Date.now() + 60000),
    ).rejects.toThrow(ServiceUnavailableException);
    await expect(controls.throttle('member', 'sign')).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(controls.state('key')).rejects.toThrow(
      ServiceUnavailableException,
    );
    await expect(controls.resolveDownload('handle')).rejects.toThrow(
      ServiceUnavailableException,
    );
  });
  it('atomically retains a durable read grant separately from expiring quotas and upload state', async () => {
    const send = jest
      .spyOn(DynamoDBClient.prototype, 'send')
      .mockResolvedValue({} as never);
    const download = {
      token: 'random-download-handle',
      grant: 'signed-read-grant',
    };
    await new UploadControls().reserve(
      'member',
      'key',
      10,
      Date.now() + 60000,
      download,
    );
    const command = send.mock.calls[0][0] as TransactWriteItemsCommand;
    expect(command).toBeInstanceOf(TransactWriteItemsCommand);
    expect(command.input.TransactItems).toHaveLength(5);
    expect(command.input.TransactItems?.[3].Put?.Item).toHaveProperty('ttl');
    const record = command.input.TransactItems?.[4].Put;
    expect(record).toEqual({
      TableName: 'unit-test-controls',
      Item: {
        pk: { S: `download:${identifier(download.token)}` },
        grant: { S: download.grant },
      },
      ConditionExpression: 'attribute_not_exists(pk)',
    });
    // A different service instance can read the record after upload state expires.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 30 * 86400000);
    send.mockResolvedValue({ Item: record?.Item } as never);
    await expect(
      new UploadControls().resolveDownload(download.token),
    ).resolves.toBe(download.grant);
    const read = send.mock.calls.at(-1)?.[0] as GetItemCommand;
    expect(read).toBeInstanceOf(GetItemCommand);
    expect(read.input).toEqual({
      TableName: 'unit-test-controls',
      Key: { pk: record?.Item?.pk },
      ConsistentRead: true,
    });
  });
  it('does not create a permanent record when no read handle is needed', async () => {
    const send = jest
      .spyOn(DynamoDBClient.prototype, 'send')
      .mockResolvedValue({} as never);
    await new UploadControls().reserve('member', 'key', 10, Date.now() + 60000);
    const command = send.mock.calls[0][0] as TransactWriteItemsCommand;
    expect(command.input.TransactItems).toHaveLength(4);
  });
  it.each([undefined, {}, { grant: { S: '' } }])(
    'rejects missing or incomplete read handles (%j)',
    async (Item) => {
      jest
        .spyOn(DynamoDBClient.prototype, 'send')
        .mockResolvedValue({ Item } as never);
      await expect(
        new UploadControls().resolveDownload('unknown'),
      ).rejects.toThrow(ForbiddenException);
    },
  );
  it('rejects a file exceeding a configured daily byte cap without touching the store', async () => {
    const send = jest.spyOn(DynamoDBClient.prototype, 'send');
    await expect(
      new UploadControls().reserve(
        'member',
        'key',
        6 * 1024 ** 3,
        Date.now() + 60000,
      ),
    ).rejects.toThrow(UploadLimitException);
    expect(send).not.toHaveBeenCalled();
  });
});
