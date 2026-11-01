import { startRealtimeOutbox } from './outbox.js';
import type { Server as HttpServer } from 'node:http';

import { createAdapter } from '@socket.io/redis-adapter';
import type { Logger } from 'pino';
import { createClient } from 'redis';
import { Server, type Socket } from 'socket.io';
import { z } from 'zod';

import type { AuthService } from '../auth/service.js';
import type { ApiConfig } from '../config/env.js';
import { UserModel } from '../auth/models.js';
import { ConversationMemberModel } from '../conversations/models.js';
import type { MessageService } from '../messages/service.js';

const sendSchema = z.object({
  conversationId: z.string().regex(/^[a-f\d]{24}$/i),
  clientMessageId: z.uuid(),
  kind: z.literal('text'),
  text: z.string().trim().min(1).max(4_000),
  replyToMessageId: z
    .string()
    .regex(/^[a-f\d]{24}$/i)
    .optional(),
});
const messageIdSchema = z.object({ messageId: z.string().regex(/^[a-f\d]{24}$/i) });
const reactionSchema = messageIdSchema.extend({
  emoji: z.enum(['👍', '❤️', '😂', '😮', '😢', '🙏']),
  active: z.boolean(),
});
const typingSchema = z.object({
  conversationId: z.string().regex(/^[a-f\d]{24}$/i),
  isTyping: z.boolean(),
});
const presenceLookupSchema = z.object({ userId: z.string().regex(/^[a-f\d]{24}$/i) });
const receiptSchema = z.object({
  conversationId: z.string().regex(/^[a-f\d]{24}$/i),
  messageId: z.string().regex(/^[a-f\d]{24}$/i),
});

type Ack = (
  response:
    | { ok: true; data: unknown }
    | {
        ok: false;
        error: { code: string; message: string; retryable: boolean; requestId: string };
      },
) => void;

