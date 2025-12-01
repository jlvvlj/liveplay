import { useState, useEffect, useRef } from 'react';
import { LessonEngine, LessonEngineState } from './LessonEngine';
import { Lesson, HitFeedback, LessonScore, PracticeModeSettings } from '../../types/lesson';
import { MidiEvent } from '../../types/electron';
import { NoteHighway } from './NoteHighway';
import './LessonPlayer.css';

interface LessonPlayerProps {
  lesson: Lesson;
  onComplete?: () => void;
}

export function LessonPlayer({ lesson, onComplete }: LessonPlayerProps) {
  const engineRef = useRef<LessonEngine | null>(null);
  const [state, setState] = useState<LessonEngineState>('stopped');
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [showCompletion, setShowCompletion] = useState<boolean>(false);
  const [finalScore, setFinalScore] = useState<LessonScore | null>(null);
  const [score, setScore] = useState<LessonScore>({
    totalSteps: 0,
    hits: 0,
    misses: 0,
    perfectHits: 0,
    goodHits: 0,
    accuracy: 0,
    totalPoints: 0,
    maxPoints: 0,
  });
  const [recentFeedback, setRecentFeedback] = useState<HitFeedback[]>([]);
  const [practiceMode, setPracticeMode] = useState<PracticeModeSettings>({
    loopEnabled: true,
    speedMultiplier: 1.0,
    autoBpmEnabled: false,
    autoBpmStartSpeed: 0.5,
    autoBpmIncrementSteps: 0.1,
    waitModeEnabled: false,
  });

  useEffect(() => {
    // Initialize engine
    const engine = new LessonEngine({
      onHitFeedback: (feedback) => {
        setRecentFeedback((prev) => [...prev.slice(-9), feedback]);
      },
      onScoreUpdate: (newScore) => {
        setScore(newScore);
      },
      onStateChange: (newState) => {
        setState(newState);
      },
      onLoop: () => {
        console.log('Loop restarted');
      },
      onComplete: (finalScore) => {
        setFinalScore(finalScore);
        setShowCompletion(true);
      },
    });

    engine.loadLesson(lesson);
    engine.setPracticeMode(practiceMode);
    engineRef.current = engine;

    // Set up MIDI event listener
    if (window.electronAPI) {
      window.electronAPI.midi.onEvent((event: MidiEvent) => {
        if (event.type === 'noteon' && engine) {
          engine.processNote(event.note, event.timestamp / 1000);
        }
      });
    }

    return () => {
      if (engineRef.current) {
        engineRef.current.stop();
      }
      if (window.electronAPI) {
        window.electronAPI.midi.removeEventListener();
      }
    };
  }, [lesson]);

  useEffect(() => {
    if (engineRef.current) {
      engineRef.current.setPracticeMode(practiceMode);
    }
  }, [practiceMode]);

  // Update current time during playback
  useEffect(() => {
    if (state === 'playing') {
      const startTime = Date.now();
      const interval = setInterval(() => {
        setCurrentTime((Date.now() - startTime) * practiceMode.speedMultiplier);
      }, 16); // ~60fps

      return () => clearInterval(interval);
    } else if (state === 'stopped') {
      setCurrentTime(0);
    }
  }, [state, practiceMode.speedMultiplier]);

  const handleStart = async () => {
    // Start countdown before lesson begins
    setCountdown(3);

    const countdownInterval = setInterval(() => {
      setCountdown((prev) => {
        if (prev === null) return null;
        if (prev <= 1) {
          clearInterval(countdownInterval);
          // Start the lesson after countdown
          if (engineRef.current) {
            engineRef.current.start();
          }
          return null;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handlePause = () => {
    if (engineRef.current) {
      engineRef.current.pause();
    }
  };

  const handleResume = () => {
    if (engineRef.current) {
      engineRef.current.resume();
    }
  };

  const handleStop = () => {
    if (engineRef.current) {
      engineRef.current.stop();
    }
  };

  const handleSpeedChange = (speed: number) => {
    setPracticeMode((prev) => ({ ...prev, speedMultiplier: speed }));
  };

  const handleLoopToggle = () => {
    setPracticeMode((prev) => ({ ...prev, loopEnabled: !prev.loopEnabled }));
  };

  const handleWaitModeToggle = () => {
    setPracticeMode((prev) => ({ ...prev, waitModeEnabled: !prev.waitModeEnabled }));
  };

  const handleAutoBpmToggle = () => {
    setPracticeMode((prev) => ({ ...prev, autoBpmEnabled: !prev.autoBpmEnabled }));
  };

  const handleReplay = () => {
    setShowCompletion(false);
    setFinalScore(null);
    setRecentFeedback([]);
    setScore({
      totalSteps: 0,
      hits: 0,
      misses: 0,
      perfectHits: 0,
      goodHits: 0,
      accuracy: 0,
      totalPoints: 0,
      maxPoints: 0,
    });
    // Reinitialize the engine
    if (engineRef.current) {
      engineRef.current.loadLesson(lesson);
    }
  };

  const handleContinue = () => {
    if (onComplete) {
      onComplete();
    }
  };

  const getAccuracyColor = (accuracy: number): string => {
    if (accuracy >= 90) return '#4ade80'; // green
    if (accuracy >= 75) return '#facc15'; // yellow
    if (accuracy >= 60) return '#fb923c'; // orange
    return '#f87171'; // red
  };

  const getFeedbackColor = (feedback: HitFeedback): string => {
    switch (feedback.accuracy) {
      case 'perfect':
        return '#4ade80';
      case 'good':
        return '#facc15';
      case 'early':
      case 'late':
        return '#fb923c';
      case 'miss':
        return '#f87171';
      default:
        return '#ffffff';
    }
  };

  return (
    <div className="lesson-player">
      {/* Countdown Overlay */}
      {countdown !== null && (
        <div className="countdown-overlay">
          <div className="countdown-number">
            {countdown === 0 ? 'GO!' : countdown}
          </div>
        </div>
      )}

      {/* Completion Screen */}
      {showCompletion && finalScore && (
        <div className="completion-overlay">
          <div className="completion-screen">
            <h2 className="completion-title">Lesson Complete!</h2>

            <div className="completion-score">
              <div
                className="completion-accuracy-circle"
                style={{ borderColor: getAccuracyColor(finalScore.accuracy) }}
              >
                <span className="completion-accuracy-value">{finalScore.accuracy.toFixed(1)}%</span>
                <span className="completion-accuracy-label">Accuracy</span>
              </div>
            </div>

            <div className="completion-stats">
              <div className="completion-stat">
                <span className="completion-stat-value">{finalScore.totalPoints}</span>
                <span className="completion-stat-label">Total Points</span>
              </div>
              <div className="completion-stat">
                <span className="completion-stat-value">{finalScore.perfectHits}</span>
                <span className="completion-stat-label">Perfect Hits</span>
              </div>
              <div className="completion-stat">
                <span className="completion-stat-value">{finalScore.goodHits}</span>
                <span className="completion-stat-label">Good Hits</span>
              </div>
              <div className="completion-stat">
                <span className="completion-stat-value">{finalScore.misses}</span>
                <span className="completion-stat-label">Misses</span>
              </div>
            </div>

            <div className="completion-actions">
              <button className="btn-primary" onClick={handleReplay}>
                Replay Lesson
              </button>
              <button className="btn-primary" onClick={handleContinue}>
                Continue
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="lesson-header">
        <h2>{lesson.title}</h2>
        <div className="lesson-meta">
          <span className="instrument-badge">{lesson.instrument}</span>
          <span className="bpm-badge">{lesson.bpm} BPM</span>
          {lesson.metadata?.difficulty && (
            <span className="difficulty-badge">Level {lesson.metadata.difficulty}</span>
          )}
        </div>
      </div>

      {/* Note Highway Visualization */}
      <div className="highway-container">
        <NoteHighway
          instrument={lesson.instrument}
          steps={lesson.steps}
          currentTime={currentTime}
          bpm={lesson.bpm * practiceMode.speedMultiplier}
        />
      </div>

      <div className="player-layout">
        {/* Left: Controls and Practice Mode */}
        <div className="controls-section">
          <div className="playback-controls">
            <h3>Playback</h3>
            <div className="control-buttons">
              {state === 'stopped' && (
                <button className="btn-primary" onClick={handleStart}>
                  Start
                </button>
              )}
              {state === 'playing' && (
                <button className="btn-warning" onClick={handlePause}>
                  Pause
                </button>
              )}
              {state === 'paused' && (
                <button className="btn-primary" onClick={handleResume}>
                  Resume
                </button>
              )}
              {state !== 'stopped' && (
                <button className="btn-danger" onClick={handleStop}>
                  Stop
                </button>
              )}
            </div>
            <div className="state-indicator">
              State: <span className={`state-${state}`}>{state}</span>
            </div>
          </div>

          <div className="practice-mode-controls">
            <h3>Practice Mode</h3>

            <div className="control-group">
              <label>
                <input
                  type="checkbox"
                  checked={practiceMode.loopEnabled}
                  onChange={handleLoopToggle}
                />
                Loop Enabled
              </label>
            </div>

            <div className="control-group">
              <label>
                Speed: {(practiceMode.speedMultiplier * 100).toFixed(0)}%
              </label>
              <input
                type="range"
                min="0.5"
                max="2.0"
                step="0.1"
                value={practiceMode.speedMultiplier}
                onChange={(e) => handleSpeedChange(parseFloat(e.target.value))}
                className="speed-slider"
              />
              <div className="speed-labels">
                <span>50%</span>
                <span>100%</span>
                <span>200%</span>
              </div>
            </div>

            <div className="control-group">
              <label>
                <input
                  type="checkbox"
                  checked={practiceMode.autoBpmEnabled}
                  onChange={handleAutoBpmToggle}
                />
                Auto-BPM (Progressive Speed)
              </label>
            </div>

            <div className="control-group">
              <label>
                <input
                  type="checkbox"
                  checked={practiceMode.waitModeEnabled}
                  onChange={handleWaitModeToggle}
                />
                Wait Mode (Pause Until Correct)
              </label>
            </div>
          </div>
        </div>

        {/* Right: Score and Feedback */}
        <div className="feedback-section">
          <div className="score-display">
            <h3>Score</h3>
            <div className="score-stats">
              <div className="stat-large">
                <div
                  className="accuracy-circle"
                  style={{ borderColor: getAccuracyColor(score.accuracy) }}
                >
                  <span className="accuracy-value">{score.accuracy.toFixed(1)}%</span>
                  <span className="accuracy-label">Accuracy</span>
                </div>
              </div>
              <div className="stat-grid">
                <div className="stat">
                  <span className="stat-value">{score.totalPoints}</span>
                  <span className="stat-label">Points</span>
                </div>
                <div className="stat">
                  <span className="stat-value">{score.hits}</span>
                  <span className="stat-label">Hits</span>
                </div>
                <div className="stat perfect">
                  <span className="stat-value">{score.perfectHits}</span>
                  <span className="stat-label">Perfect</span>
                </div>
                <div className="stat good">
                  <span className="stat-value">{score.goodHits}</span>
                  <span className="stat-label">Good</span>
                </div>
                <div className="stat miss">
                  <span className="stat-value">{score.misses}</span>
                  <span className="stat-label">Misses</span>
                </div>
                <div className="stat">
                  <span className="stat-value">
                    {score.hits + score.misses}/{score.totalSteps}
                  </span>
                  <span className="stat-label">Progress</span>
                </div>
              </div>
            </div>
          </div>

          <div className="recent-feedback">
            <h3>Recent Hits</h3>
            <div className="feedback-list">
              {recentFeedback.length === 0 ? (
                <p className="no-feedback">Play to see feedback...</p>
              ) : (
                recentFeedback.map((feedback, idx) => (
                  <div
                    key={idx}
                    className="feedback-item"
                    style={{ borderLeftColor: getFeedbackColor(feedback) }}
                  >
                    <span className="feedback-accuracy">{feedback.accuracy}</span>
                    <span className="feedback-note">Note {feedback.actualNote}</span>
                    <span className="feedback-timing">
                      {feedback.timingDelta > 0 ? '+' : ''}
                      {feedback.timingDelta.toFixed(0)}ms
                    </span>
                    <span className="feedback-points">+{feedback.points}pts</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
