import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { ServiceUnavailableException } from '@nestjs/common';
import { UploadControls, UploadLimitException } from './upload-controls';

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
  });
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
