import pino, { type Logger } from 'pino';

import type { ApiConfig } from '../config/env.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.newPassword',
  'req.body.refreshToken',
  'req.body.resetToken',
  'res.headers.set-cookie',
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'resetToken',
  'pushToken',
  'fcmToken',
  'req.body.fcmToken',
  'privateKey',
  'firebase.privateKey',
];

export function createLogger(config: Pick<ApiConfig, 'logLevel' | 'nodeEnv'>): Logger {
  return pino({
    base: { environment: config.nodeEnv, service: 'chat-api' },
    level: config.logLevel,
    redact: { censor: '[REDACTED]', paths: redactPaths },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
