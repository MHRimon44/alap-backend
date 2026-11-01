import mongoose from 'mongoose';
import type { Model, Types } from 'mongoose';

const { Schema, model, models } = mongoose;

export interface DeviceDocument {
  _id: Types.ObjectId;
  userId: Types.ObjectId;

  deviceId: string;
  deviceName: string;

  platform: 'android' | 'ios';

  fcmToken: string;

  lastActiveAt: Date;

  createdAt: Date;
  updatedAt: Date;
}

const deviceSchema = new Schema<DeviceDocument>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      required: true,
      index: true,
    },

    deviceId: {
      type: String,
      required: true,
      maxlength: 500,
    },

    deviceName: {
      type: String,
      required: true,
      maxlength: 200,
    },

    platform: {
      type: String,
      enum: ['android', 'ios'],
      required: true,
    },

    fcmToken: {
      type: String,
      required: true,
      maxlength: 4096,
    },

    lastActiveAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

deviceSchema.index(
  {
    userId: 1,
    deviceId: 1,
  },
  {
    unique: true,
  },
);

deviceSchema.index(
  {
    fcmToken: 1,
  },
  {
    unique: true,
  },
);

deviceSchema.index({ deviceId: 1 }, { unique: true });

deviceSchema.index({
  userId: 1,
  lastActiveAt: -1,
});

export const DeviceModel: Model<DeviceDocument> =
  (models.Device as Model<DeviceDocument> | undefined) ??
  model<DeviceDocument>('Device', deviceSchema);
