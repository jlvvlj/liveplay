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
});
