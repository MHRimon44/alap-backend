import { DeviceService } from './devices/service.js';
import { initializeFirebase, firebaseMessaging } from './notifications/firebase.js';
import { NotificationService } from './notifications/service.js';
import { startPushWorker } from './notifications/outbox.js';
import { createServer, type Server } from 'node:http';

import type { Logger } from 'pino';

import { createApp } from './app.js';
import { passwordHasher } from './auth/crypto.js';
import { createAccessTokenProvider } from './auth/jwt.js';
import { createMongoAuthRepository } from './auth/mongo-repository.js';
import { createRedisRateLimiter } from './auth/redis-rate-limiter.js';
import { createResendEmailNotifier } from './auth/resend-email-notifier.js';
import { createUnconfiguredEmailNotifier } from './auth/email-notifier.js';
import { createAuthService } from './auth/service.js';
import { createMongoConversationRepository } from './conversations/repository.js';
import { createConversationService } from './conversations/service.js';
import { loadConfig } from './config/env.js';
import { createReadinessProbe } from './health/readiness.js';
import { createMongoConnection } from './infrastructure/mongo.js';
import { createRedisConnection } from './infrastructure/redis.js';
import { createLogger } from './logging/logger.js';
import { createMessageService } from './messages/service.js';
import { createShutdownHandler } from './runtime/shutdown.js';
import { createRealtimeServer } from './realtime/socket-server.js';
import { createMongoUserRepository } from './users/repository.js';
import { createUserService } from './users/service.js';
import { createAdminService } from './admin/service.js';

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

async function main(): Promise<void> {
  const config = loadConfig();
  initializeFirebase(config.firebase);
  const logger: Logger = createLogger(config);
  const mongo = createMongoConnection(config, logger);
  const redis = createRedisConnection(config, logger);

  try {
    await Promise.all([mongo.connect(), redis.connect()]);
  } catch (error) {
    logger.fatal({ err: error }, 'Failed to connect required dependencies');
    await Promise.allSettled([mongo.disconnect(), redis.disconnect()]);
    throw error;
  }

  const readiness = createReadinessProbe({ mongo, redis });
  const emailNotifier =
    config.email.provider === 'resend'
      ? createResendEmailNotifier(config.email)
      : createUnconfiguredEmailNotifier(logger);
  const auth = createAuthService({
    registrationOtpEnabled: config.registrationOtpEnabled,
    passwordResetEnabled: config.passwordResetEnabled,
    accessTokens: createAccessTokenProvider({
      audience: config.accessTokenAudience,
      issuer: config.accessTokenIssuer,
      privateKeyPem: config.accessTokenPrivateKey,
      publicKeyPem: config.accessTokenPublicKey,
      ttlSeconds: config.accessTokenTtlSeconds,
    }),
    passwordHasher,
    rateLimiter: createRedisRateLimiter(redis),
    emailNotifier,
    repository: createMongoAuthRepository(),
    refreshTokenTtlDays: config.refreshTokenTtlDays,
    resetTtlMinutes: config.passwordResetTtlMinutes,
  });
  const rateLimiter = createRedisRateLimiter(redis);
  const userRepository = createMongoUserRepository();
  const users = createUserService(userRepository, rateLimiter);
  const conversations = createConversationService(
    createMongoConversationRepository(),
    userRepository,
  );
  const messages = createMessageService(() => new Date(), rateLimiter);
  const admin = createAdminService(config.adminEmails, passwordHasher);
  const devices = new DeviceService();
  const notifications = new NotificationService(firebaseMessaging(), devices, logger);
  const app = createApp({
    devices,
    notifications,
    admin,
    auth,
    config,
    conversations,
    logger,
    messages,
    readiness,
    users,
  });
  const server = createServer(app);
  const realtime = await createRealtimeServer({
    enableOutbox: true,
    auth,
    config,
    logger,
    messages,
    server,
  });
  const pushWorker = startPushWorker(notifications, logger);
  const shutdown = createShutdownHandler({
    connections: [
      {
        async disconnect() {
          await pushWorker.disconnect();
          await realtime.disconnect();
          await Promise.all([mongo.disconnect(), redis.disconnect()]);
        },
      },
    ],
    logger,
    server,
    timeoutMs: config.shutdownTimeoutMs,
  });

  const onSignal = (signal: NodeJS.Signals): void => {
    void shutdown(signal).catch((error: unknown) => {
      logger.fatal({ err: error }, 'Graceful shutdown failed');
      process.exitCode = 1;
    });
  };

  const onFatalError = (error: unknown, origin: string): void => {
    logger.fatal({ err: error, origin }, 'Fatal process error');
    process.exitCode = 1;
    void shutdown(origin).catch((shutdownError: unknown) => {
      logger.fatal({ err: shutdownError }, 'Shutdown after fatal error failed');
    });
  };

  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('uncaughtException', (error) => onFatalError(error, 'uncaughtException'));
  process.once('unhandledRejection', (reason) => onFatalError(reason, 'unhandledRejection'));

  await listen(server, config.port);
  logger.info({ port: config.port }, 'Chat API listening');
}

void main().catch((error: unknown) => {
  const fallbackLogger = createLogger({ logLevel: 'error', nodeEnv: 'production' });
  fallbackLogger.fatal({ err: error }, 'API startup failed');
  process.exitCode = 1;
});
