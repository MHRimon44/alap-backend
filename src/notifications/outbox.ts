import { randomUUID } from 'node:crypto';

import type { Logger } from 'pino';

import { UserModel } from '../auth/models.js';
import { ConversationMemberModel } from '../conversations/models.js';
import { MessageModel, OutboxEventModel, type OutboxEventDocument } from '../messages/models.js';
import type { NotificationService } from './service.js';

export async function deliverChatPush(
  event: OutboxEventDocument,
  notifications: NotificationService,
): Promise<void> {
  const message = await MessageModel.findById(event.aggregateId).lean();
  if (!message || message.globalDeletedAt) return;
  const sender = await UserModel.findById(message.senderId).select({ displayName: 1 }).lean();
  const members = await ConversationMemberModel.find({
    conversationId: message.conversationId,
    userId: { $ne: message.senderId },
    notificationsEnabled: { $ne: false },
    $or: [
      { muteUntil: { $exists: false } },
      { muteUntil: null },
      { muteUntil: { $lte: new Date() } },
    ],
  }).lean();
  for (const member of members) {
    const userId = String(member.userId);
    if (event.pushDeliveredUserIds?.includes(userId)) continue;
    await notifications.sendChatMessage({
      recipientId: userId,
      senderId: String(message.senderId),
      senderName: sender?.displayName || 'Alap',
      conversationId: String(message.conversationId),
      text: message.text,
    });
    await OutboxEventModel.updateOne(
      { _id: event._id },
      { $addToSet: { pushDeliveredUserIds: userId } },
    );
  }
}

// Push has its own checkpoint so it never holds up Socket.IO publication.
export function startPushWorker(
  notifications: NotificationService,
  logger: Logger,
): { disconnect(): Promise<void> } {
  let stopped = false;
  let running: Promise<void> | undefined;
  async function tick(): Promise<void> {
    const owner = randomUUID();
    try {
      const now = new Date();
      const event = await OutboxEventModel.findOneAndUpdate(
        {
          type: 'message.created',
          pushProcessedAt: { $exists: false },
          $and: [
            { $or: [{ pushAvailableAt: { $exists: false } }, { pushAvailableAt: { $lte: now } }] },
            {
              $or: [
                { pushLockedAt: { $exists: false } },
                { pushLockedAt: { $lte: new Date(Date.now() - 300_000) } },
              ],
            },
          ],
        },
        { $set: { pushLockedAt: now, pushLockOwner: owner }, $inc: { pushAttempts: 1 } },
        { returnDocument: 'after' },
      ).lean();
      if (!event) return;
      const heartbeat = setInterval(() => {
        void OutboxEventModel.updateOne(
          { _id: event._id, pushLockOwner: owner },
          { $set: { pushLockedAt: new Date() } },
        ).catch(() => logger.warn('Push lease renewal failed'));
      }, 30_000);
      heartbeat.unref();
      try {
        await deliverChatPush(event, notifications);
        await OutboxEventModel.updateOne(
          { _id: event._id, pushLockOwner: owner },
          {
            $set: { pushProcessedAt: new Date() },
            $unset: { pushLockedAt: 1, pushLockOwner: 1 },
          },
        );
      } catch {
        await OutboxEventModel.updateOne(
          { _id: event._id, pushLockOwner: owner },
          {
            $set: {
              pushAvailableAt: new Date(
                Date.now() + Math.min(3_600_000, 1000 * 2 ** Math.min(event.pushAttempts ?? 1, 12)),
              ),
            },
            $unset: { pushLockedAt: 1, pushLockOwner: 1 },
          },
        );
        logger.warn({ eventId: String(event._id) }, 'Push outbox delivery deferred');
      } finally {
        clearInterval(heartbeat);
      }
    } catch {
      logger.warn('Push outbox polling failed');
    }
  }
  const timer = setInterval(() => {
    if (!stopped && !running)
      running = tick().finally(() => {
        running = undefined;
      });
  }, 1000);
  timer.unref();
  return {
    async disconnect() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
