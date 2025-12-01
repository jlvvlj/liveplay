import { prisma } from './db';
import { DeviceMapping as PrismaDeviceMapping } from '@prisma/client';

export interface DeviceMapping {
  deviceId: string;
  name: string;
  mappings: { [hardwareNote: number]: number };
}

export async function getDeviceMapping(deviceId: string): Promise<DeviceMapping | null> {
  const mapping = await prisma.deviceMapping.findUnique({
    where: { deviceId },
  });

  if (!mapping) {
    return null;
  }

  return {
    deviceId: mapping.deviceId,
    name: mapping.name,
    mappings: JSON.parse(mapping.mappings),
  };
}

export async function saveDeviceMapping(mapping: DeviceMapping): Promise<void> {
  await prisma.deviceMapping.upsert({
    where: { deviceId: mapping.deviceId },
    update: {
      name: mapping.name,
      mappings: JSON.stringify(mapping.mappings),
    },
    create: {
      deviceId: mapping.deviceId,
      name: mapping.name,
      mappings: JSON.stringify(mapping.mappings),
    },
  });
}

export async function getAllDeviceMappings(): Promise<DeviceMapping[]> {
  const mappings = await prisma.deviceMapping.findMany();

  return mappings.map((m: PrismaDeviceMapping) => ({
    deviceId: m.deviceId,
    name: m.name,
    mappings: JSON.parse(m.mappings),
  }));
}

export async function deleteDeviceMapping(deviceId: string): Promise<void> {
  await prisma.deviceMapping.delete({
    where: { deviceId },
  });
}
