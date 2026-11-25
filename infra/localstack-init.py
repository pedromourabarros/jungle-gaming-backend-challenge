"""Initialize the real LocalStack SQS API on each emulator startup."""
import json
import boto3

sqs = boto3.client('sqs', endpoint_url='http://localhost:4566', region_name='us-east-1',
                   aws_access_key_id='test', aws_secret_access_key='test')
attributes = {'FifoQueue': 'true', 'ContentBasedDeduplication': 'false', 'MessageRetentionPeriod': '1209600'}
dlq = sqs.create_queue(QueueName='wager-transactions-dlq.fifo', Attributes=attributes)['QueueUrl']
arn = sqs.get_queue_attributes(QueueUrl=dlq, AttributeNames=['QueueArn'])['Attributes']['QueueArn']
sqs.create_queue(QueueName='wager-transactions.fifo', Attributes={**attributes,
    'VisibilityTimeout': '30', 'ReceiveMessageWaitTimeSeconds': '10',
    'RedrivePolicy': json.dumps({'deadLetterTargetArn': arn, 'maxReceiveCount': 5})})
sqs.create_queue(QueueName='wager-events.fifo', Attributes=attributes)
print('Jungle Gaming FIFO queues initialized')
