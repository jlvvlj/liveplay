import { PrismaClient } from '@prisma/client';
import path from 'path';

const dbPath = path.resolve(__dirname, '../prisma/dev.db');

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: `file:${dbPath}`,
    },
  },
});
