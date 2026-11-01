import { Router } from 'express';
import { z } from 'zod';

import { getAuthContext, requireAccessToken } from '../auth/middleware.js';
import type { AuthService } from '../auth/service.js';
import type { NotificationService } from './service.js';

const schema = z
  .object({
    title: z.string().trim().min(1).max(100),
    body: z.string().trim().min(1).max(500),
  })
  .strict();

export function createNotificationRouter(
  auth: AuthService,
  notifications: NotificationService,
): Router {
  const router = Router();
  router.use(requireAccessToken(auth));
  router.post('/test', async (request, response) => {
    const input = schema.parse(request.body);
    await notifications.sendTest(getAuthContext(response.locals).userId, input);
    response.json({ data: { attempted: true } });
  });
  return router;
}
