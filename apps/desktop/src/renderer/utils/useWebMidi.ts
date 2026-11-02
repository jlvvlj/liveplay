import { useEffect, useRef, useState } from 'react';

export interface WebMidiNote {
  note: number; // 0-127
  velocity: number; // 0-127
}

interface WebMidiState {
  supported: boolean;
  error: string | null;
  deviceNames: string[];
}

/**
 * Subscribes to note-on events from every connected MIDI input using the
 * Web MIDI API (Chrome/Edge). Devices that connect while the app is open
 * are picked up automatically via the statechange event.
 */
export function useWebMidi(onNoteOn: (event: WebMidiNote) => void): WebMidiState {
  const [state, setState] = useState<WebMidiState>({
    supported: typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator,
    error: null,
    deviceNames: [],
  });
  const handlerRef = useRef(onNoteOn);
  handlerRef.current = onNoteOn;

  useEffect(() => {
    if (!('requestMIDIAccess' in navigator)) {
      return;
    }
    let access: MIDIAccess | null = null;
    let disposed = false;

    const handleMessage = (event: Event) => {
      const data = (event as MIDIMessageEvent).data;
      if (!data || data.length < 3) return;
      const status = data[0] & 0xf0;
      const note = data[1];
      const velocity = data[2];
      if (status === 0x90 && velocity > 0) {
        handlerRef.current({ note, velocity });
      }
    };

    const attachInputs = () => {
      if (!access || disposed) return;
      const names: string[] = [];
      access.inputs.forEach((input) => {
        input.onmidimessage = handleMessage;
        names.push(input.name ?? 'Unknown device');
      });
      setState((s) => ({ ...s, deviceNames: names }));
    };

    navigator
      .requestMIDIAccess()
      .then((midiAccess) => {
        if (disposed) return;
        access = midiAccess;
        access.onstatechange = attachInputs;
        attachInputs();
      })
      .catch((err) => {
        if (disposed) return;
        setState((s) => ({ ...s, error: `MIDI access denied: ${err?.message ?? err}` }));
      });

    return () => {
      disposed = true;
      if (access) {
        access.onstatechange = null;
        access.inputs.forEach((input) => {
          input.onmidimessage = null;
        });
      }
    };
  }, []);

  return state;
}
