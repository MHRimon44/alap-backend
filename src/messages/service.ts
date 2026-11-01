import mongoose, { Types } from 'mongoose';

import { ConversationMemberModel, ConversationModel } from '../conversations/models.js';
import type { RateLimiter } from '../auth/ports.js';
import { AppError } from '../errors/app-error.js';
import {
  MessageModel,
  MessageReactionModel,
  MessageUserStateModel,
  OutboxEventModel,
} from './models.js';

export type MessageView = Readonly<{
  id: string;
  conversationId: string;
  senderId: string;
  clientMessageId: string;
  kind: 'text';
  text: string | null;
  replyToMessageId?: string;
  deletedAt?: string;
  createdAt: string;
  reactions: readonly ReactionSummary[];
}>;

export type ReactionSummary = Readonly<{
  emoji: string;
  count: number;
  reactedByMe: boolean;
}>;

export interface MessageService {
  send(
    actorId: string,
    input: {
      conversationId: string;
      clientMessageId: string;
      text: string;
      replyToMessageId?: string;
    },
  ): Promise<MessageView>;
  history(
    actorId: string,
    input: { conversationId: string; before?: string; limit: number },
  ): Promise<{ items: readonly MessageView[]; nextCursor: string | null; hasMore: boolean }>;
  deleteForEveryone(actorId: string, messageId: string): Promise<MessageView>;
  deleteForMe(actorId: string, messageId: string): Promise<void>;
  setReaction(
    actorId: string,
    messageId: string,
    emoji: string,
    active: boolean,
  ): Promise<ReactionView>;
  changes(
    actorId: string,
    input: { conversationId: string; after?: string; limit: number },
  ): Promise<ChangePage>;
  advanceReceipt(
    actorId: string,
    input: { conversationId: string; messageId: string; type: 'delivered' | 'seen' },
  ): Promise<ReceiptView>;
}

export type ReceiptView = Readonly<{
  conversationId: string;
  userId: string;
  type: 'delivered' | 'seen';
  messageId: string;
  updatedAt: string;
}>;

export type ReactionView = Readonly<{
  messageId: string;
  conversationId: string;
  userId: string;
  emoji: string;
  active: boolean;
  updatedAt: string;
}>;
export type ChangePage = Readonly<{
  items: readonly Readonly<{
    cursor: string;
    type: string;
    aggregateId: string;
    payload: Readonly<Record<string, unknown>>;
    createdAt: string;
  }>[];
  nextCursor: string | null;
  hasMore: boolean;
}>;

