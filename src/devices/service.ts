import { AppError } from '../errors/app-error.js';
import mongoose, { Types } from 'mongoose';

import { DeviceModel } from './models.js';

export type RegisterDeviceInput = {
  deviceId: string;
  deviceName: string;
  platform: 'android' | 'ios';
  fcmToken: string;
};

export class DeviceService {
  async register(
    userId: string,
    input: RegisterDeviceInput,
  ): Promise<{
    id: string;
    deviceId: string;
    deviceName: string;
    platform: 'android' | 'ios';
    createdAt: string;
    updatedAt: string;
  }> {
    const device = await mongoose.connection
      .transaction(async (session) => {
        // Remove any previous owner of this installation or token, including this
        // user's obsolete deviceId. Unique indexes arbitrate concurrent registrations.
        await DeviceModel.deleteMany(
          {
            $or: [{ fcmToken: input.fcmToken }, { deviceId: input.deviceId }],
            $nor: [{ userId: new Types.ObjectId(userId), deviceId: input.deviceId }],
          },
          { session },
        );
        return DeviceModel.findOneAndUpdate(
          { userId: new Types.ObjectId(userId), deviceId: input.deviceId },
          { $set: { ...input, lastActiveAt: new Date() } },
          { returnDocument: 'after', upsert: true, runValidators: true, session },
        ).lean();
      })
      .catch(() => {
        // Mongo duplicate-key errors can contain the token. Never forward them to HTTP logs.
        throw new AppError({
          code: 'DEVICE_REGISTRATION_FAILED',
          message: 'Device registration could not be completed. Retry registration.',
          statusCode: 409,
        });
      });

    return {
      id: String(device._id),
      deviceId: device.deviceId,
      deviceName: device.deviceName,
      platform: device.platform,
      createdAt: device.createdAt.toISOString(),
      updatedAt: device.updatedAt.toISOString(),
    };
  }

  async unregister(userId: string, deviceId: string): Promise<void> {
    await DeviceModel.deleteOne({
      userId: new Types.ObjectId(userId),
      deviceId,
    });
  }

  async tokensForUser(userId: string): Promise<string[]> {
    const devices = await DeviceModel.find({
      userId: new Types.ObjectId(userId),
    })
      .select({ fcmToken: 1 })
      .lean();

    return devices.map((device) => device.fcmToken);
  }

  async removeTokens(tokens: readonly string[]): Promise<void> {
    if (tokens.length === 0) {
      return;
    }

    await DeviceModel.deleteMany({
      fcmToken: { $in: tokens },
    });
  }
}
