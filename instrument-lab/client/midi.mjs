// Own input handlers for one MIDI access session, including later connections.
export function routeMidiInputs(
  access,
  { getDeviceId, onNoteOn, onNoteOff, onDevices },
) {
  const connected = new Map();
  const release = (record, channel) => {
    for (const [key, note] of record.held) {
      if (channel !== undefined && note.channel !== channel) continue;
      onNoteOff(note.pitch, note.id);
      record.held.delete(key);
    }
  };
  const refresh = () => {
    const inputs = [...access.inputs.values()].filter(
      (input) => input.state !== "disconnected",
    );
    const selection = getDeviceId();
    for (const [id, record] of connected) {
      if (!inputs.includes(record.input)) {
        release(record);
        record.input.onmidimessage = null;
        connected.delete(id);
      } else if (selection && selection !== id) release(record);
    }
    for (const input of inputs) {
      if (connected.has(input.id)) continue;
      const record = { input, held: new Map() };
      connected.set(input.id, record);
      input.onmidimessage = ({ data }) => {
        if (!data || data.length < 3) return;
        const [status, pitch, velocity] = data;
        const command = status & 240,
          channel = status & 15;
        const key = `${channel}:${pitch}`,
          id = `midi:${input.id}:${key}`;
        if (command === 144 && velocity > 0) {
          if (getDeviceId() && getDeviceId() !== input.id) return;
          if (record.held.has(key)) onNoteOff(pitch, id);
          record.held.set(key, { pitch, channel, id });
          onNoteOn(pitch, velocity, id);
        } else if (command === 128 || (command === 144 && velocity === 0)) {
          if (record.held.has(key)) onNoteOff(pitch, id);
          record.held.delete(key);
        } else if (command === 176 && (pitch === 120 || pitch === 123))
          release(record, channel);
      };
    }
    onDevices(inputs);
  };
  access.onstatechange = refresh;
  refresh();
  return {
    refresh,
    dispose() {
      if (access.onstatechange === refresh) access.onstatechange = null;
      for (const record of connected.values()) {
        release(record);
        record.input.onmidimessage = null;
      }
      connected.clear();
    },
  };
}
