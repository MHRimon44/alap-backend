import type { Logger } from 'pino';

import { ConversationMemberModel } from '../conversations/models.js';
import { MessageModel, OutboxEventModel } from '../messages/models.js';
import { mapMessage } from '../messages/service.js';

export function startRealtimeOutbox(
  emit: (userIds: string[], name: string, payload: unknown) => void,
  logger: Logger,
): { disconnect(): Promise<void> } {
  let running: Promise<void> | undefined;
  async function tick(): Promise<void> {
    try {
      const now = new Date();
      const event = await OutboxEventModel.findOneAndUpdate(
        {
          processedAt: { $exists: false },
          availableAt: { $lte: now },
          $or: [
            { lockedAt: { $exists: false } },
            { lockedAt: { $lt: new Date(Date.now() - 60_000) } },
          ],
        },
        { $set: { lockedAt: now }, $inc: { attempts: 1 } },
        { returnDocument: 'after' },
      ).lean();
      if (!event) return;
      try {
        const members = await ConversationMemberModel.find({ conversationId: event.conversationId })
          .select({ userId: 1 })
          .lean();
        const userIds = members.map((member) => String(member.userId));
        if (event.type === 'reaction.updated') {
          emit(userIds, 'reaction:changed', {
            ...event.payload,
            conversationId: String(event.conversationId),
            updatedAt: event.createdAt.toISOString(),
          });
        } else {
          const message = await MessageModel.findById(event.aggregateId).lean();
          if (message)
            emit(
              userIds,
              event.type === 'message.created' ? 'message:created' : 'message:deletedEveryone',
              mapMessage(message),
            );
        }
        await OutboxEventModel.updateOne(
          { _id: event._id, lockedAt: now },
          { $set: { processedAt: new Date() }, $unset: { lockedAt: 1 } },
        );
      } catch {
        await OutboxEventModel.updateOne(
          { _id: event._id, lockedAt: now },
          {
            $set: {
              availableAt: new Date(
                Date.now() + Math.min(60_000, 1000 * 2 ** Math.min(event.attempts, 6)),
              ),
            },
            $unset: { lockedAt: 1 },
          },
        );
        logger.warn({ eventId: String(event._id) }, 'Realtime outbox delivery deferred');
      }
    } catch {
      logger.warn('Realtime outbox polling failed');
    }
  }
  const timer = setInterval(() => {
    if (!running)
      running = tick().finally(() => {
        running = undefined;
      });
  }, 250);
  timer.unref();
  return {
    async disconnect() {
      clearInterval(timer);
      await running;
    },
  };
}
