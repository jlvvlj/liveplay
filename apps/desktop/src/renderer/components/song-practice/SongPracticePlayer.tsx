import { useCallback, useEffect, useRef, useState } from 'react';
import * as Tone from 'tone';
import { Song, StemName, STEM_NAMES, STEM_LABELS } from '../../types/song';
import { useWebMidi, WebMidiNote } from '../../utils/useWebMidi';
import './SongPracticePlayer.css';

interface SongPracticePlayerProps {
  song: Song;
  onExit: () => void;
}

interface StemStripState {
  volume: number; // 0..100
  muted: boolean;
  soloed: boolean;
}

const DEFAULT_STRIP: StemStripState = { volume: 80, muted: false, soloed: false };

// General MIDI drum notes -> bundled kit samples (audio/drums/)
const DRUM_KIT: Record<number, string> = {
  36: 'kick-1.wav',
  38: 'snare-1.wav',
  39: 'clap-1.wav',
  40: 'snare-2.wav',
  42: 'hihat-closed.wav',
  45: 'tom-low.wav',
  46: 'hihat-open.wav',
  47: 'tom-mid.wav',
  49: 'crash.wav',
  50: 'tom-high.wav',
  51: 'ride.wav',
  56: 'cowbell.wav',
};

function volumeToDb(volume: number): number {
  return volume === 0 ? -Infinity : Tone.gainToDb(volume / 100);
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function SongPracticePlayer({ song, onExit }: SongPracticePlayerProps) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [focusStem, setFocusStem] = useState<StemName | null>(null);
  const [strips, setStrips] = useState<Record<StemName, StemStripState>>({
    drums: { ...DEFAULT_STRIP },
    bass: { ...DEFAULT_STRIP },
    vocals: { ...DEFAULT_STRIP },
    other: { ...DEFAULT_STRIP },
  });

  const channelsRef = useRef<Partial<Record<StemName, Tone.Channel>>>({});
  const playersRef = useRef<Partial<Record<StemName, Tone.Player>>>({});
  const drumKitRef = useRef<Map<number, Tone.Player>>(new Map());
  const synthRef = useRef<Tone.PolySynth | null>(null);
  const isPlayingRef = useRef(false);
  const duration = song.duration ?? 0;

  // --- Audio graph setup -------------------------------------------------
  useEffect(() => {
    if (!song.stems) {
      setLoadError('This song has no stems.');
      setLoading(false);
      return;
    }
    let disposed = false;

    const channels: Partial<Record<StemName, Tone.Channel>> = {};
    const players: Partial<Record<StemName, Tone.Player>> = {};
    for (const stem of STEM_NAMES) {
      const channel = new Tone.Channel({ volume: volumeToDb(DEFAULT_STRIP.volume) }).toDestination();
      const player = new Tone.Player(`/audio/${song.stems[stem]}`).connect(channel);
      channels[stem] = channel;
      players[stem] = player;
    }
    channelsRef.current = channels;
    playersRef.current = players;

    // Local instrument for play-along input
    synthRef.current = new Tone.PolySynth(Tone.Synth, {
      envelope: { attack: 0.02, decay: 0.1, sustain: 0.3, release: 1 },
    }).toDestination();
    synthRef.current.volume.value = -8;

    const kit = drumKitRef.current;
    for (const [note, file] of Object.entries(DRUM_KIT)) {
      kit.set(Number(note), new Tone.Player(`/audio/drums/${file}`).toDestination());
    }

    Tone.loaded()
      .then(() => {
        if (disposed) return;
        for (const stem of STEM_NAMES) {
          players[stem]!.sync().start(0);
        }
        setLoading(false);
      })
      .catch((err) => {
        if (disposed) return;
        setLoadError(`Failed to load stems: ${err?.message ?? err}`);
        setLoading(false);
      });

    return () => {
      disposed = true;
      Tone.Transport.stop();
      Tone.Transport.seconds = 0;
      for (const stem of STEM_NAMES) {
        players[stem]?.unsync();
        players[stem]?.dispose();
        channels[stem]?.dispose();
      }
      kit.forEach((player) => player.dispose());
      kit.clear();
      synthRef.current?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [song.id]);

  // --- Transport position / end-of-song ----------------------------------
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const seconds = Tone.Transport.seconds;
      setPosition(seconds);
      if (duration > 0 && seconds >= duration && isPlayingRef.current) {
        Tone.Transport.pause();
        Tone.Transport.seconds = duration;
        isPlayingRef.current = false;
        setIsPlaying(false);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [duration]);

  // --- Transport controls -------------------------------------------------
  const handlePlayPause = async () => {
    await Tone.start();
    if (isPlayingRef.current) {
      Tone.Transport.pause();
      isPlayingRef.current = false;
      setIsPlaying(false);
    } else {
      if (duration > 0 && Tone.Transport.seconds >= duration) {
        Tone.Transport.seconds = 0;
      }
      Tone.Transport.start();
      isPlayingRef.current = true;
      setIsPlaying(true);
    }
  };

  const handleRestart = async () => {
    await Tone.start();
    Tone.Transport.stop();
    Tone.Transport.seconds = 0;
    Tone.Transport.start();
    isPlayingRef.current = true;
    setIsPlaying(true);
  };

  const handleSeek = (fraction: number) => {
    const target = Math.max(0, Math.min(1, fraction)) * duration;
    // Seeking a running transport with synced players glitches in Tone 14;
    // pause -> set -> resume is reliable.
    const wasPlaying = isPlayingRef.current;
    if (wasPlaying) Tone.Transport.pause();
    Tone.Transport.seconds = target;
    setPosition(target);
    if (wasPlaying) Tone.Transport.start();
  };

  // --- Mixer --------------------------------------------------------------
  const updateStrip = (stem: StemName, update: Partial<StemStripState>) => {
    setStrips((prev) => {
      const next = { ...prev, [stem]: { ...prev[stem], ...update } };
      const channel = channelsRef.current[stem];
      if (channel) {
        if (update.volume !== undefined) channel.volume.value = volumeToDb(update.volume);
        if (update.muted !== undefined) channel.mute = update.muted;
        if (update.soloed !== undefined) channel.solo = update.soloed;
      }
      return next;
    });
  };

  const handleFocusStem = (stem: StemName | null) => {
    setFocusStem(stem);
    // Mute the focus stem so the user can play its part; unmute everything else.
    for (const s of STEM_NAMES) {
      updateStrip(s, { muted: s === stem });
    }
  };

  // --- MIDI play-along ----------------------------------------------------
  const handleNoteOn = useCallback(
    (event: WebMidiNote) => {
      void Tone.start();
      const velocity = event.velocity / 127;
      if (focusStem === 'drums') {
        const player = drumKitRef.current.get(event.note);
        if (player && player.loaded) {
          player.volume.value = Tone.gainToDb(Math.max(velocity, 0.1));
          player.start();
          return;
        }
      }
      synthRef.current?.triggerAttackRelease(
        Tone.Frequency(event.note, 'midi').toFrequency(),
        '8n',
        undefined,
        velocity
      );
    },
    [focusStem]
  );
  const midi = useWebMidi(handleNoteOn);

  // --- Render ---------------------------------------------------------------
  return (
    <div className="song-practice">
      <div className="song-practice-header">
        <button className="song-practice-back" onClick={onExit}>
          ← Back
        </button>
        <div>
          <h2>{song.title}</h2>
          <p className="song-practice-subtitle">
            {focusStem
              ? `Practicing ${STEM_LABELS[focusStem]} — its stem is muted, play it yourself!`
              : 'Pick a stem to practice, or just mix and listen.'}
          </p>
        </div>
      </div>

      {loadError && <div className="song-practice-error">{loadError}</div>}
      {loading && !loadError && <div className="song-practice-loading">Loading stems…</div>}

      {!loading && !loadError && (
        <>
          <div className="focus-selector">
            <span className="focus-label">Practice:</span>
            {STEM_NAMES.map((stem) => (
              <button
                key={stem}
                className={`focus-button ${focusStem === stem ? 'active' : ''}`}
                onClick={() => handleFocusStem(focusStem === stem ? null : stem)}
              >
                {STEM_LABELS[stem]}
              </button>
            ))}
          </div>

          <div className="stem-mixer">
            {STEM_NAMES.map((stem) => {
              const strip = strips[stem];
              return (
                <div
                  key={stem}
                  className={`stem-strip ${focusStem === stem ? 'focused' : ''} ${strip.muted ? 'muted' : ''}`}
                >
                  <div className="stem-strip-name">{STEM_LABELS[stem]}</div>
                  <input
                    className="stem-volume"
                    type="range"
                    min={0}
                    max={100}
                    value={strip.volume}
                    onChange={(e) => updateStrip(stem, { volume: Number(e.target.value) })}
                  />
                  <div className="stem-strip-buttons">
                    <button
                      className={`stem-button ${strip.muted ? 'active-mute' : ''}`}
                      onClick={() => updateStrip(stem, { muted: !strip.muted })}
                      title="Mute"
                    >
                      M
                    </button>
                    <button
                      className={`stem-button ${strip.soloed ? 'active-solo' : ''}`}
                      onClick={() => updateStrip(stem, { soloed: !strip.soloed })}
                      title="Solo"
                    >
                      S
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="transport-bar">
            <button className="transport-button" onClick={handleRestart} title="Restart">
              ⏮
            </button>
            <button className="transport-button transport-play" onClick={handlePlayPause}>
              {isPlaying ? '⏸' : '▶'}
            </button>
            <span className="transport-time">{formatTime(position)}</span>
            <div
              className="transport-seek"
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                handleSeek((e.clientX - rect.left) / rect.width);
              }}
            >
              <div
                className="transport-seek-fill"
                style={{ width: duration > 0 ? `${(position / duration) * 100}%` : '0%' }}
              />
            </div>
            <span className="transport-time">{formatTime(duration)}</span>
          </div>

          <div className="midi-status">
            {!midi.supported && 'Web MIDI not supported in this browser (use Chrome/Edge) — no MIDI input.'}
            {midi.supported && midi.error && midi.error}
            {midi.supported && !midi.error && midi.deviceNames.length === 0 && 'No MIDI device detected — connect one to play along.'}
            {midi.supported && !midi.error && midi.deviceNames.length > 0 && `MIDI: ${midi.deviceNames.join(', ')}`}
          </div>
        </>
      )}
    </div>
  );
}
