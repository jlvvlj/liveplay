import { contextBridge, ipcRenderer } from 'electron';

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

contextBridge.exposeInMainWorld('electronAPI', {
  // MIDI APIs
  midi: {
    list: (): Promise<MidiDevice[]> => ipcRenderer.invoke('midi:list'),
    selectDevice: (deviceId: string): Promise<void> =>
      ipcRenderer.invoke('midi:selectDevice', deviceId),
    onEvent: (callback: (event: MidiEvent) => void) => {
      ipcRenderer.on('midi:event', (_event, data) => callback(data));
    },
    removeEventListener: () => {
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
});
