import { Types } from 'mongoose';

import { UserModel } from '../src/auth/models.js';
import { ConversationMemberModel } from '../src/conversations/models.js';
import {
  MessageModel,
  OutboxEventModel,
  type OutboxEventDocument,
} from '../src/messages/models.js';
import { deliverChatPush, startPushWorker } from '../src/notifications/outbox.js';
import { NotificationService } from '../src/notifications/service.js';
import { createSilentLogger } from './helpers.js';

const senderId = new Types.ObjectId();
const recipientId = new Types.ObjectId();
const event = {
  _id: new Types.ObjectId(),
  aggregateId: new Types.ObjectId(),
  type: 'message.created',
  pushAttempts: 1,
} as OutboxEventDocument;
function prepare() {
  jest.spyOn(MessageModel, 'findById').mockReturnValue({
    lean: async () => ({ senderId, conversationId: new Types.ObjectId(), text: 'Hello' }),
  } as never);
  jest.spyOn(UserModel, 'findById').mockReturnValue({
    select: () => ({ lean: async () => ({ displayName: 'Sender' }) }),
  } as never);
  jest
    .spyOn(ConversationMemberModel, 'find')
    .mockReturnValue({ lean: async () => [{ userId: recipientId }] } as never);
  const checkpoint = jest.spyOn(OutboxEventModel, 'updateOne').mockResolvedValue({
    acknowledged: true,
    matchedCount: 1,
    modifiedCount: 1,
    upsertedCount: 0,
    upsertedId: null,
  });
  const notifications = new NotificationService(
    { sendEachForMulticast: jest.fn() },
    { tokensForUser: jest.fn(), removeTokens: jest.fn() },
    createSilentLogger(),
  );
  const send = jest.spyOn(notifications, 'sendChatMessage').mockResolvedValue();
  return { checkpoint, notifications, send };
}
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});
test('uses membership recipients, excludes sender and respects preferences', async () => {
  const { notifications, send, checkpoint } = prepare();
  await deliverChatPush(event, notifications);
  expect(ConversationMemberModel.find).toHaveBeenCalledWith(
    expect.objectContaining({ userId: { $ne: senderId }, notificationsEnabled: { $ne: false } }),
  );
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ recipientId: String(recipientId), senderId: String(senderId) }),
  );
  expect(checkpoint).toHaveBeenCalledWith(
    { _id: event._id },
    { $addToSet: { pushDeliveredUserIds: String(recipientId) } },
  );
});
test('completed recipient is not notified again on retry', async () => {
  const { notifications, send } = prepare();
  await deliverChatPush({ ...event, pushDeliveredUserIds: [String(recipientId)] }, notifications);
  expect(send).not.toHaveBeenCalled();
});
test('deleted messages do not generate push', async () => {
  const { notifications, send } = prepare();
  jest
    .spyOn(MessageModel, 'findById')
    .mockReturnValue({ lean: async () => ({ globalDeletedAt: new Date() }) } as never);
  await deliverChatPush(event, notifications);
  expect(send).not.toHaveBeenCalled();
});
test('Firebase failure schedules retry independently without marking realtime outbox processed', async () => {
  jest.useFakeTimers();
  const { notifications, send, checkpoint } = prepare();
  send.mockRejectedValue(new Error('temporary failure'));
  jest
    .spyOn(OutboxEventModel, 'findOneAndUpdate')
    .mockReturnValue({ lean: async () => event } as never);
  const worker = startPushWorker(notifications, createSilentLogger());
  await jest.advanceTimersByTimeAsync(1000);
  await worker.disconnect();
  expect(checkpoint).toHaveBeenCalledWith(
    expect.objectContaining({ _id: event._id }),
    expect.objectContaining({ $set: { pushAvailableAt: expect.any(Date) } }),
  );
  for (const [, update] of checkpoint.mock.calls)
    expect(update).not.toEqual(
      expect.objectContaining({
        $set: expect.objectContaining({ processedAt: expect.anything() }),
      }),
    );
});
