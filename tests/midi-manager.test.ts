import { MidiManager } from '../apps/desktop/src/main/midi/manager';
import { MidiEvent } from '../apps/desktop/src/main/midi/types';

// Mock the midi module
jest.mock('midi', () => {
  return {
    Input: jest.fn().mockImplementation(() => ({
      getPortCount: jest.fn().mockReturnValue(2),
      getPortName: jest.fn((port: number) => `MIDI Device ${port}`),
      openPort: jest.fn(),
      closePort: jest.fn(),
      on: jest.fn(),
    })),
  };
});

describe('MidiManager', () => {
  let midiManager: MidiManager;

  beforeEach(() => {
    midiManager = new MidiManager();
  });

  afterEach(() => {
    midiManager.destroy();
  });

  describe('listDevices', () => {
    it('should list available MIDI devices', () => {
      const devices = midiManager.listDevices();

      expect(devices).toHaveLength(2);
      expect(devices[0]).toEqual({
        id: 'midi-0',
        name: 'MIDI Device 0',
      });
      expect(devices[1]).toEqual({
        id: 'midi-1',
        name: 'MIDI Device 1',
      });
    });
  });

  describe('selectDevice', () => {
    it('should successfully select a valid device', () => {
      const success = midiManager.selectDevice('midi-0');
      expect(success).toBe(true);
    });

    it('should fail to select an invalid device', () => {
      const success = midiManager.selectDevice('midi-999');
      expect(success).toBe(false);
    });

    it('should update selected device state', () => {
      midiManager.selectDevice('midi-0');
      expect(midiManager.isDeviceSelected()).toBe(true);
      expect(midiManager.getSelectedDeviceId()).toBe('midi-0');
    });
  });

  describe('MIDI event handling', () => {
    it('should trigger callback on MIDI events', (done) => {
      const mockCallback = jest.fn((event: MidiEvent) => {
        expect(event.type).toBe('noteon');
        expect(event.note).toBe(60);
        expect(event.velocity).toBe(100);
        done();
      });

      midiManager.onEvent(mockCallback);

      // Simulate a Note On event
      // In real scenario, this would come from the MIDI device
      // For testing, we directly call the private handler through the public callback
      const privateHandler = (midiManager as any).handleMidiMessage.bind(midiManager);
      privateHandler(0, [0x90, 60, 100]); // Note On, Middle C, velocity 100
    });

    it('should parse Note Off messages correctly', (done) => {
      const mockCallback = jest.fn((event: MidiEvent) => {
        expect(event.type).toBe('noteoff');
        expect(event.note).toBe(60);
        done();
      });

      midiManager.onEvent(mockCallback);

      const privateHandler = (midiManager as any).handleMidiMessage.bind(midiManager);
      privateHandler(0, [0x80, 60, 0]); // Note Off
    });

    it('should treat velocity 0 Note On as Note Off', (done) => {
      const mockCallback = jest.fn((event: MidiEvent) => {
        expect(event.type).toBe('noteoff');
        done();
      });

      midiManager.onEvent(mockCallback);

      const privateHandler = (midiManager as any).handleMidiMessage.bind(midiManager);
      privateHandler(0, [0x90, 60, 0]); // Note On with velocity 0
    });
  });

  describe('cleanup', () => {
    it('should properly clean up resources on destroy', () => {
      midiManager.selectDevice('midi-0');
      midiManager.destroy();

      expect(midiManager.isDeviceSelected()).toBe(false);
      expect(midiManager.getSelectedDeviceId()).toBeNull();
    });
  });
});
