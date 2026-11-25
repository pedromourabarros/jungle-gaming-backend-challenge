import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import { createHash } from 'node:crypto';

export interface QueueConfig {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  queueUrl: string;
  dlqUrl: string;
  eventsUrl: string;
  maxReceiveCount: number;
  visibilityTimeoutSeconds: number;
  pollWaitSeconds: number;
  requestTimeoutMs: number;
}

function integer(value: string | undefined, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error('Invalid messaging configuration');
  }
  return parsed;
}

export function queueConfig(overrides: Partial<QueueConfig> = {}): QueueConfig {
  const endpoint = overrides.endpoint ?? process.env.SQS_ENDPOINT ?? 'http://localhost:4566';
  const base = endpoint.replace(/\/$/, '') + '/000000000000/';
  const result = {
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    queueUrl: process.env.SQS_QUEUE_URL ?? base + 'wager-transactions.fifo',
    dlqUrl: process.env.SQS_DLQ_URL ?? base + 'wager-transactions-dlq.fifo',
    eventsUrl: process.env.SQS_EVENTS_QUEUE_URL ?? base + 'wager-events.fifo',
    maxReceiveCount: integer(process.env.SQS_MAX_RECEIVE_COUNT, 5, 1, 1000),
    visibilityTimeoutSeconds: integer(process.env.SQS_VISIBILITY_TIMEOUT_SECONDS, 30, 6, 43200),
    pollWaitSeconds: integer(process.env.SQS_POLL_WAIT_SECONDS, 10, 0, 20),
    requestTimeoutMs: integer(process.env.SQS_REQUEST_TIMEOUT_MS, 15000, 1000, 60000),
    ...overrides,
  };
  for (const [value, min, max] of [
    [result.maxReceiveCount, 1, 1000],
    [result.visibilityTimeoutSeconds, 6, 43200],
    [result.pollWaitSeconds, 0, 20],
    [result.requestTimeoutMs, 1000, 60000],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid messaging configuration');
  }
  return result;
}

/** Only transport metadata is hashed here; financial deduplication is persisted in PostgreSQL. */
export function transportId(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export class SqsGateway {
  readonly client: SQSClient;
  readonly config: QueueConfig;

  constructor(overrides: Partial<QueueConfig> = {}, client?: SQSClient) {
    this.config = queueConfig(overrides);
    this.client = client ?? new SQSClient({
      endpoint: this.config.endpoint,
      region: this.config.region,
      credentials: { accessKeyId: this.config.accessKeyId, secretAccessKey: this.config.secretAccessKey },
      maxAttempts: 3,
    });
  }

  get urls(): { queue: string; dlq: string; events: string } {
    return { queue: this.config.queueUrl, dlq: this.config.dlqUrl, events: this.config.eventsUrl };
  }

  async receive(maximum = 10, abortSignal?: AbortSignal): Promise<Message[]> {
    const timeout = AbortSignal.timeout((this.config.pollWaitSeconds * 1000) + this.config.requestTimeoutMs);
    const response = await this.client.send(new ReceiveMessageCommand({
      QueueUrl: this.config.queueUrl,
      MaxNumberOfMessages: Math.max(1, Math.min(10, maximum)),
      WaitTimeSeconds: this.config.pollWaitSeconds,
      VisibilityTimeout: this.config.visibilityTimeoutSeconds,
      MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
    }), { abortSignal: abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout });
    return response.Messages ?? [];
  }

  async acknowledge(receiptHandle: string): Promise<void> {
    await this.client.send(new DeleteMessageCommand({ QueueUrl: this.config.queueUrl, ReceiptHandle: receiptHandle }),
      { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) });
  }

  async changeVisibility(receiptHandle: string, seconds: number): Promise<void> {
    await this.client.send(new ChangeMessageVisibilityCommand({
      QueueUrl: this.config.queueUrl,
      ReceiptHandle: receiptHandle,
      VisibilityTimeout: Math.max(0, Math.min(43200, Math.floor(seconds))),
    }), { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) });
  }

  async sendToDlq(message: Message, failureCode: string, walletId?: string): Promise<void> {
    const body = message.Body ?? 'null';
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.config.dlqUrl,
      MessageBody: body,
      MessageGroupId: transportId(walletId ?? message.Attributes?.MessageGroupId ?? 'invalid-message'),
      // Stable across a crash between SendMessage and DeleteMessage.
      MessageDeduplicationId: transportId('dlq:' + (message.MessageId ?? transportId(body))),
      MessageAttributes: {
        failureCode: { DataType: 'String', StringValue: failureCode },
        sourceMessageId: { DataType: 'String', StringValue: message.MessageId ?? transportId(body) },
      },
    }), { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) });
  }

  async publish(event: { id: string; aggregateId: string; payload: unknown }, abortSignal?: AbortSignal): Promise<void> {
    const timeout = AbortSignal.timeout(this.config.requestTimeoutMs);
    await this.client.send(new SendMessageCommand({
      QueueUrl: this.config.eventsUrl,
      MessageBody: JSON.stringify(event.payload),
      MessageGroupId: event.aggregateId,
      MessageDeduplicationId: event.id,
    }), { abortSignal: abortSignal ? AbortSignal.any([abortSignal, timeout]) : timeout });
  }

  async readiness(): Promise<boolean> {
    const responses = await Promise.allSettled(Object.values(this.urls).map(QueueUrl => this.client.send(
      new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
      { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) },
    )));
    return responses.every(result => result.status === 'fulfilled' && !!result.value.Attributes?.QueueArn);
  }

  async initializeQueues(): Promise<void> {
    const attributes = { FifoQueue: 'true', ContentBasedDeduplication: 'false', MessageRetentionPeriod: '1209600' };
    const dlq = await this.client.send(new CreateQueueCommand({
      QueueName: 'wager-transactions-dlq.fifo', Attributes: attributes,
    }), { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    if (!dlq.QueueUrl) throw new Error('DLQ initialization did not return a queue URL');
    this.config.dlqUrl = dlq.QueueUrl;
    const result = await this.client.send(new GetQueueAttributesCommand({
      QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'],
    }), { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    const arn = result.Attributes?.QueueArn;
    if (!arn) throw new Error('DLQ initialization did not return an ARN');
    const main = await this.client.send(new CreateQueueCommand({
      QueueName: 'wager-transactions.fifo',
      Attributes: {
        ...attributes,
        VisibilityTimeout: String(this.config.visibilityTimeoutSeconds),
        ReceiveMessageWaitTimeSeconds: String(this.config.pollWaitSeconds),
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: this.config.maxReceiveCount }),
      },
    }), { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    const events = await this.client.send(new CreateQueueCommand({
      QueueName: 'wager-events.fifo', Attributes: attributes,
    }), { abortSignal: AbortSignal.timeout(this.config.requestTimeoutMs) });
    if (!main.QueueUrl || !events.QueueUrl) throw new Error('Queue initialization did not return a queue URL');
    this.config.queueUrl = main.QueueUrl;
    this.config.eventsUrl = events.QueueUrl;
  }

  close(): void {
    this.client.destroy();
  }
}
