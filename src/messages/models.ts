import mongoose from 'mongoose';
import type { Model, Types } from 'mongoose';

const { model, models, Schema } = mongoose;
export interface MessageDocument {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  senderId: Types.ObjectId;
  clientMessageId: string;
  kind: 'text';
  text: string;
  replyToMessageId?: Types.ObjectId;
  globalDeletedAt?: Date;
  globalDeletedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageUserStateDocument {
  _id: Types.ObjectId;
  messageId: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  deletedForUserAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface MessageReactionDocument {
  _id: Types.ObjectId;
  messageId: Types.ObjectId;
  conversationId: Types.ObjectId;
  userId: Types.ObjectId;
  emoji: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface OutboxEventDocument {
  _id: Types.ObjectId;
  type: 'message.created' | 'message.deleted' | 'reaction.updated';
  aggregateId: Types.ObjectId;
  conversationId: Types.ObjectId;
  payload: Record<string, unknown>;
  pushProcessedAt?: Date;
  pushLockedAt?: Date;
  pushLockOwner?: string;
  pushAvailableAt?: Date;
  pushAttempts?: number;
  pushDeliveredUserIds?: string[];
  attempts: number;
  availableAt: Date;
  lockedAt?: Date;
  processedAt?: Date;
  lastErrorCode?: string;
  createdAt: Date;
}

const schema = new Schema<MessageDocument>(
  {
    conversationId: { type: Schema.Types.ObjectId, required: true },
    senderId: { type: Schema.Types.ObjectId, required: true },
    clientMessageId: { type: String, required: true },
    kind: { type: String, enum: ['text'], required: true },
    text: { type: String, required: true, maxlength: 4_000 },
    replyToMessageId: Schema.Types.ObjectId,
    globalDeletedAt: Date,
    globalDeletedBy: Schema.Types.ObjectId,
  },
  { timestamps: true, versionKey: 'version' },
);
schema.index({ senderId: 1, clientMessageId: 1 }, { unique: true });
schema.index({ conversationId: 1, createdAt: -1, _id: -1 });
schema.index({ replyToMessageId: 1 }, { sparse: true });

const userStateSchema = new Schema<MessageUserStateDocument>(
  {
    messageId: { type: Schema.Types.ObjectId, required: true },
    conversationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    deletedForUserAt: { type: Date, required: true },
  },
  { timestamps: true, versionKey: false },
);
userStateSchema.index({ messageId: 1, userId: 1 }, { unique: true });
userStateSchema.index({ conversationId: 1, userId: 1, deletedForUserAt: 1 });

const reactionSchema = new Schema<MessageReactionDocument>(
  {
    messageId: { type: Schema.Types.ObjectId, required: true },
    conversationId: { type: Schema.Types.ObjectId, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    emoji: { type: String, required: true, maxlength: 16 },
  },
  { timestamps: true, versionKey: false },
);
reactionSchema.index({ messageId: 1, userId: 1, emoji: 1 }, { unique: true });
reactionSchema.index({ messageId: 1, createdAt: 1 });

const outboxSchema = new Schema<OutboxEventDocument>(
  {
    type: {
      type: String,
      enum: ['message.created', 'message.deleted', 'reaction.updated'],
      required: true,
    },
    aggregateId: { type: Schema.Types.ObjectId, required: true },
    conversationId: { type: Schema.Types.ObjectId, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    pushProcessedAt: Date,
    pushLockedAt: Date,
    pushLockOwner: String,
    pushAvailableAt: Date,
    pushAttempts: Number,
    pushDeliveredUserIds: [String],
    attempts: { type: Number, default: 0, required: true },
    availableAt: { type: Date, default: Date.now, required: true },
    lockedAt: Date,
    processedAt: Date,
    lastErrorCode: String,
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
outboxSchema.index({ type: 1, pushProcessedAt: 1, pushAvailableAt: 1 });
outboxSchema.index({ conversationId: 1, _id: 1 });
outboxSchema.index({ processedAt: 1, availableAt: 1, _id: 1 });

export const MessageModel: Model<MessageDocument> =
  (models.Message as Model<MessageDocument> | undefined) ??
  model<MessageDocument>('Message', schema);
export const MessageUserStateModel: Model<MessageUserStateDocument> =
  (models.MessageUserState as Model<MessageUserStateDocument> | undefined) ??
  model<MessageUserStateDocument>('MessageUserState', userStateSchema);
export const MessageReactionModel: Model<MessageReactionDocument> =
  (models.MessageReaction as Model<MessageReactionDocument> | undefined) ??
  model<MessageReactionDocument>('MessageReaction', reactionSchema);
export const OutboxEventModel: Model<OutboxEventDocument> =
  (models.OutboxEvent as Model<OutboxEventDocument> | undefined) ??
  model<OutboxEventDocument>('OutboxEvent', outboxSchema);
