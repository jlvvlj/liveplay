import { SourceStemPanel } from "./SourceStemPanel";
import { LessonPlayer } from '../lesson-engine/LessonPlayer';
import { Lesson } from '../../types/lesson';
import { useEffect, useState } from "react";
import { Song } from "../../types/song";
import InstrumentLabEditor from "../../../../../../instrument-lab/client/InstrumentLabEditor.jsx";
import { configureLabPaths } from "../../../../../../instrument-lab/client/paths.mjs";
import "./InstrumentLab.css";

configureLabPaths(true);

export function InstrumentLab({
  song,
  onExit,
}: {
  song: Song | null;
  onExit: () => void;
}) {
  const [audioLesson, setAudioLesson] = useState<Lesson | null>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let disposed = false;
    setReady(false);
    setProjectId(null);
    setError("");
    if (!song) {
      setReady(true);
      return;
    }
    fetch(`/api/songs/${encodeURIComponent(song.id)}/instrument-lab`, {
      method: "POST",
    })
      .then(async (response) => {
        const project = await response.json();
        if (!response.ok)
          throw new Error(project.error || "Could not open Instrument Lab.");
        if (!disposed) {
          setProjectId(project.id);
          setReady(true);
        }
      })
      .catch((reason) => {
        if (!disposed) setError(reason.message);
      });
    return () => {
      disposed = true;
    };
  }, [song?.id, attempt]);

  if (ready)
    return (
      <>
      {audioLesson && <LessonPlayer lesson={audioLesson} onComplete={() => setAudioLesson(null)} />}
      <div hidden={!!audioLesson}>
      <InstrumentLabEditor
        key={projectId || "library"}
        initialProjectId={projectId}
        embedded
        onExit={onExit}
        onStartLesson={setAudioLesson}
        renderSourceEditor={({project,projects,onAudition}) => <SourceStemPanel project={project} projects={projects} onAudition={onAudition} onExit={onExit} onStartLesson={setAudioLesson}/>}
      />
      </div>
      </>
    );
  return (
    <section className="instrument-lab-opening">
      <header>
        <button onClick={onExit} aria-label="Back to Melodics">
          ←
        </button>
        <strong>{song?.title || "Instrument Lab"}</strong>
        <span>Instrument Lab editor</span>
      </header>
      {error ? (
        <div role="alert">
          <p>{error}</p>
          <button onClick={() => setAttempt((n) => n + 1)}>
            Retry opening editor
          </button>
        </div>
      ) : (
        <p role="status">Opening Instrument Lab for this recording…</p>
      )}
    </section>
  );
}
