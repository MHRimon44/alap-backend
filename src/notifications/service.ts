import type { BatchResponse, MulticastMessage } from 'firebase-admin/messaging';
import type { Logger } from 'pino';
import { z } from 'zod';

import type { DeviceService } from '../devices/service.js';
import { AppError } from '../errors/app-error.js';

const chatSchema = z.object({
  recipientId: z.string().regex(/^[a-f\d]{24}$/i),
  senderId: z.string().regex(/^[a-f\d]{24}$/i),
  conversationId: z.string().regex(/^[a-f\d]{24}$/i),
  senderName: z.string().trim().min(1).max(200),
  text: z.string().max(4000),
});

export class NotificationService {
  constructor(
    private readonly messaging: {
      sendEachForMulticast(message: MulticastMessage): Promise<BatchResponse>;
    },
    private readonly devices: Pick<DeviceService, 'tokensForUser' | 'removeTokens'>,
    private readonly logger: Logger,
  ) {}

  async sendChatMessage(value: z.input<typeof chatSchema>): Promise<void> {
    const input = chatSchema.parse(value);
    await this.send(input.recipientId, {
      notification: {
        title: input.senderName,
        body:
          Array.from(input.text)
            .map((char) => (char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char))
            .join('')
            .trim()
            .slice(0, 120) || 'New message',
      },
      data: {
        type: 'CHAT_MESSAGE',
        conversationId: input.conversationId,
        senderId: input.senderId,
        senderName: input.senderName,
      },
    });
  }

  async sendTest(userId: string, input: { title: string; body: string }): Promise<void> {
    await this.send(userId, { notification: input, data: { type: 'TEST_NOTIFICATION' } });
  }

  private async send(userId: string, payload: Omit<MulticastMessage, 'tokens'>): Promise<void> {
    const tokens = [...new Set(await this.devices.tokensForUser(userId))];
    let retry = false;
    for (let offset = 0; offset < tokens.length; offset += 500) {
      const batch = tokens.slice(offset, offset + 500);
      try {
        const response = await this.messaging.sendEachForMulticast({
          ...payload,
          tokens: batch,
          android: { priority: 'high', notification: { channelId: 'messages', sound: 'default' } },
          apns: { payload: { aps: { sound: 'default' } } },
        });
        const invalid: string[] = [];
        response.responses.forEach((result, index) => {
          if (result.success) return;
          const code = result.error?.code;
          if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
          ) {
            const token = batch[index];
            if (token) invalid.push(token);
          } else retry = true;
          // Firebase error objects/messages may contain registration tokens.
          this.logger.warn({ code, userId }, 'FCM delivery failed');
        });
        await this.devices.removeTokens(invalid);
      } catch {
        retry = true;
        this.logger.warn({ userId }, 'FCM batch failed');
      }
    }
    if (retry)
      throw new AppError({
        code: 'FCM_DELIVERY_FAILED',
        message: 'Notification delivery is temporarily unavailable.',
        statusCode: 503,
      });
  }
}
