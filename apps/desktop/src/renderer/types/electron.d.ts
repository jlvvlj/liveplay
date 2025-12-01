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

export interface ElectronAPI {
  midi: {
    list: () => Promise<MidiDevice[]>;
    selectDevice: (deviceId: string) => Promise<void>;
    onEvent: (callback: (event: MidiEvent) => void) => void;
    removeEventListener: () => void;
  };
  mapping: {
    get: (deviceId: string) => Promise<DeviceMapping | null>;
    save: (mapping: DeviceMapping) => Promise<void>;
    getAll: () => Promise<DeviceMapping[]>;
    delete: (deviceId: string) => Promise<void>;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
