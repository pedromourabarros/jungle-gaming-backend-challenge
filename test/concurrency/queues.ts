import { randomUUID } from 'node:crypto';
import {
  CreateQueueCommand, DeleteQueueCommand, DeleteMessageCommand, GetQueueAttributesCommand,
  ReceiveMessageCommand, SendMessageCommand, type Message,
} from '@aws-sdk/client-sqs';
import { SqsGateway } from '../../src/messaging/sqs-gateway';
import type { SubmitInput } from '../../src/application/contracts';
import { eventually } from '../helpers/processes';

/** Each process scenario owns separate real queues; broker dedup IDs are always fresh for requests. */
export async function isolatedQueues() {
  const transport = new SqsGateway();
  const name = `concurrency-${randomUUID()}`;
  const attributes = { FifoQueue: 'true', ContentBasedDeduplication: 'false' };
  const dlq = (await transport.client.send(new CreateQueueCommand({
    QueueName: `${name}-dlq.fifo`, Attributes: attributes,
  }))).QueueUrl!;
  const arn = (await transport.client.send(new GetQueueAttributesCommand({
    QueueUrl: dlq, AttributeNames: ['QueueArn'],
  }))).Attributes!.QueueArn!;
  const queue = (await transport.client.send(new CreateQueueCommand({
    QueueName: `${name}-requests.fifo`,
    Attributes: { ...attributes, VisibilityTimeout: '6', RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 5 }) },
  }))).QueueUrl!;
  const events = (await transport.client.send(new CreateQueueCommand({
    QueueName: `${name}-events.fifo`, Attributes: attributes,
  }))).QueueUrl!;
  const gateway = new SqsGateway({ queueUrl: queue, dlqUrl: dlq, eventsUrl: events, visibilityTimeoutSeconds: 6, pollWaitSeconds: 1 });
  transport.close();
  const env = { SQS_QUEUE_URL: queue, SQS_DLQ_URL: dlq, SQS_EVENTS_QUEUE_URL: events };
  return {
    gateway, env,
    async send(input: SubmitInput, messageId = `message-${randomUUID()}`) {
      const body = { messageId, type: 'WagerTransactionRequested', occurredAt: new Date().toISOString(), data: input };
      await gateway.client.send(new SendMessageCommand({
        QueueUrl: queue, MessageBody: JSON.stringify(body), MessageGroupId: input.walletId, MessageDeduplicationId: randomUUID(),
      }));
      return messageId;
    },
    async waitUntilRequestQueueEmpty() {
      await eventually('the redelivered request to be acknowledged', async () => {
        const attrs = (await gateway.client.send(new GetQueueAttributesCommand({
          QueueUrl: queue, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'],
        }))).Attributes;
        return attrs?.ApproximateNumberOfMessages === '0' && attrs.ApproximateNumberOfMessagesNotVisible === '0';
      });
    },
    async receiveEvent(predicate: (body: Record<string, unknown>) => boolean): Promise<{ message: Message; body: Record<string, unknown> }> {
      return eventually('a matching integration event in real SQS', async () => {
        const received = await gateway.client.send(new ReceiveMessageCommand({ QueueUrl: events, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
        let match: { message: Message; body: Record<string, unknown> } | undefined;
        for (const message of received.Messages ?? []) {
          const body = JSON.parse(message.Body ?? '{}') as Record<string, unknown>;
          if (!match && predicate(body)) match = { message, body };
          if (message.ReceiptHandle) await gateway.client.send(new DeleteMessageCommand({ QueueUrl: events, ReceiptHandle: message.ReceiptHandle }));
        }
        return match;
      });
    },
    async close() {
      await Promise.allSettled([queue, dlq, events].map(QueueUrl => gateway.client.send(new DeleteQueueCommand({ QueueUrl }))));
      gateway.close();
    },
  };
}
