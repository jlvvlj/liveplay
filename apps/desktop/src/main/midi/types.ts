export interface MidiDevice {
  id: string;
  name: string;
  manufacturer?: string;
}

export interface MidiEvent {
  timestamp: number;
  note: number;
  velocity: number;
  type: 'noteon' | 'noteoff';
}

export interface DeviceMapping {
  deviceId: string;
  mappings: {
    [hardwareNote: number]: number; // hardware note -> logical lane
  };
}
