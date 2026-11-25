import { SqsGateway } from '../src/messaging/sqs-gateway';

const gateway = new SqsGateway();
try {
  await gateway.initializeQueues();
  console.log(JSON.stringify({ event: 'queues.initialized', queues: ['wager-transactions.fifo', 'wager-transactions-dlq.fifo', 'wager-events.fifo'] }));
} finally {
  gateway.close();
}