export async function createRealtimeServer(input: {
  server: HttpServer;
  config: Pick<ApiConfig, 'corsAllowedOrigins' | 'redisUrl'>;
  auth: AuthService;
  messages: MessageService;
  logger: Logger;
  enableOutbox?: boolean;
  enableRedisAdapter?: boolean;
  loadConversationIds?: (userId: string) => Promise<readonly string[]>;
  loadParticipantIds?: (conversationId: string) => Promise<readonly string[]>;
  loadPresenceVisibility?: (userId: string) => Promise<'everyone' | 'contacts' | 'nobody'>;
}): Promise<{ disconnect(): Promise<void> }> {
  const io = new Server(input.server, {
    cors: { origin: [...input.config.corsAllowedOrigins], credentials: false },
    maxHttpBufferSize: 100_000,
    transports: ['websocket'],
  });
  const publisher =
    input.enableRedisAdapter === false ? null : createClient({ url: input.config.redisUrl });
  const subscriber = publisher?.duplicate() ?? null;
  const authContexts = new Map<string, { userId: string; sessionId: string }>();
  const localPresence = new Map<string, Set<string>>();
  if (publisher && subscriber) {
    await Promise.all([publisher.connect(), subscriber.connect()]);
    io.adapter(createAdapter(publisher, subscriber));
  }

  io.use((socket, next) => {
    void (async () => {
      try {
        const handshakeAuth = socket.handshake.auth as unknown;
        const token =
          typeof handshakeAuth === 'object' &&
          handshakeAuth !== null &&
          'accessToken' in handshakeAuth
            ? handshakeAuth.accessToken
            : undefined;
        if (typeof token !== 'string') throw new Error('Missing access token.');
        authContexts.set(socket.id, await input.auth.authenticateAccess(token));
        next();
      } catch {
        next(new Error('UNAUTHENTICATED'));
      }
    })();
  });

  io.on('connection', (socket) => {
    void initializeSocket(socket);
  });

  async function initializeSocket(socket: Socket): Promise<void> {
    const auth = authContexts.get(socket.id);
    if (!auth) {
      socket.disconnect(true);
      return;
    }
    const authContext = auth;
    await socket.join(`user:${auth.userId}`);
    const conversationIds = input.loadConversationIds
      ? await input.loadConversationIds(auth.userId)
      : (
          await ConversationMemberModel.find({ userId: auth.userId })
            .select({ conversationId: 1 })
            .lean()
        ).map((value) => String(value.conversationId));
    const authorizedConversationIds = new Set(conversationIds);
    const conversationRooms = conversationIds.map((value) => `conversation:${value}`);
    await socket.join(conversationRooms);
    const presenceVisibility = input.loadPresenceVisibility
      ? await input.loadPresenceVisibility(auth.userId)
      : ((await UserModel.findById(auth.userId).select({ presenceVisibility: 1 }).lean())
          ?.presenceVisibility ?? 'everyone');
    const shouldPublishPresence = presenceVisibility !== 'nobody';
    const becameOnline = await addPresence(auth.userId, socket.id);
    if (becameOnline && shouldPublishPresence)
      await publishVisiblePresence(auth.userId, 'online', presenceVisibility);
    const heartbeat = setInterval(() => {
      void refreshPresence(auth.userId, socket.id);
    }, 30_000);
    heartbeat.unref();
    const activeTyping = new Set<string>();
    const typingTimers = new Map<string, NodeJS.Timeout>();
    const lastTypingEmit = new Map<string, number>();
    socket.once('disconnect', () => {
      authContexts.delete(socket.id);
      clearInterval(heartbeat);
      for (const timer of typingTimers.values()) clearTimeout(timer);
      for (const conversationId of activeTyping)
        socket.to(`conversation:${conversationId}`).emit('typing:changed', {
          conversationId,
          userId: auth.userId,
          isTyping: false,
          expiresAt: new Date().toISOString(),
        });
      void removePresence(auth.userId, socket.id)
        .then(async (becameOffline) => {
          if (!becameOffline) return;
          const lastSeenAt = new Date();
          await UserModel.updateOne({ _id: auth.userId }, { $set: { lastSeenAt } });
          if (shouldPublishPresence)
            await publishVisiblePresence(
              auth.userId,
              'offline',
              presenceVisibility,
              lastSeenAt.toISOString(),
            );
        })
        .catch((error: unknown) =>
          input.logger.warn({ error }, 'Presence disconnect update failed'),
        );
    });

    socket.on('presence:get', (payload: unknown, acknowledge: Ack) => {
      void (async () => {
        try {
          const { userId } = presenceLookupSchema.parse(payload);
          const visibility = await visibilityFor(userId);
          const permitted = await canSeePresence(auth.userId, userId, visibility);
          const online = permitted && (await isOnline(userId));
          const lastSeen =
            permitted && !online
              ? await UserModel.findById(userId).select({ lastSeenAt: 1 }).lean()
              : null;
          acknowledge({
            ok: true,
            data: {
              userId,
              status: !permitted ? 'unknown' : online ? 'online' : 'offline',
              updatedAt: new Date().toISOString(),
              ...(permitted && !online && lastSeen?.lastSeenAt
                ? { lastSeenAt: lastSeen.lastSeenAt.toISOString() }
                : {}),
            },
          });
        } catch {
          acknowledge(rejected('PRESENCE_LOOKUP_REJECTED', socket.id));
        }
      })();
    });

    socket.on('presence:visibilityChanged', (_payload: unknown, acknowledge: Ack) => {
      void (async () => {
        try {
          // Read the saved preference from MongoDB; never trust a client-supplied visibility.
          const current = await visibilityFor(auth.userId);
          await publishVisiblePresence(auth.userId, 'unknown', current);
          if (current !== 'nobody' && (await isOnline(auth.userId)))
            await publishVisiblePresence(auth.userId, 'online', current);
          acknowledge({ ok: true, data: { updated: true } });
        } catch {
          acknowledge(rejected('PRESENCE_UPDATE_REJECTED', socket.id));
        }
      })();
    });

    socket.on('message:send', (payload: unknown, acknowledge: Ack) => {
      void handleSend(payload, acknowledge);
    });
    socket.on('message:deleteMe', (payload: unknown, acknowledge: Ack) => {
      void handleDeleteForMe(payload, acknowledge);
    });
    socket.on('message:deleteEveryone', (payload: unknown, acknowledge: Ack) => {
      void handleDeleteForEveryone(payload, acknowledge);
    });
    socket.on('reaction:set', (payload: unknown, acknowledge: Ack) => {
      void handleReaction(payload, acknowledge);
    });
    socket.on('typing:set', (payload: unknown, acknowledge: Ack) => {
      void handleTyping(payload, acknowledge);
    });
    socket.on('receipt:delivered', (payload: unknown, acknowledge: Ack) => {
      void handleReceipt('delivered', payload, acknowledge);
    });
    socket.on('receipt:seen', (payload: unknown, acknowledge: Ack) => {
      void handleReceipt('seen', payload, acknowledge);
    });

    async function handleSend(payload: unknown, acknowledge: Ack): Promise<void> {
      try {
        const value = sendSchema.parse(payload);
        const message = await input.messages.send(authContext.userId, {
          conversationId: value.conversationId,
          clientMessageId: value.clientMessageId,
          text: value.text,
          ...(value.replyToMessageId ? { replyToMessageId: value.replyToMessageId } : {}),
        });
        await socket.join(`conversation:${value.conversationId}`);
        authorizedConversationIds.add(value.conversationId);
        const recipientIds = input.loadParticipantIds
          ? await input.loadParticipantIds(value.conversationId)
          : (
              await ConversationMemberModel.find({ conversationId: value.conversationId })
                .select({ userId: 1 })
                .lean()
            ).map((member) => String(member.userId));
        for (const recipientId of recipientIds)
          io.in(`user:${recipientId}`).socketsJoin(`conversation:${value.conversationId}`);
        if (!input.enableOutbox)
          io.to([
            `conversation:${value.conversationId}`,
            ...recipientIds.map((userId) => `user:${userId}`),
          ]).emit('message:created', message);
        acknowledge({ ok: true, data: message });
      } catch (error) {
        input.logger.warn(
          { err: error, userId: authContext.userId },
          'Socket message send rejected',
        );
        acknowledge({
          ok: false,
          error: {
            code: 'MESSAGE_SEND_REJECTED',
            message: 'Message could not be sent.',
            retryable: false,
            requestId: socket.id,
          },
        });
      }
    }

    async function handleDeleteForMe(payload: unknown, acknowledge: Ack): Promise<void> {
      try {
        const value = messageIdSchema.parse(payload);
        await input.messages.deleteForMe(authContext.userId, value.messageId);
        acknowledge({ ok: true, data: { messageId: value.messageId } });
      } catch {
        acknowledge(rejected('MESSAGE_DELETE_REJECTED', socket.id));
      }
    }

    async function handleDeleteForEveryone(payload: unknown, acknowledge: Ack): Promise<void> {
      try {
        const value = messageIdSchema.parse(payload);
        const message = await input.messages.deleteForEveryone(authContext.userId, value.messageId);
        if (!input.enableOutbox)
          io.to(`conversation:${message.conversationId}`).emit('message:deletedEveryone', message);
        acknowledge({ ok: true, data: message });
      } catch {
        acknowledge(rejected('MESSAGE_DELETE_REJECTED', socket.id));
      }
    }

    async function handleReaction(payload: unknown, acknowledge: Ack): Promise<void> {
      try {
        const value = reactionSchema.parse(payload);
        const reaction = await input.messages.setReaction(
          authContext.userId,
          value.messageId,
          value.emoji,
          value.active,
        );
        if (!input.enableOutbox)
          io.to(`conversation:${reaction.conversationId}`).emit('reaction:changed', reaction);
        acknowledge({ ok: true, data: reaction });
      } catch {
        acknowledge(rejected('REACTION_REJECTED', socket.id));
      }
    }

    function handleTyping(payload: unknown, acknowledge: Ack): void {
      try {
        const value = typingSchema.parse(payload);
        if (!authorizedConversationIds.has(value.conversationId))
          throw new Error('Conversation is not authorized.');
        const previousTimer = typingTimers.get(value.conversationId);
        if (previousTimer) clearTimeout(previousTimer);
        if (value.isTyping) {
          activeTyping.add(value.conversationId);
          const timer = setTimeout(() => {
            activeTyping.delete(value.conversationId);
            typingTimers.delete(value.conversationId);
            socket.to(`conversation:${value.conversationId}`).emit('typing:changed', {
              conversationId: value.conversationId,
              userId: authContext.userId,
              isTyping: false,
              expiresAt: new Date().toISOString(),
            });
          }, 5_000);
          timer.unref();
          typingTimers.set(value.conversationId, timer);
        } else {
          activeTyping.delete(value.conversationId);
          typingTimers.delete(value.conversationId);
        }
        const expiresAt = new Date(Date.now() + (value.isTyping ? 5_000 : 0)).toISOString();
        const lastEmit = lastTypingEmit.get(value.conversationId) ?? 0;
        if (!value.isTyping || Date.now() - lastEmit >= 2_000) {
          lastTypingEmit.set(value.conversationId, Date.now());
          socket.to(`conversation:${value.conversationId}`).emit('typing:changed', {
            conversationId: value.conversationId,
            userId: authContext.userId,
            isTyping: value.isTyping,
            expiresAt,
          });
        }
        acknowledge({ ok: true, data: { expiresAt } });
      } catch {
        acknowledge(rejected('TYPING_REJECTED', socket.id));
      }
    }

    async function handleReceipt(
      type: 'delivered' | 'seen',
      payload: unknown,
      acknowledge: Ack,
    ): Promise<void> {
      try {
        const value = receiptSchema.parse(payload);
        const receipt = await input.messages.advanceReceipt(authContext.userId, {
          ...value,
          type,
        });
        io.to(`conversation:${value.conversationId}`).emit('receipt:changed', receipt);
        acknowledge({ ok: true, data: receipt });
      } catch {
        acknowledge(rejected('RECEIPT_REJECTED', socket.id));
      }
    }
  }

  async function visibilityFor(userId: string): Promise<'everyone' | 'contacts' | 'nobody'> {
    if (input.loadPresenceVisibility) return input.loadPresenceVisibility(userId);
    const user = await UserModel.findById(userId).select({ presenceVisibility: 1 }).lean();
    return user?.presenceVisibility ?? 'nobody';
  }

  async function canSeePresence(
    viewerId: string,
    targetId: string,
    visibility: string,
  ): Promise<boolean> {
    if (viewerId === targetId) return true;
    if (visibility === 'nobody') return false;
    if (visibility === 'everyone') return true;
    const targetConversations = await ConversationMemberModel.find({ userId: targetId })
      .select({ conversationId: 1 })
      .lean();
    if (targetConversations.length === 0) return false;
    return Boolean(
      await ConversationMemberModel.exists({
        userId: viewerId,
        conversationId: { $in: targetConversations.map((member) => member.conversationId) },
      }),
    );
  }

  async function isOnline(userId: string): Promise<boolean> {
    if (publisher) {
      const key = `presence:user:${userId}`;
      await publisher.zRemRangeByScore(key, 0, Date.now());
      return (await publisher.zCard(key)) > 0;
    }
    return (localPresence.get(userId)?.size ?? 0) > 0;
  }

  async function publishVisiblePresence(
    userId: string,
    status: 'online' | 'offline' | 'unknown',
    visibility: 'everyone' | 'contacts' | 'nobody',
    lastSeenAt?: string,
  ): Promise<void> {
    const members = await ConversationMemberModel.find({ userId })
      .select({ conversationId: 1 })
      .lean();
    if (members.length === 0) return;
    const peers = await ConversationMemberModel.find({
      conversationId: { $in: members.map((member) => member.conversationId) },
      userId: { $ne: userId },
    })
      .select({ userId: 1 })
      .lean();
    const peerIds = new Set(peers.map((member) => String(member.userId)));
    const updatedAt = new Date().toISOString();
    for (const peerId of peerIds) {
      const permitted = await canSeePresence(peerId, userId, visibility);
      io.to(`user:${peerId}`).emit('presence:changed', {
        userId,
        status: permitted ? status : 'unknown',
        updatedAt,
        ...(permitted && status === 'offline' ? { lastSeenAt: lastSeenAt ?? updatedAt } : {}),
      });
    }
  }

  async function addPresence(userId: string, socketId: string): Promise<boolean> {
    if (publisher) {
      const key = `presence:user:${userId}`;
      const now = Date.now();
      await publisher.zRemRangeByScore(key, 0, now);
      const before = await publisher.zCard(key);
      await publisher.zAdd(key, { score: now + 90_000, value: socketId });
      await publisher.expire(key, 120);
      return before === 0;
    }
    const sockets = localPresence.get(userId) ?? new Set<string>();
    const wasOffline = sockets.size === 0;
    sockets.add(socketId);
    localPresence.set(userId, sockets);
    return wasOffline;
  }

  async function refreshPresence(userId: string, socketId: string): Promise<void> {
    if (!publisher) return;
    const key = `presence:user:${userId}`;
    await publisher.zAdd(key, { score: Date.now() + 90_000, value: socketId });
    await publisher.expire(key, 120);
  }

  async function removePresence(userId: string, socketId: string): Promise<boolean> {
    if (publisher) {
      const key = `presence:user:${userId}`;
      await publisher.zRem(key, socketId);
      await publisher.zRemRangeByScore(key, 0, Date.now());
      return (await publisher.zCard(key)) === 0;
    }
    const sockets = localPresence.get(userId);
    sockets?.delete(socketId);
    if (!sockets || sockets.size === 0) {
      localPresence.delete(userId);
      return true;
    }
    return false;
  }

  const outbox =
    input.enableOutbox === true
      ? startRealtimeOutbox((userIds, name, payload) => {
          io.to(userIds.map((id) => `user:${id}`)).emit(name, payload);
        }, input.logger)
      : undefined;

  return {
    async disconnect() {
      await outbox?.disconnect();
      await io.close();
      await Promise.allSettled([
        ...(publisher ? [publisher.quit()] : []),
        ...(subscriber ? [subscriber.quit()] : []),
      ]);
    },
  };
}

function rejected(
  code: string,
  requestId: string,
): {
  ok: false;
  error: { code: string; message: string; retryable: boolean; requestId: string };
} {
  return {
    ok: false,
    error: { code, message: 'Realtime command was rejected.', retryable: false, requestId },
  };
}