export function createMessageService(
  now: () => Date = () => new Date(),
  rateLimiter?: RateLimiter,
): MessageService {
  return {
    async send(actorId, input) {
      if (rateLimiter) {
        const [burst, sustained] = await Promise.all([
          rateLimiter.consume({
            key: `message-send:burst:${actorId}`,
            limit: 30,
            windowSeconds: 10,
          }),
          rateLimiter.consume({
            key: `message-send:sustained:${actorId}`,
            limit: 300,
            windowSeconds: 600,
          }),
        ]);
        const rejected = !burst.allowed ? burst : !sustained.allowed ? sustained : null;
        if (rejected)
          throw new AppError({
            code: 'RATE_LIMITED',
            details: { retryAfterSeconds: rejected.retryAfterSeconds },
            message: 'Message rate limit exceeded.',
            statusCode: 429,
          });
      }
      await requireMembership(actorId, input.conversationId);
      if (input.replyToMessageId) {
        const reply = await MessageModel.exists({
          _id: input.replyToMessageId,
          conversationId: input.conversationId,
        });
        if (!reply) throw validation('Reply target is not in this conversation.');
      }
      try {
        return await mongoose.connection.transaction(async (transaction) => {
          const createdAt = now();
          const [message] = await MessageModel.create(
            [
              {
                conversationId: input.conversationId,
                senderId: actorId,
                clientMessageId: input.clientMessageId,
                kind: 'text',
                text: input.text.trim(),
                ...(input.replyToMessageId ? { replyToMessageId: input.replyToMessageId } : {}),
              },
            ],
            { session: transaction },
          );
          if (!message) throw new Error('Message creation returned no record.');
          await ConversationModel.updateOne(
            { _id: input.conversationId },
            { $set: { activityAt: createdAt } },
            { session: transaction },
          );
          await ConversationMemberModel.updateMany(
            { conversationId: input.conversationId },
            { $set: { sortAt: createdAt }, $unset: { hiddenAt: 1 } },
            { session: transaction },
          );
          await ConversationMemberModel.updateMany(
            { conversationId: input.conversationId, userId: { $ne: actorId } },
            { $inc: { unreadCount: 1 } },
            { session: transaction },
          );
          await OutboxEventModel.create(
            [
              {
                type: 'message.created',
                aggregateId: message._id,
                conversationId: input.conversationId,
                payload: { messageId: String(message._id), senderId: actorId },
              },
            ],
            { session: transaction },
          );
          return mapMessage(message.toObject());
        });
      } catch (error) {
        if (!isDuplicate(error)) throw error;
        const existing = await MessageModel.findOne({
          senderId: actorId,
          clientMessageId: input.clientMessageId,
        }).lean();
        if (!existing || String(existing.conversationId) !== input.conversationId)
          throw new AppError({
            code: 'MESSAGE_ID_CONFLICT',
            message: 'Message identifier conflicts with another send.',
            statusCode: 409,
          });
        return mapMessage(existing);
      }
    },
    async history(actorId, input) {
      await requireMembership(actorId, input.conversationId);
      const before = input.before ? decodeCursor(input.before) : null;
      const values = await MessageModel.aggregate<MessageDocumentLike>([
        {
          $match: {
            conversationId: new Types.ObjectId(input.conversationId),
            ...(before
              ? {
                  $or: [
                    { createdAt: { $lt: before.createdAt } },
                    { createdAt: before.createdAt, _id: { $lt: new Types.ObjectId(before.id) } },
                  ],
                }
              : {}),
          },
        },
        {
          $lookup: {
            from: MessageUserStateModel.collection.name,
            let: { messageId: '$_id' },
            pipeline: [
              {
                $match: {
                  $expr: {
                    $and: [
                      { $eq: ['$messageId', '$$messageId'] },
                      { $eq: ['$userId', new Types.ObjectId(actorId)] },
                    ],
                  },
                },
              },
              { $limit: 1 },
            ],
            as: 'actorDeletion',
          },
        },
        { $match: { actorDeletion: { $size: 0 } } },
        { $sort: { createdAt: -1, _id: -1 } },
        { $limit: input.limit + 1 },
      ]);
      const hasMore = values.length > input.limit;
      const page = values.slice(0, input.limit);
      const tail = page.at(-1);
      const reactions = await loadReactionSummaries(
        actorId,
        page.map((message) => String(message._id)),
      );
      return {
        items: page.map((message) => mapMessage(message, reactions.get(String(message._id)) ?? [])),
        hasMore,
        nextCursor: hasMore && tail ? encodeCursor(tail.createdAt, String(tail._id)) : null,
      };
    },
    async deleteForEveryone(actorId, messageId) {
      const message = await MessageModel.findById(messageId).lean();
      if (!message) throw messageNotFound();
      await requireMembership(actorId, String(message.conversationId));
      if (
        String(message.senderId) !== actorId ||
        now().getTime() - message.createdAt.getTime() > 15 * 60_000
      )
        throw new AppError({
          code: 'MESSAGE_DELETE_FORBIDDEN',
          message: 'Message cannot be deleted for everyone.',
          statusCode: 403,
        });
      return mongoose.connection.transaction(async (transaction) => {
        const deletedAt = now();
        const deleted = await MessageModel.findOneAndUpdate(
          { _id: messageId, globalDeletedAt: { $exists: false } },
          { $set: { globalDeletedAt: deletedAt, globalDeletedBy: actorId, text: '' } },
          { new: true, session: transaction },
        ).lean();
        const result = deleted ?? message;
        await OutboxEventModel.create(
          [
            {
              type: 'message.deleted',
              aggregateId: message._id,
              conversationId: message.conversationId,
              payload: { messageId },
            },
          ],
          { session: transaction },
        );
        return mapMessage(result);
      });
    },
    async deleteForMe(actorId, messageId) {
      const message = await MessageModel.findById(messageId).lean();
      if (!message) throw messageNotFound();
      await requireMembership(actorId, String(message.conversationId));
      await MessageUserStateModel.updateOne(
        { messageId, userId: actorId },
        { $setOnInsert: { conversationId: message.conversationId, deletedForUserAt: now() } },
        { upsert: true },
      );
    },
    async setReaction(actorId, messageId, emoji, active) {
      const message = await MessageModel.findById(messageId).lean();
      if (!message || message.globalDeletedAt) throw messageNotFound();
      await requireMembership(actorId, String(message.conversationId));
      const changedAt = now();
      await mongoose.connection.transaction(async (transaction) => {
        if (active)
          await MessageReactionModel.updateOne(
            { messageId, userId: actorId, emoji },
            { $setOnInsert: { conversationId: message.conversationId } },
            { upsert: true, session: transaction },
          );
        else
          await MessageReactionModel.deleteOne({ messageId, userId: actorId, emoji }).session(
            transaction,
          );
        await OutboxEventModel.create(
          [
            {
              type: 'reaction.updated',
              aggregateId: message._id,
              conversationId: message.conversationId,
              payload: { messageId, userId: actorId, emoji, active },
            },
          ],
          { session: transaction },
        );
      });
      return {
        messageId,
        conversationId: String(message.conversationId),
        userId: actorId,
        emoji,
        active,
        updatedAt: changedAt.toISOString(),
      };
    },
    async changes(actorId, input) {
      await requireMembership(actorId, input.conversationId);
      const events = await OutboxEventModel.find({
        conversationId: input.conversationId,
        ...(input.after ? { _id: { $gt: new Types.ObjectId(input.after) } } : {}),
      })
        .sort({ _id: 1 })
        .limit(input.limit + 1)
        .lean();
      const hasMore = events.length > input.limit;
      const page = events.slice(0, input.limit);
      const tail = page.at(-1);
      return {
        items: page.map((event) => ({
          cursor: String(event._id),
          type: event.type,
          aggregateId: String(event.aggregateId),
          payload: event.payload,
          createdAt: event.createdAt.toISOString(),
        })),
        hasMore,
        nextCursor: hasMore && tail ? String(tail._id) : null,
      };
    },
    async advanceReceipt(actorId, input) {
      const message = await MessageModel.findOne({
        _id: input.messageId,
        conversationId: input.conversationId,
      }).lean();
      if (!message) throw messageNotFound();
      await requireMembership(actorId, input.conversationId);
      const idField = input.type === 'seen' ? 'lastSeenMessageId' : 'lastDeliveredMessageId';
      const atField = input.type === 'seen' ? 'lastSeenAt' : 'lastDeliveredAt';
      const result = await ConversationMemberModel.updateOne(
        {
          conversationId: input.conversationId,
          userId: actorId,
          $or: [
            { [atField]: { $exists: false } },
            { [atField]: { $lt: message.createdAt } },
            { [atField]: message.createdAt, [idField]: { $lt: message._id } },
          ],
        },
        {
          $set: {
            [idField]: message._id,
            [atField]: message.createdAt,
            ...(input.type === 'seen'
              ? {
                  unreadCount: 0,
                  lastDeliveredMessageId: message._id,
                  lastDeliveredAt: message.createdAt,
                }
              : {}),
          },
        },
      );
      if (result.matchedCount === 0) {
        const membership = await ConversationMemberModel.findOne({
          conversationId: input.conversationId,
          userId: actorId,
        }).lean();
        if (!membership) throw messageNotFound();
        const currentId =
          input.type === 'seen' ? membership.lastSeenMessageId : membership.lastDeliveredMessageId;
        const currentAt =
          input.type === 'seen' ? membership.lastSeenAt : membership.lastDeliveredAt;
        return {
          conversationId: input.conversationId,
          userId: actorId,
          type: input.type,
          messageId: currentId ? String(currentId) : input.messageId,
          updatedAt: (currentAt ?? message.createdAt).toISOString(),
        };
      }
      return {
        conversationId: input.conversationId,
        userId: actorId,
        type: input.type,
        messageId: input.messageId,
        updatedAt: message.createdAt.toISOString(),
      };
    },
  };
}

