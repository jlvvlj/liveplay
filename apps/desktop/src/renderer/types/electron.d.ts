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

export interface ElectronAPI {
  midi: {
    list: () => Promise<MidiDevice[]>;
    selectDevice: (deviceId: string) => Promise<void>;
    onEvent: (callback: (event: MidiEvent) => void) => void;
    removeEventListener: () => void;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
