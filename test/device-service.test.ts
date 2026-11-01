import mongoose, { Types } from 'mongoose';

import { DeviceModel } from '../src/devices/models.js';
import { DeviceService } from '../src/devices/service.js';

const userId = 'a'.repeat(24);
const input = {
  deviceId: 'installation',
  deviceName: 'Phone',
  platform: 'android' as const,
  fcmToken: 'fake-token',
};
afterEach(() => jest.restoreAllMocks());

test('registration transfers token and installation inside transaction and upserts only authenticated owner', async () => {
  const session = {};
  jest
    .spyOn(mongoose.connection, 'transaction')
    .mockImplementation(async (callback) => callback(session as never));
  const remove = jest
    .spyOn(DeviceModel, 'deleteMany')
    .mockResolvedValue({ acknowledged: true, deletedCount: 1 });
  const update = jest.spyOn(DeviceModel, 'findOneAndUpdate').mockReturnValue({
    lean: async () => ({
      _id: new Types.ObjectId(),
      ...input,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  } as never);
  const result = await new DeviceService().register(userId, input);
  expect(remove).toHaveBeenCalledWith(
    {
      $or: [{ fcmToken: input.fcmToken }, { deviceId: input.deviceId }],
      $nor: [{ userId: new Types.ObjectId(userId), deviceId: input.deviceId }],
    },
    { session },
  );
  expect(update).toHaveBeenCalledWith(
    { userId: new Types.ObjectId(userId), deviceId: input.deviceId },
    expect.objectContaining({ $set: expect.objectContaining(input) }),
    expect.objectContaining({ upsert: true, session }),
  );
  expect(result).not.toHaveProperty('fcmToken');
});
test('unregister is scoped to authenticated user', async () => {
  const remove = jest
    .spyOn(DeviceModel, 'deleteOne')
    .mockResolvedValue({ acknowledged: true, deletedCount: 0 });
  await new DeviceService().unregister(userId, 'another-installation');
  expect(remove).toHaveBeenCalledWith({
    userId: new Types.ObjectId(userId),
    deviceId: 'another-installation',
  });
});
test('empty token cleanup does not touch database', async () => {
  const remove = jest.spyOn(DeviceModel, 'deleteMany');
  await new DeviceService().removeTokens([]);
  expect(remove).not.toHaveBeenCalled();
});
