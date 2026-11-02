import { PrismaClient } from '@prisma/client';
import * as path from 'path';
import { app } from 'electron';

// Initialize Prisma Client with custom database path
const dbPath = app.isPackaged
  ? path.join(app.getPath('userData'), 'melodics.db')
  : path.join(__dirname, '../../../prisma/dev.db');

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: `file:${dbPath}`,
    },
  },
});

// Graceful shutdown
export async function disconnectDb() {
  await prisma.$disconnect();
}
