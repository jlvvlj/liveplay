import midi from 'midi';
import { MidiDevice, MidiEvent } from './types';

export class MidiManager {
  private input: midi.Input | null = null;
  private selectedDeviceId: string | null = null;
  private eventCallback: ((event: MidiEvent) => void) | null = null;

  constructor() {
    // Initialize with fallback handling
    try {
      this.input = new midi.Input();
    } catch (error) {
      console.error('Failed to initialize MIDI input:', error);
      this.input = null;
    }
  }

  /**
   * List all available MIDI input devices
   */
  listDevices(): MidiDevice[] {
    if (!this.input) {
      console.warn('MIDI input not available, falling back to WebMIDI');
      return [];
    }

    const devices: MidiDevice[] = [];
    const portCount = this.input.getPortCount();

    for (let i = 0; i < portCount; i++) {
      const name = this.input.getPortName(i);
      devices.push({
        id: `midi-${i}`,
        name: name,
      });
    }

    return devices;
  }

  /**
   * Select a MIDI device by ID
   */
  selectDevice(deviceId: string): boolean {
    if (!this.input) {
      return false;
    }

    // Close existing connection if any
    if (this.selectedDeviceId !== null) {
      try {
        this.input.closePort();
      } catch (error) {
        console.error('Error closing MIDI port:', error);
      }
    }

    // Extract port index from device ID
    const portIndex = parseInt(deviceId.replace('midi-', ''), 10);

    if (isNaN(portIndex) || portIndex < 0 || portIndex >= this.input.getPortCount()) {
      console.error(`Invalid device ID: ${deviceId}`);
      return false;
    }

    try {
      // Open the port
      this.input.openPort(portIndex);
      this.selectedDeviceId = deviceId;

      // Set up message handler
      this.input.on('message', (deltaTime: number, message: number[]) => {
        this.handleMidiMessage(deltaTime, message);
      });

      console.log(`Successfully connected to MIDI device: ${this.input.getPortName(portIndex)}`);
      return true;
    } catch (error) {
      console.error(`Failed to open MIDI port ${portIndex}:`, error);
      this.selectedDeviceId = null;
      return false;
    }
  }

  /**
   * Set the callback for MIDI events
   */
  onEvent(callback: (event: MidiEvent) => void): void {
    this.eventCallback = callback;
  }

  /**
   * Handle raw MIDI messages
   */
  private handleMidiMessage(_deltaTime: number, message: number[]): void {
    if (message.length < 3) {
      return; // Invalid MIDI message
    }

    const status = message[0];
    const note = message[1];
    const velocity = message[2];

    // Parse MIDI message type
    const messageType = status & 0xf0;
    let type: 'noteon' | 'noteoff' | null = null;

    if (messageType === 0x90) {
      // Note On
      // Velocity 0 is treated as Note Off
      type = velocity > 0 ? 'noteon' : 'noteoff';
    } else if (messageType === 0x80) {
      // Note Off
      type = 'noteoff';
    }

    if (type && this.eventCallback) {
      const event: MidiEvent = {
        timestamp: Date.now(),
        note,
        velocity,
        type,
      };

      this.eventCallback(event);
    }
  }

  /**
   * Clean up resources
   */
  destroy(): void {
    if (this.input && this.selectedDeviceId !== null) {
      try {
        this.input.closePort();
      } catch (error) {
        console.error('Error closing MIDI port during cleanup:', error);
      }
    }
    this.selectedDeviceId = null;
    this.eventCallback = null;
  }

  /**
   * Check if a device is currently selected
   */
  isDeviceSelected(): boolean {
    return this.selectedDeviceId !== null;
  }

  /**
   * Get the currently selected device ID
   */
  getSelectedDeviceId(): string | null {
    return this.selectedDeviceId;
  }
}
