import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import mongoose, { Types } from 'mongoose';

import { loadConfig } from '../config/env.js';
import { ConversationModel, ConversationMemberModel } from '../conversations/models.js';
import { MessageModel, OutboxEventModel } from '../messages/models.js';
import { createMessageService } from '../messages/service.js';
import { deliverChatPush } from '../notifications/outbox.js';
import { NotificationService } from '../notifications/service.js';
import { DeviceModel } from '../devices/models.js';
import { DeviceService } from '../devices/service.js';
import { createMongoConnection } from '../infrastructure/mongo.js';
import { createRedisConnection } from '../infrastructure/redis.js';
import { createLogger } from '../logging/logger.js';
import { initializeFirebase, firebaseMessaging } from '../notifications/firebase.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ logLevel: 'silent', nodeEnv: 'test' });
  initializeFirebase(config.firebase);
  initializeFirebase(config.firebase);
  assert.ok(firebaseMessaging());
  const mongo = createMongoConnection(config, logger);
  const redis = createRedisConnection(config, logger);
  const userA = new Types.ObjectId();
  const userB = new Types.ObjectId();
  const conversationId = new Types.ObjectId();
  const namespace = `fcm-verification-${randomUUID()}`;
  try {
    await Promise.all([mongo.connect(), redis.connect()]);
    await redis.ping();
    await Promise.all([DeviceModel.createIndexes(), OutboxEventModel.createIndexes()]);
    const devices = new DeviceService();
    const input = {
      deviceId: namespace,
      deviceName: 'Verification fixture',
      platform: 'android' as const,
      fcmToken: `${namespace}-one`,
    };
    const first = await devices.register(String(userA), input);
    const updated = await devices.register(String(userA), {
      ...input,
      fcmToken: `${namespace}-two`,
    });
    assert.equal(first.id, updated.id);
    assert.deepEqual(await devices.tokensForUser(String(userA)), [`${namespace}-two`]);
    await devices.register(String(userA), {
      ...input,
      deviceId: `${namespace}-second`,
      fcmToken: `${namespace}-three`,
    });
    assert.equal((await devices.tokensForUser(String(userA))).length, 2);
    await devices.unregister(String(userB), input.deviceId);
    assert.equal((await devices.tokensForUser(String(userA))).length, 2);
    await devices.register(String(userB), { ...input, fcmToken: `${namespace}-four` });
    assert.deepEqual(await devices.tokensForUser(String(userA)), [`${namespace}-three`]);
    await devices.register(String(userB), {
      ...input,
      deviceId: `${namespace}-new-id`,
      fcmToken: `${namespace}-three`,
    });
    assert.equal((await devices.tokensForUser(String(userA))).length, 0);
    await devices.removeTokens([`${namespace}-three`]);
    await devices.unregister(String(userB), input.deviceId);
    assert.equal((await devices.tokensForUser(String(userB))).length, 0);
    await ConversationModel.create({
      _id: conversationId,
      type: 'direct',
      directKey: namespace,
      createdBy: userA,
      activityAt: new Date(),
    });
    await ConversationMemberModel.create([
      { conversationId, userId: userA, joinedAt: new Date(), sortAt: new Date() },
      { conversationId, userId: userB, joinedAt: new Date(), sortAt: new Date() },
    ]);
    const message = await createMessageService().send(String(userA), {
      conversationId: String(conversationId),
      clientMessageId: randomUUID(),
      text: 'Verification fixture',
    });
    const event = await OutboxEventModel.findOne({ aggregateId: message.id }).lean();
    assert.ok(event);
    await devices.register(String(userB), input);
    const failingNotifications = new NotificationService(
      {
        sendEachForMulticast() {
          return Promise.reject(new Error('Simulated outage'));
        },
      },
      devices,
      logger,
    );
    await assert.rejects(deliverChatPush(event, failingNotifications));
    assert.ok(await MessageModel.exists({ _id: message.id }));
    assert.ok(
      await OutboxEventModel.exists({ _id: event._id, pushProcessedAt: { $exists: false } }),
    );
    process.stdout.write(
      'PASS: Message and outbox transaction persisted despite simulated Firebase outage.\n',
    );
    process.stdout.write(
      'PASS: Firebase local initialization, Redis ping, Mongo indexes, device upsert, multi-device, ownership, installation transfer, token transfer, cleanup. No real FCM send performed.\n',
    );
  } finally {
    if (DeviceModel.db.readyState === mongoose.ConnectionStates.connected)
      await Promise.all([
        DeviceModel.deleteMany({ userId: { $in: [userA, userB] } }),
        ConversationModel.deleteOne({ _id: conversationId }),
        ConversationMemberModel.deleteMany({ conversationId }),
        MessageModel.deleteMany({ conversationId }),
        OutboxEventModel.deleteMany({ conversationId }),
      ]);
    await Promise.allSettled([mongo.disconnect(), redis.disconnect()]);
  }
}

void main().catch(() => {
  process.stderr.write(
    'FAIL: FCM local verification could not complete; configuration, database indexes or dependencies require inspection. Sensitive error details suppressed.\n',
  );
  process.exitCode = 1;
});
