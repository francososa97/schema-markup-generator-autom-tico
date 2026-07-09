import { PrismaClient } from '@prisma/client';
import { createApp } from './app';
import { env } from './config/env';

const prisma = new PrismaClient();
const app = createApp(prisma);

const server = app.listen(env.PORT, () => {
  console.log(`API escuchando en :${env.PORT} (${env.NODE_ENV})`);
});

async function shutdown(): Promise<void> {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