async function requireMembership(actorId: string, conversationId: string): Promise<void> {
  if (!(await ConversationMemberModel.exists({ userId: actorId, conversationId })))
    throw new AppError({
      code: 'CONVERSATION_NOT_FOUND',
      message: 'Conversation was not found.',
      statusCode: 404,
    });
}

export function mapMessage(
  value: MessageDocumentLike,
  reactions: readonly ReactionSummary[] = [],
): MessageView {
  return {
    id: String(value._id),
    conversationId: String(value.conversationId),
    senderId: String(value.senderId),
    clientMessageId: value.clientMessageId,
    kind: 'text',
    text: value.globalDeletedAt ? null : value.text,
    ...(value.replyToMessageId ? { replyToMessageId: objectIdString(value.replyToMessageId) } : {}),
    ...(value.globalDeletedAt ? { deletedAt: value.globalDeletedAt.toISOString() } : {}),
    createdAt: value.createdAt.toISOString(),
    reactions,
  };
}

async function loadReactionSummaries(
  actorId: string,
  messageIds: readonly string[],
): Promise<Map<string, ReactionSummary[]>> {
  if (messageIds.length === 0) return new Map();
  const values = await MessageReactionModel.find({ messageId: { $in: messageIds } })
    .select({ messageId: 1, userId: 1, emoji: 1 })
    .lean<{ messageId: Types.ObjectId; userId: Types.ObjectId; emoji: string }[]>();
  const byMessage = new Map<string, Map<string, { count: number; reactedByMe: boolean }>>();
  for (const value of values) {
    const messageId = String(value.messageId);
    const reactions =
      byMessage.get(messageId) ?? new Map<string, { count: number; reactedByMe: boolean }>();
    const current = reactions.get(value.emoji) ?? { count: 0, reactedByMe: false };
    reactions.set(value.emoji, {
      count: current.count + 1,
      reactedByMe: current.reactedByMe || String(value.userId) === actorId,
    });
    byMessage.set(messageId, reactions);
  }
  return new Map(
    [...byMessage].map(([messageId, reactions]) => [
      messageId,
      [...reactions].map(([emoji, summary]) => ({ emoji, ...summary })),
    ]),
  );
}

