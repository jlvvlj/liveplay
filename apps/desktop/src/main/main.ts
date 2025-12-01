import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import { MidiManager } from './midi/manager';
import { MidiEvent } from './midi/types';
import { disconnectDb } from './data/db';
import * as deviceMappings from './data/device-mappings';

let mainWindow: BrowserWindow | null = null;
let midiManager: MidiManager | null = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  const isDev = process.env.NODE_ENV === 'development';

  if (isDev) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  setupMidi();
  setupIpcHandlers();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('quit', async () => {
  if (midiManager) {
    midiManager.destroy();
  }
  await disconnectDb();
});

function setupMidi() {
  midiManager = new MidiManager();

  // Set up callback to forward MIDI events to renderer
  midiManager.onEvent((event: MidiEvent) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('midi:event', event);
    }
  });
}

function setupIpcHandlers() {
  // List available MIDI devices
  ipcMain.handle('midi:list', async () => {
    if (!midiManager) {
      return [];
    }
    return midiManager.listDevices();
  });

  // Select a MIDI device
  ipcMain.handle('midi:selectDevice', async (_event, deviceId: string) => {
    if (!midiManager) {
      throw new Error('MIDI manager not initialized');
    }
    const success = midiManager.selectDevice(deviceId);
    if (!success) {
      throw new Error(`Failed to select device: ${deviceId}`);
    }
    return success;
  });

  // Device mapping IPC handlers
  ipcMain.handle('mapping:get', async (_event, deviceId: string) => {
    return await deviceMappings.getDeviceMapping(deviceId);
  });

  ipcMain.handle('mapping:save', async (_event, mapping: deviceMappings.DeviceMapping) => {
    await deviceMappings.saveDeviceMapping(mapping);
  });

  ipcMain.handle('mapping:getAll', async () => {
    return await deviceMappings.getAllDeviceMappings();
  });

  ipcMain.handle('mapping:delete', async (_event, deviceId: string) => {
    await deviceMappings.deleteDeviceMapping(deviceId);
  });
}
