import { Router } from 'express';
import { z } from 'zod';

import { getAuthContext, requireAccessToken } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import type { DeviceService } from './service.js';

const registerSchema = z.object({
  deviceId: z.string().trim().min(1).max(500),
  deviceName: z.string().trim().min(1).max(200),
  platform: z.enum(['android', 'ios']),
  fcmToken: z.string().trim().min(1).max(4096),
});

const deviceParamsSchema = z.object({
  deviceId: z.string().trim().min(1).max(500),
});

export function createDeviceRouter(auth: AuthService, devices: DeviceService): Router {
  const router = Router();

  router.use(requireAccessToken(auth));

  router.post('/', async (request, response) => {
    const actor = getAuthContext(response.locals);
    const input = registerSchema.parse(request.body);

    const device = await devices.register(actor.userId, input);

    response.status(201).json({
      data: device,
    });
  });

  router.delete('/:deviceId', async (request, response) => {
    const actor = getAuthContext(response.locals);

    const { deviceId } = deviceParamsSchema.parse(request.params);

    await devices.unregister(actor.userId, deviceId);

    response.status(204).send();
  });

  return router;
}
