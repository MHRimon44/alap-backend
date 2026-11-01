import pino, { type Logger } from 'pino';

import type { ApiConfig } from '../src/config/env.js';

export function createTestConfig(overrides: Partial<ApiConfig> = {}): ApiConfig {
  return Object.freeze({
    firebase: {
      projectId: 'test-project',
      clientEmail: 'test@example.com',
      privateKey: 'test-only',
    },
    adminEmails: Object.freeze([]),
    registrationOtpEnabled: false,
    passwordResetEnabled: false,
    accessTokenAudience: 'chat-mobile-test',
    accessTokenIssuer: 'chat-api-test',
    accessTokenPrivateKey: 'test-private-key',
    accessTokenPublicKey: 'test-public-key',
    accessTokenTtlSeconds: 600,
    bodyLimit: '1kb',
    corsAllowedOrigins: Object.freeze(['https://allowed.example']),
    email: Object.freeze({ provider: 'unconfigured' }),
    logLevel: 'silent',
    mongoMaxPoolSize: 5,
    mongoServerSelectionTimeoutMs: 500,
    mongoUri: 'mongodb://user:password@localhost:27017/chat_test',
    nodeEnv: 'test',
    port: 4_000,
    redisConnectTimeoutMs: 500,
    redisUrl: 'redis://:password@localhost:6379/1',
    refreshTokenTtlDays: 30,
    passwordResetTtlMinutes: 15,
    passwordResetUrl: 'https://app.example.test/password/reset',
    shutdownTimeoutMs: 2_000,
    trustProxy: false,
    ...overrides,
  });
}

export function createSilentLogger(): Logger {
  return pino({ level: 'silent' });
}
