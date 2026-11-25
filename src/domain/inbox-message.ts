import { copyDate, DomainError, requireDate, requireText } from "./errors";

export interface ReceiveInboxProps {
  messageId: string;
  consumerName: string;
  payloadHash: string;
  receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps { processedAt?: Date; }

export class InboxMessage {
  private readonly receivedTime: Date;
  private processedTime?: Date;

  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    receivedAt: Date,
    processedAt?: Date,
  ) {
    this.receivedTime = copyDate(receivedAt);
    this.processedTime = processedAt ? copyDate(processedAt) : undefined;
  }

  static receive(props: ReceiveInboxProps): InboxMessage {
    requireText(props.messageId, "messageId");
    requireText(props.consumerName, "consumerName");
    requireText(props.payloadHash, "payloadHash");
    requireDate(props.receivedAt, "receivedAt");
    return InboxMessage.rehydrate(props);
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(state.messageId, state.consumerName, state.payloadHash, state.receivedAt, state.processedAt);
  }

  get receivedAt(): Date { return copyDate(this.receivedTime); }
  get processedAt(): Date | undefined { return this.processedTime ? copyDate(this.processedTime) : undefined; }
  isProcessed(): boolean { return this.processedTime !== undefined; }
  matchesPayload(payloadHash: string): boolean { return this.payloadHash === payloadHash; }

  markProcessed(at: Date): void {
    if (this.isProcessed()) throw new DomainError("INVALID_INBOX_STATE", "Inbox message has already been processed");
    requireDate(at, "at");
    this.processedTime = copyDate(at);
  }
}
