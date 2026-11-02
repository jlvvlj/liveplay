import { contextBridge, ipcRenderer } from 'electron';

console.log('[Preload] Starting preload script...');

export interface MidiEvent {
  timestamp: number;
  note: number;
  velocity: number;
  type: 'noteon' | 'noteoff';
}

export interface MidiDevice {
  id: string;
  name: string;
}

export interface DeviceMapping {
  deviceId: string;
  name: string;
  mappings: { [hardwareNote: number]: number };
}

console.log('[Preload] Exposing electronAPI to renderer process...');

contextBridge.exposeInMainWorld('electronAPI', {
  // MIDI APIs
  midi: {
    list: (): Promise<MidiDevice[]> => {
      console.log('[Preload] midi.list() called');
      return ipcRenderer.invoke('midi:list');
    },
    selectDevice: (deviceId: string): Promise<void> => {
      console.log('[Preload] midi.selectDevice() called with:', deviceId);
      return ipcRenderer.invoke('midi:selectDevice', deviceId);
    },
    onEvent: (callback: (event: MidiEvent) => void) => {
      console.log('[Preload] midi.onEvent() listener registered');
      ipcRenderer.on('midi:event', (_event, data) => callback(data));
    },
    removeEventListener: () => {
      console.log('[Preload] midi.removeEventListener() called');
      ipcRenderer.removeAllListeners('midi:event');
    },
  },
  // Device mapping APIs
  mapping: {
    get: (deviceId: string): Promise<DeviceMapping | null> =>
      ipcRenderer.invoke('mapping:get', deviceId),
    save: (mapping: DeviceMapping): Promise<void> =>
      ipcRenderer.invoke('mapping:save', mapping),
    getAll: (): Promise<DeviceMapping[]> => ipcRenderer.invoke('mapping:getAll'),
    delete: (deviceId: string): Promise<void> =>
      ipcRenderer.invoke('mapping:delete', deviceId),
  },
  // Audio APIs
  audio: {
    getPath: (filename: string): Promise<string> =>
      ipcRenderer.invoke('audio:getPath', filename),
    listFiles: (): Promise<string[]> => ipcRenderer.invoke('audio:listFiles'),
  },
});

console.log('[Preload] electronAPI exposed successfully');
