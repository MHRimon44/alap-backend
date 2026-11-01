import type { MulticastMessage, BatchResponse } from 'firebase-admin/messaging';

import { NotificationService } from '../src/notifications/service.js';
import { createSilentLogger } from './helpers.js';

function setup(tokens: string[] = ['fake-token']) {
  const sendEachForMulticast = jest.fn<Promise<BatchResponse>, [MulticastMessage]>();
  const devices = {
    tokensForUser: jest.fn().mockResolvedValue(tokens),
    removeTokens: jest.fn().mockResolvedValue(undefined),
  };
  return {
    sendEachForMulticast,
    devices,
    service: new NotificationService({ sendEachForMulticast }, devices, createSilentLogger()),
  };
}
const chat = {
  recipientId: 'a'.repeat(24),
  senderId: 'b'.repeat(24),
  conversationId: 'c'.repeat(24),
  senderName: 'Sender',
  text: 'Hello',
};
const success: BatchResponse = {
  responses: [{ success: true, messageId: 'fake' }],
  successCount: 1,
  failureCount: 0,
};

test('no devices makes no Firebase call', async () => {
  const context = setup([]);
  await context.service.sendChatMessage(chat);
  expect(context.sendEachForMulticast).not.toHaveBeenCalled();
});
test('chat has navigation data, safe preview and Android channel', async () => {
  const context = setup();
  context.sendEachForMulticast.mockResolvedValue(success);
  await context.service.sendChatMessage({ ...chat, text: '\n' + 'a'.repeat(200) });
  expect(context.sendEachForMulticast).toHaveBeenCalledWith(
    expect.objectContaining({
      notification: { title: 'Sender', body: 'a'.repeat(120) },
      data: {
        type: 'CHAT_MESSAGE',
        conversationId: chat.conversationId,
        senderId: chat.senderId,
        senderName: 'Sender',
      },
      android: { priority: 'high', notification: { channelId: 'messages', sound: 'default' } },
    }),
  );
});
test.each(['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'])(
  'cleans definitive invalid token: %s',
  async (code) => {
    const context = setup();
    context.sendEachForMulticast.mockResolvedValue({
      responses: [{ success: false, error: { code } }],
      successCount: 0,
      failureCount: 1,
    } as BatchResponse);
    await context.service.sendChatMessage(chat);
    expect(context.devices.removeTokens).toHaveBeenCalledWith(['fake-token']);
  },
);
test('transient errors retain tokens and request retry', async () => {
  const context = setup();
  context.sendEachForMulticast.mockResolvedValue({
    responses: [{ success: false, error: { code: 'messaging/server-unavailable' } }],
    successCount: 0,
    failureCount: 1,
  } as BatchResponse);
  await expect(context.service.sendChatMessage(chat)).rejects.toMatchObject({
    code: 'FCM_DELIVERY_FAILED',
  });
  expect(context.devices.removeTokens).toHaveBeenCalledWith([]);
});
test('batch rejection is sanitized', async () => {
  const context = setup();
  context.sendEachForMulticast.mockRejectedValue(new Error('fake-sensitive-value'));
  await expect(context.service.sendChatMessage(chat)).rejects.toThrow(
    'Notification delivery is temporarily unavailable.',
  );
  expect(context.devices.removeTokens).not.toHaveBeenCalled();
});
test('splits multicast into batches of at most 500', async () => {
  const context = setup(Array.from({ length: 1001 }, (_, i) => `fake-${i}`));
  context.sendEachForMulticast.mockResolvedValue(success);
  await context.service.sendChatMessage(chat);
  expect(context.sendEachForMulticast.mock.calls.map(([payload]) => payload.tokens.length)).toEqual(
    [500, 500, 1],
  );
});
test('malformed navigation data rejected before sending', async () => {
  const context = setup();
  await expect(
    context.service.sendChatMessage({ ...chat, conversationId: 'bad' }),
  ).rejects.toThrow();
  expect(context.sendEachForMulticast).not.toHaveBeenCalled();
});