type MessageDocumentLike = {
  _id: unknown;
  conversationId: unknown;
  senderId: unknown;
  clientMessageId: string;
  text: string;
  replyToMessageId?: unknown;
  globalDeletedAt?: Date | null;
  createdAt: Date;
};
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id })).toString(
    'base64url',
  );
}
function decodeCursor(value: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as {
      createdAt?: unknown;
      id?: unknown;
    };
    if (
      typeof parsed.createdAt !== 'string' ||
      typeof parsed.id !== 'string' ||
      !Types.ObjectId.isValid(parsed.id)
    )
      throw new Error();
    const createdAt = new Date(parsed.createdAt);
    if (Number.isNaN(createdAt.getTime())) throw new Error();
    return { createdAt, id: parsed.id };
  } catch {
    throw new AppError({ code: 'INVALID_CURSOR', message: 'Cursor is invalid.', statusCode: 400 });
  }
}
function isDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 11_000;
}
function validation(message: string): AppError {
  return new AppError({ code: 'VALIDATION_ERROR', message, statusCode: 422 });
}
function messageNotFound(): AppError {
  return new AppError({
    code: 'MESSAGE_NOT_FOUND',
    message: 'Message was not found.',
    statusCode: 404,
  });
}

function objectIdString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Types.ObjectId) return value.toHexString();
  throw new Error('Invalid ObjectId field.');
}
