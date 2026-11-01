import request from 'supertest';

import { createApp } from '../src/app.js';
import type { AuthService } from '../src/auth/service.js';
import { DeviceService } from '../src/devices/service.js';
import { NotificationService } from '../src/notifications/service.js';
import { createSilentLogger, createTestConfig } from './helpers.js';

function setup(nodeEnv: 'test' | 'production' = 'test') {
  const authenticateAccess = jest
    .fn()
    .mockResolvedValue({ userId: 'a'.repeat(24), sessionId: 'session' });
  const devices = new DeviceService();
  const register = jest.spyOn(devices, 'register').mockResolvedValue({
    id: 'id',
    deviceId: 'phone',
    deviceName: 'Phone',
    platform: 'android',
    createdAt: 'date',
    updatedAt: 'date',
  });
  const unregister = jest.spyOn(devices, 'unregister').mockResolvedValue();
  const notifications = new NotificationService(
    { sendEachForMulticast: jest.fn() },
    devices,
    createSilentLogger(),
  );
  const sendTest = jest.spyOn(notifications, 'sendTest').mockResolvedValue();
  const app = createApp({
    auth: { authenticateAccess } as unknown as AuthService,
    devices,
    notifications,
    config: createTestConfig({ nodeEnv }),
    logger: createSilentLogger(),
    readiness: { check: jest.fn() } as never,
  });
  return { app, register, unregister, sendTest };
}
afterEach(() => jest.restoreAllMocks());
test('device and test push endpoints require authentication', async () => {
  const { app, register, sendTest } = setup();
  expect((await request(app).post('/v1/devices').send({})).status).toBe(401);
  expect((await request(app).delete('/v1/devices/phone')).status).toBe(401);
  expect((await request(app).post('/v1/notifications/test').send({})).status).toBe(401);
  expect(register).not.toHaveBeenCalled();
  expect(sendTest).not.toHaveBeenCalled();
});
test('body userId cannot select owner and unregister is scoped to authenticated user', async () => {
  const { app, register, unregister } = setup();
  const payload = {
    deviceId: 'phone',
    deviceName: 'Phone',
    platform: 'android',
    fcmToken: 'fake-token',
  };
  expect(
    (
      await request(app)
        .post('/v1/devices')
        .auth('fake', { type: 'bearer' })
        .send({ ...payload, userId: 'b'.repeat(24) })
    ).status,
  ).toBe(201);
  expect(register).toHaveBeenCalledWith('a'.repeat(24), payload);
  expect(
    (await request(app).delete('/v1/devices/phone').auth('fake', { type: 'bearer' })).status,
  ).toBe(204);
  expect(unregister).toHaveBeenCalledWith('a'.repeat(24), 'phone');
});
test('rejects malformed registration', async () => {
  const { app, register } = setup();
  expect(
    (
      await request(app)
        .post('/v1/devices')
        .auth('fake', { type: 'bearer' })
        .send({ platform: 'web' })
    ).status,
  ).toBe(422);
  expect(register).not.toHaveBeenCalled();
});
test('test notification targets authenticated user', async () => {
  const { app, sendTest } = setup();
  expect(
    (
      await request(app)
        .post('/v1/notifications/test')
        .auth('fake', { type: 'bearer' })
        .send({ title: 'Alap', body: 'FCM is working!' })
    ).status,
  ).toBe(200);
  expect(sendTest).toHaveBeenCalledWith('a'.repeat(24), { title: 'Alap', body: 'FCM is working!' });
});
test('production has no test push endpoint', async () => {
  const { app, sendTest } = setup('production');
  expect(
    (
      await request(app)
        .post('/v1/notifications/test')
        .auth('fake', { type: 'bearer' })
        .send({ title: 'Alap', body: 'test' })
    ).status,
  ).toBe(404);
  expect(sendTest).not.toHaveBeenCalled();
});
