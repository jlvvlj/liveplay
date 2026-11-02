import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { MidiManager } from './midi/manager';
import { MidiEvent } from './midi/types';
import { disconnectDb } from './data/db';
import * as deviceMappings from './data/device-mappings';

// Get the project root directory (where package.json is)
function getProjectRoot(): string {
  // In development, __dirname is apps/desktop/dist/main
  // Project root is 4 levels up
  let root = __dirname;
  for (let i = 0; i < 4; i++) {
    root = path.dirname(root);
  }
  return root;
}

let mainWindow: BrowserWindow | null = null;
let midiManager: MidiManager | null = null;

function createWindow() {
  const preloadPath = path.join(__dirname, 'preload.js');
  console.log('[Main] Preload script path:', preloadPath);
  console.log('[Main] Preload script exists:', fs.existsSync(preloadPath));

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: preloadPath,
    },
  });

  const isDev = process.env.NODE_ENV === 'development';

  console.log('[Main] Development mode:', isDev);

  if (isDev) {
    console.log('[Main] Loading development URL: http://localhost:5173');
    mainWindow.loadURL('http://localhost:5173');

    // Open DevTools when ready
    mainWindow.webContents.on('did-finish-load', () => {
      console.log('[Main] Page loaded, opening DevTools...');
      if (mainWindow) {
        mainWindow.webContents.openDevTools();
      }
    });
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

  // Audio file path handler
  ipcMain.handle('audio:getPath', async (_event, filename: string) => {
    const projectRoot = getProjectRoot();
    const audioPath = path.join(projectRoot, 'audio', filename);
    console.log('[Main] audio:getPath:', { filename, audioPath, exists: fs.existsSync(audioPath) });
    if (fs.existsSync(audioPath)) {
      return `file://${audioPath}`;
    }
    throw new Error(`Audio file not found: ${filename}`);
  });

  // Get all audio files in the audio folder
  ipcMain.handle('audio:listFiles', async () => {
    const projectRoot = getProjectRoot();
    const audioDir = path.join(projectRoot, 'audio');
    console.log('[Main] audio:listFiles:', audioDir);
    if (fs.existsSync(audioDir)) {
      return fs.readdirSync(audioDir).filter(f => f.endsWith('.wav') || f.endsWith('.mp3'));
    }
    return [];
  });
}
