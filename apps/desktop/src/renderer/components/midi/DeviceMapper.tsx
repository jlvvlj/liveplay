import { useState, useEffect } from 'react';
import { DeviceMapping, MidiEvent } from '../../types/electron';
import './DeviceMapper.css';

interface DeviceMapperProps {
  deviceId: string;
  deviceName: string;
  instrument: 'pads' | 'keys' | 'drums';
  onMappingSaved?: () => void;
}

// Default lesson notes for each instrument type
const LESSON_NOTES = {
  pads: [36, 38, 40, 41], // P1, P2, P3, P4
  keys: [60, 62, 64, 65, 67, 69, 71, 72], // C, D, E, F, G, A, B, C (C major scale)
  drums: [36, 38, 42, 49, 51], // Kick, Snare, HH, Crash, Ride
};

export function DeviceMapper({ deviceId, deviceName, instrument, onMappingSaved }: DeviceMapperProps) {
  const [mapping, setMapping] = useState<DeviceMapping>({
    deviceId,
    name: deviceName,
    mappings: {},
  });
  const [learningIndex, setLearningIndex] = useState<number | null>(null);
  const [lastMidiNote, setLastMidiNote] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lessonNotes = LESSON_NOTES[instrument];

  useEffect(() => {
    // Load existing mapping
    loadMapping();
  }, [deviceId]);

  useEffect(() => {
    // Listen for MIDI events during learning mode
    if (learningIndex !== null && window.electronAPI) {
      const handleMidiEvent = (event: MidiEvent) => {
        if (event.type === 'noteon' && event.velocity > 0) {
          setLastMidiNote(event.note);
          // Auto-assign the note
          assignNote(learningIndex, event.note);
          // Move to next pad
          if (learningIndex < lessonNotes.length - 1) {
            setLearningIndex(learningIndex + 1);
          } else {
            setLearningIndex(null);
          }
        }
      };

      window.electronAPI.midi.onEvent(handleMidiEvent);

      return () => {
        window.electronAPI.midi.removeEventListener();
      };
    }
  }, [learningIndex]);

  const loadMapping = async () => {
    try {
      if (!window.electronAPI) return;
      const existingMapping = await window.electronAPI.mapping.get(deviceId);
      if (existingMapping) {
        setMapping(existingMapping);
      }
    } catch (err) {
      console.error('Failed to load mapping:', err);
      setError(`Failed to load mapping: ${err}`);
    }
  };

  const assignNote = (lessonNoteIndex: number, hardwareNote: number) => {
    const lessonNote = lessonNotes[lessonNoteIndex];
    setMapping((prev) => ({
      ...prev,
      mappings: {
        ...prev.mappings,
        [hardwareNote]: lessonNote,
      },
    }));
  };

  const removeMapping = (hardwareNote: number) => {
    setMapping((prev) => {
      const newMappings = { ...prev.mappings };
      delete newMappings[hardwareNote];
      return {
        ...prev,
        mappings: newMappings,
      };
    });
  };

  const handleSave = async () => {
    try {
      if (!window.electronAPI) {
        setError('Electron API not available');
        return;
      }
      await window.electronAPI.mapping.save(mapping);
      setError(null);
      if (onMappingSaved) {
        onMappingSaved();
      }
    } catch (err) {
      console.error('Failed to save mapping:', err);
      setError(`Failed to save mapping: ${err}`);
    }
  };

  const startLearning = () => {
    setLearningIndex(0);
  };

  const stopLearning = () => {
    setLearningIndex(null);
  };

  const getLessonNoteName = (lessonNote: number): string => {
    if (instrument === 'pads') {
      const index = lessonNotes.indexOf(lessonNote);
      return `P${index + 1}`;
    } else if (instrument === 'drums') {
      const names = ['Kick', 'Snare', 'HH', 'Crash', 'Ride'];
      const index = lessonNotes.indexOf(lessonNote);
      return names[index] || `Drum ${lessonNote}`;
    } else {
      const noteNames = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
      const noteName = noteNames[lessonNote % 12];
      const octave = Math.floor(lessonNote / 12) - 1;
      return `${noteName}${octave}`;
    }
  };

  // Get reverse mapping (lesson note -> hardware note)
  const reverseMapping: { [lessonNote: number]: number } = {};
  for (const [hw, lesson] of Object.entries(mapping.mappings)) {
    reverseMapping[lesson] = parseInt(hw);
  }

  return (
    <div className="device-mapper">
      <h3>Device Mapping: {deviceName}</h3>
      <p className="mapper-description">
        Map your hardware pads/keys to lesson notes. Click "Learn Mapping" and hit each pad in order.
      </p>

      {error && <div className="error-message">{error}</div>}

      {learningIndex !== null && (
        <div className="learning-banner">
          <div className="learning-indicator">
            <span className="learning-pulse"></span>
            Listening for: <strong>{getLessonNoteName(lessonNotes[learningIndex])}</strong>
          </div>
          <div className="learning-progress">
            {learningIndex + 1} of {lessonNotes.length}
          </div>
          <button className="btn-warning" onClick={stopLearning}>
            Cancel
          </button>
        </div>
      )}

      <div className="mapper-controls">
        {learningIndex === null ? (
          <button className="btn-primary" onClick={startLearning}>
            Learn Mapping
          </button>
        ) : null}
        <button className="btn-success" onClick={handleSave}>
          Save Mapping
        </button>
      </div>

      <div className="mapping-grid">
        <div className="mapping-header">
          <div>Lesson Note</div>
          <div>Hardware Note</div>
          <div>Status</div>
          <div>Action</div>
        </div>

        {lessonNotes.map((lessonNote) => {
          const hardwareNote = reverseMapping[lessonNote];
          const isMapped = hardwareNote !== undefined;
          const isLearning = learningIndex !== null && lessonNotes[learningIndex] === lessonNote;

          return (
            <div
              key={lessonNote}
              className={`mapping-row ${isMapped ? 'mapped' : 'unmapped'} ${isLearning ? 'learning' : ''}`}
            >
              <div className="lesson-note">
                <span className="note-label">{getLessonNoteName(lessonNote)}</span>
                <span className="note-number">MIDI {lessonNote}</span>
              </div>
              <div className="hardware-note">
                {isMapped ? (
                  <>
                    <span className="note-number">MIDI {hardwareNote}</span>
                  </>
                ) : (
                  <span className="unmapped-text">Not mapped</span>
                )}
              </div>
              <div className="status">
                {isLearning ? (
                  <span className="status-learning">Listening...</span>
                ) : isMapped ? (
                  <span className="status-mapped">✓ Mapped</span>
                ) : (
                  <span className="status-unmapped">○ Unmapped</span>
                )}
              </div>
              <div className="action">
                {isMapped && (
                  <button className="btn-small btn-danger" onClick={() => removeMapping(hardwareNote)}>
                    Remove
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {lastMidiNote !== null && (
        <div className="last-midi-note">
          Last MIDI note received: <strong>{lastMidiNote}</strong>
        </div>
      )}
    </div>
  );
}
