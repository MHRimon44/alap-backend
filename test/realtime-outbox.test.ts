import { Types } from 'mongoose';

import { ConversationMemberModel } from '../src/conversations/models.js';
import { MessageModel, OutboxEventModel } from '../src/messages/models.js';
import { startRealtimeOutbox } from '../src/realtime/outbox.js';
import { createSilentLogger } from './helpers.js';

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});
test('outbox publishes committed message to member user rooms and checkpoints independently of FCM', async () => {
  jest.useFakeTimers();
  const eventId = new Types.ObjectId();
  const member = new Types.ObjectId();
  const conversationId = new Types.ObjectId();
  jest.spyOn(OutboxEventModel, 'findOneAndUpdate').mockReturnValue({
    lean: async () => ({
      _id: eventId,
      type: 'message.created',
      aggregateId: new Types.ObjectId(),
      conversationId,
    }),
  } as never);
  jest
    .spyOn(ConversationMemberModel, 'find')
    .mockReturnValue({ select: () => ({ lean: async () => [{ userId: member }] }) } as never);
  jest.spyOn(MessageModel, 'findById').mockReturnValue({
    lean: async () => ({
      _id: new Types.ObjectId(),
      conversationId,
      senderId: new Types.ObjectId(),
      text: 'Hello',
      clientMessageId: 'fixture',
      createdAt: new Date(),
    }),
  } as never);
  const update = jest.spyOn(OutboxEventModel, 'updateOne').mockResolvedValue({
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
    upsertedCount: 0,
    upsertedId: null,
  });
  const emit = jest.fn();
  const worker = startRealtimeOutbox(emit, createSilentLogger());
  await jest.advanceTimersByTimeAsync(250);
  await worker.disconnect();
  expect(emit).toHaveBeenCalledWith(
    [String(member)],
    'message:created',
    expect.objectContaining({ text: 'Hello', conversationId: String(conversationId) }),
  );
  expect(update).toHaveBeenCalledWith(
    expect.objectContaining({ _id: eventId }),
    expect.objectContaining({ $set: { processedAt: expect.any(Date) } }),
  );
});
