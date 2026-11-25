import { Database } from '../../src/infrastructure/database';
import { FinancialService } from '../../src/application/financial-service';
import { OutboxPublisher } from '../../src/messaging/outbox-publisher';
import { SqsConsumer } from '../../src/messaging/sqs-consumer';
import { SqsGateway } from '../../src/messaging/sqs-gateway';
import type { Message } from '@aws-sdk/client-sqs';

if (process.env.NODE_ENV !== 'test' || process.env.ALLOW_INTEGRATION_TESTS !== '1') throw new Error('Test worker only');
const db = await Database.connect();
const gateway = new SqsGateway();
try {
  if (process.env.TEST_WORKER_MODE === 'publisher') await new OutboxPublisher(db, gateway).publishBatch(1);
  else {
    const message = JSON.parse(process.env.TEST_MESSAGE_JSON ?? '{}') as Message;
    await new SqsConsumer(gateway, new FinancialService(db)).handleMessage(message);
  }
} finally {
  gateway.close();
  await db.close();
}
