import { DeviceModel } from '../devices/models.js';
import { loadConfig } from '../config/env.js';
import { createMongoConnection } from '../infrastructure/mongo.js';
import { createLogger } from '../logging/logger.js';
import {
  PasswordResetModel,
  PendingRegistrationModel,
  RefreshTokenModel,
  SessionModel,
  UserModel,
} from '../auth/models.js';
import { ConversationMemberModel, ConversationModel } from '../conversations/models.js';
import {
  MessageModel,
  MessageReactionModel,
  MessageUserStateModel,
  OutboxEventModel,
} from '../messages/models.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config);
  const mongo = createMongoConnection(config, logger);
  await mongo.connect();
  try {
    await Promise.all([
      DeviceModel.createIndexes(),
      UserModel.createIndexes(),
      SessionModel.createIndexes(),
      RefreshTokenModel.createIndexes(),
      PasswordResetModel.createIndexes(),
      PendingRegistrationModel.createIndexes(),
      ConversationModel.createIndexes(),
      ConversationMemberModel.createIndexes(),
      MessageModel.createIndexes(),
      MessageUserStateModel.createIndexes(),
      MessageReactionModel.createIndexes(),
      OutboxEventModel.createIndexes(),
    ]);
    logger.info('Application indexes created');
  } finally {
    await mongo.disconnect();
  }
}

void main().catch((error: unknown) => {
  const logger = createLogger({ logLevel: 'error', nodeEnv: 'production' });
  logger.fatal({ err: error }, 'Application index creation failed');
  process.exitCode = 1;
});
