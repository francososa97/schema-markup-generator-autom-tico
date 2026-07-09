import cors from 'cors';
import express, { Application } from 'express';
import helmet from 'helmet';
import { PrismaClient } from '@prisma/client';
import { env } from './config/env';
import { errorHandler } from './shared/middlewares/errorHandler.middleware';
import { createUsersRouter } from './modules/users/presentation/users.routes';

export function createApp(prisma: PrismaClient): Application {
  const app = express();

  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGIN }));
  app.use(express.json());

  app.get('/api/health', (_req, res) => res.status(200).json({ status: 'ok' }));
  app.use('/api/users', createUsersRouter(prisma));

  app.use(errorHandler);

  return app;
}
