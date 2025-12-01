import { useState, useEffect } from 'react';
import { Lesson } from '../../types/lesson';
import './LessonSelector.css';

interface LessonSelectorProps {
  onLessonSelect: (lesson: Lesson) => void;
}

// For MVP, we'll import the sample lessons directly
// In production, these would be loaded from files or a server
const SAMPLE_LESSONS: Lesson[] = [
  {
    id: 'basic-pad-01',
    title: 'Basic 4/4 Pad Groove',
    instrument: 'pads',
    bpm: 100,
    timeSignature: {
      numerator: 4,
      denominator: 4,
    },
    steps: [
      { tick: 0, note: 36, dur: 120, velocity: 100, lane: 0 },
      { tick: 480, note: 38, dur: 120, velocity: 100, lane: 1 },
      { tick: 960, note: 40, dur: 120, velocity: 100, lane: 2 },
      { tick: 1440, note: 41, dur: 120, velocity: 100, lane: 3 },
      { tick: 1920, note: 36, dur: 120, velocity: 100, lane: 0 },
      { tick: 2400, note: 38, dur: 120, velocity: 100, lane: 1 },
      { tick: 2880, note: 40, dur: 120, velocity: 90, lane: 2 },
      { tick: 3360, note: 41, dur: 120, velocity: 90, lane: 3 },
    ],
    loop: {
      startTick: 0,
      endTick: 3840,
    },
    metadata: {
      difficulty: 1,
      genre: 'Practice',
      tags: ['beginner', 'pads', '4/4'],
      description: 'Learn the basic four-pad pattern in 4/4 time',
    },
  },
  {
    id: 'basic-keys-01',
    title: 'C Major Scale Practice',
    instrument: 'keys',
    bpm: 80,
    timeSignature: {
      numerator: 4,
      denominator: 4,
    },
    steps: [
      { tick: 0, note: 60, dur: 480, velocity: 100 },
      { tick: 480, note: 62, dur: 480, velocity: 100 },
      { tick: 960, note: 64, dur: 480, velocity: 100 },
      { tick: 1440, note: 65, dur: 480, velocity: 100 },
      { tick: 1920, note: 67, dur: 480, velocity: 100 },
      { tick: 2400, note: 69, dur: 480, velocity: 100 },
      { tick: 2880, note: 71, dur: 480, velocity: 100 },
      { tick: 3360, note: 72, dur: 480, velocity: 100 },
    ],
    loop: {
      startTick: 0,
      endTick: 3840,
    },
    metadata: {
      difficulty: 1,
      genre: 'Practice',
      tags: ['beginner', 'keys', 'scales', 'C major'],
      description: 'Practice the C major scale from middle C to high C',
    },
  },
];

export function LessonSelector({ onLessonSelect }: LessonSelectorProps) {
  const [lessons] = useState<Lesson[]>(SAMPLE_LESSONS);
  const [selectedLesson, setSelectedLesson] = useState<Lesson | null>(null);

  const handleSelectLesson = (lesson: Lesson) => {
    setSelectedLesson(lesson);
    onLessonSelect(lesson);
  };

  const getDifficultyStars = (difficulty: number): string => {
    return '★'.repeat(difficulty) + '☆'.repeat(Math.max(0, 5 - difficulty));
  };

  return (
    <div className="lesson-selector">
      <h2>Choose a Lesson</h2>
      <div className="lesson-grid">
        {lessons.map((lesson) => (
          <div
            key={lesson.id}
            className={`lesson-card ${selectedLesson?.id === lesson.id ? 'selected' : ''}`}
            onClick={() => handleSelectLesson(lesson)}
          >
            <div className="lesson-card-header">
              <h3>{lesson.title}</h3>
              <span className={`instrument-tag ${lesson.instrument}`}>
                {lesson.instrument}
              </span>
            </div>
            <div className="lesson-card-body">
              <p className="lesson-description">{lesson.metadata?.description}</p>
              <div className="lesson-stats">
                <div className="stat">
                  <span className="stat-icon">♪</span>
                  <span>{lesson.bpm} BPM</span>
                </div>
                <div className="stat">
                  <span className="stat-icon">📊</span>
                  <span>{lesson.steps.length} Steps</span>
                </div>
                {lesson.metadata?.difficulty && (
                  <div className="stat">
                    <span className="difficulty-stars">
                      {getDifficultyStars(lesson.metadata.difficulty)}
                    </span>
                  </div>
                )}
              </div>
              {lesson.metadata?.tags && (
                <div className="lesson-tags">
                  {lesson.metadata.tags.map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
