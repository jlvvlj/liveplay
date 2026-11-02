import { useState, useEffect } from 'react';
import { MidiDevice, MidiEvent } from '../../types/electron';
import { DeviceMapper } from './DeviceMapper';
import './MidiDeviceSelector.css';

export function MidiDeviceSelector() {
  const [devices, setDevices] = useState<MidiDevice[]>([]);
  const [selectedDevice, setSelectedDevice] = useState<string | null>(null);
  const [selectedDeviceName, setSelectedDeviceName] = useState<string>('');
  const [midiEvents, setMidiEvents] = useState<MidiEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [showMapper, setShowMapper] = useState<boolean>(false);
  const [instrumentType, setInstrumentType] = useState<'pads' | 'keys' | 'drums'>('pads');

  useEffect(() => {
    loadDevices();
  }, []);

  useEffect(() => {
    // Set up MIDI event listener
    if (window.electronAPI) {
      window.electronAPI.midi.onEvent((event: MidiEvent) => {
        setMidiEvents((prev) => [...prev.slice(-19), event]); // Keep last 20 events
      });
    }

    return () => {
      if (window.electronAPI) {
        window.electronAPI.midi.removeEventListener();
      }
    };
  }, []);

  const loadDevices = async () => {
    try {
      console.log('[MidiDeviceSelector] Loading devices...');
      console.log('[MidiDeviceSelector] window.electronAPI exists:', !!window.electronAPI);

      if (!window.electronAPI) {
        console.error('[MidiDeviceSelector] Electron API not available');
        setError('Electron API not available');
        return;
      }

      console.log('[MidiDeviceSelector] Calling window.electronAPI.midi.list()...');
      const deviceList = await window.electronAPI.midi.list();
      console.log('[MidiDeviceSelector] Received device list:', deviceList);

      setDevices(deviceList);
      setError(null);
    } catch (err) {
      console.error('[MidiDeviceSelector] Error loading devices:', err);
      setError(`Failed to load devices: ${err}`);
    }
  };

  const handleSelectDevice = async (deviceId: string, deviceName: string) => {
    try {
      if (!window.electronAPI) {
        setError('Electron API not available');
        return;
      }
      await window.electronAPI.midi.selectDevice(deviceId);
      setSelectedDevice(deviceId);
      setSelectedDeviceName(deviceName);
      setMidiEvents([]);
      setError(null);
      setShowMapper(false);
    } catch (err) {
      setError(`Failed to select device: ${err}`);
    }
  };

  const handleConfigureMapping = () => {
    setShowMapper(true);
  };

  return (
    <div className="midi-device-selector">
      <h2>MIDI Device Setup</h2>

      {error && <div className="error-message">{error}</div>}

      <div className="device-list">
        <h3>Available Devices</h3>
        {devices.length === 0 ? (
          <p className="no-devices">
            No MIDI devices found. Please connect a MIDI device and click Refresh.
          </p>
        ) : (
          <ul>
            {devices.map((device) => (
              <li
                key={device.id}
                className={selectedDevice === device.id ? 'selected' : ''}
              >
                <button onClick={() => handleSelectDevice(device.id, device.name)}>
                  {device.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <button className="refresh-button" onClick={loadDevices}>
          Refresh Devices
        </button>
      </div>

      {selectedDevice && !showMapper && (
        <div className="midi-monitor">
          <h3>MIDI Events (Live)</h3>
          <div className="event-list">
            {midiEvents.length === 0 ? (
              <p className="no-events">
                Play your MIDI device to see events here...
              </p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Type</th>
                    <th>Note</th>
                    <th>Velocity</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {midiEvents.map((event, idx) => (
                    <tr key={idx} className={event.type === 'noteon' ? 'note-on' : 'note-off'}>
                      <td>{event.type}</td>
                      <td>{event.note}</td>
                      <td>{event.velocity}</td>
                      <td>{new Date(event.timestamp).toLocaleTimeString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="mapping-section">
            <h3>Configure Device Mapping</h3>
            <p>Select your instrument type and configure note mapping:</p>
            <div className="instrument-selector">
              <button
                className={`instrument-btn ${instrumentType === 'pads' ? 'active' : ''}`}
                onClick={() => setInstrumentType('pads')}
              >
                Pads (4)
              </button>
              <button
                className={`instrument-btn ${instrumentType === 'keys' ? 'active' : ''}`}
                onClick={() => setInstrumentType('keys')}
              >
                Keys (8)
              </button>
              <button
                className={`instrument-btn ${instrumentType === 'drums' ? 'active' : ''}`}
                onClick={() => setInstrumentType('drums')}
              >
                Drums (5)
              </button>
            </div>
            <button className="btn-configure" onClick={handleConfigureMapping}>
              Configure Mapping →
            </button>
          </div>
        </div>
      )}

      {selectedDevice && showMapper && (
        <div>
          <button className="btn-back-mapper" onClick={() => setShowMapper(false)}>
            ← Back to Device Monitor
          </button>
          <DeviceMapper
            deviceId={selectedDevice}
            deviceName={selectedDeviceName}
            instrument={instrumentType}
            onMappingSaved={() => {
              console.log('Mapping saved successfully');
            }}
          />
        </div>
      )}
    </div>
  );
}
