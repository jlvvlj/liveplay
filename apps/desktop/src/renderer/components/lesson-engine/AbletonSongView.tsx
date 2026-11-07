import { useEffect, useRef, useState } from 'react';
import * as Tone from 'tone';
import type { JamDawSong } from './jamRoomProtocol';
import { jamAbletonAudioUrl, mixJamAbletonAudio } from './jamAbletonImport';
import { BackIcon } from './JamIcons';
import { partColor } from './jamGridTracks';
import './AbletonSongView.css';

// A Daw song imported from an Ableton project: its tracks on a timeline, each
// with its notes, and the whole song played from their recordings (mixed one
// track at a time, as the full app mixes a lesson's backing). Its notes are
// the recordings' own, so they are shown, not edited.

interface AbletonSongViewProps {
  song: JamDawSong;
  // The jam server's address, http(s)://host
  server: string;
  onBack: () => void;
}

export function AbletonSongView({ song, server, onBack }: AbletonSongViewProps) {
  const ableton = song.ableton!;
  const [loading, setLoading] = useState<{ done: number; total: number } | null>({ done: 0, total: ableton.tracks.length });
  const [problem, setProblem] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const player = useRef<Tone.Player | null>(null);
  const startedAt = useRef<number | null>(null);
  const resumeAt = useRef(0);
  const playhead = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    mixJamAbletonAudio(
      ableton.tracks.map((track) => jamAbletonAudioUrl(server, track)),
      ableton.seconds,
      (done, total) => !cancelled && setLoading({ done, total })
    ).then(
      async (mix) => {
        url = mix;
        if (cancelled) return URL.revokeObjectURL(mix);
        const loaded = new Tone.Player({ url: mix, loop: true }).toDestination();
        await Tone.loaded();
        if (cancelled) return loaded.dispose();
        player.current = loaded;
        setLoading(null);
      },
      (error) => !cancelled && setProblem(error instanceof Error ? error.message : String(error))
    );
    return () => {
      cancelled = true;
      player.current?.dispose();
      player.current = null;
      if (url) URL.revokeObjectURL(url);
    };
  }, [ableton, server]);

  // The playhead follows the song while it plays
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      if (startedAt.current !== null && playhead.current) {
        const at = (Tone.now() - startedAt.current) % ableton.seconds;
        playhead.current.style.left = `${(at / ableton.seconds) * 100}%`;
      }
      frame = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(frame);
  }, [playing, ableton.seconds]);

  const toggle = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.currentTarget.blur();
    const loaded = player.current;
    if (!loaded) return;
    await Tone.start();
    if (playing) {
      resumeAt.current = startedAt.current === null ? 0 : (Tone.now() - startedAt.current) % ableton.seconds;
      loaded.stop();
      startedAt.current = null;
      setPlaying(false);
    } else {
      const now = Tone.now() + 0.05;
      loaded.start(now, resumeAt.current);
      startedAt.current = now - resumeAt.current;
      setPlaying(true);
    }
  };

  const totalTicks = ableton.tracks[0]?.lesson.loop?.endTick ?? 1;
  const bars = Math.round(totalTicks / 1920);
  return (
    <div className="ableton-song">
      <div className="ableton-song-head">
        <button className="jam-corner-btn jam-back-btn" onClick={onBack} title="Back">
          <BackIcon />
        </button>
        <button className={`jam-grid-play ${playing ? 'playing' : ''}`} onClick={toggle} disabled={!!loading} aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? '❚❚' : '▶'}
        </button>
        <span className="ableton-song-title">{song.title}</span>
        <span className="toolbar-badge">{Math.round(song.bpm * 10) / 10} BPM</span>
        <span className="ableton-song-detail">
          {ableton.tracks.length} tracks · {bars} bars
        </span>
        {loading && (
          <span className="ableton-song-loading">
            Loading {loading.done + 1} / {loading.total}
          </span>
        )}
        {problem && <span className="jam-lobby-problem">{problem}</span>}
      </div>
      <div className="ableton-song-timeline">
        <div className="ableton-song-ruler">
          <div className="ableton-song-name" />
          <div className="ableton-song-bars">
            {/* Every 8 bars, but none squeezed against the end */}
            {Array.from({ length: Math.floor((bars - 4) / 8) + 1 }, (_, index) => (
              <span key={index} style={{ left: `${((index * 8) / bars) * 100}%` }}>
                {index * 8 + 1}
              </span>
            ))}
          </div>
        </div>
        {ableton.tracks.map((track, index) => {
          const notes = [...new Set(track.lesson.steps.map((step) => step.note))].sort((a, b) => b - a);
          const lanes = Math.max(1, notes.length);
          return (
            <div key={`${index}:${track.name}`} className="ableton-song-row" style={{ '--track-color': partColor(index) } as React.CSSProperties}>
              <div className="ableton-song-name">{track.name}</div>
              <div className="ableton-song-lane">
                <svg viewBox={`0 0 ${totalTicks} ${lanes}`} preserveAspectRatio="none" aria-hidden="true">
                  {track.lesson.steps.map((step, s) => (
                    <rect
                      key={s}
                      x={step.tick}
                      y={notes.indexOf(step.note) + 0.15}
                      width={Math.max(step.dur, totalTicks / 600)}
                      height={0.7}
                    />
                  ))}
                </svg>
              </div>
            </div>
          );
        })}
        <div className="ableton-song-overlay">
          <div ref={playhead} className="ableton-song-playhead" />
        </div>
      </div>
    </div>
  );
}
