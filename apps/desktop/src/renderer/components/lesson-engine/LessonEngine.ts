import * as Tone from 'tone';
import {
  Lesson,
  LessonStep,
  HitFeedback,
  HitAccuracy,
  LessonScore,
  PracticeModeSettings,
} from '../../types/lesson';

export type LessonEngineState = 'stopped' | 'playing' | 'paused' | 'waiting';

export interface LessonEngineCallbacks {
  onStepExpected?: (step: LessonStep, expectedTime: number) => void;
  onHitFeedback?: (feedback: HitFeedback) => void;
  onScoreUpdate?: (score: LessonScore) => void;
  onStateChange?: (state: LessonEngineState) => void;
  onLoop?: () => void;
}

/**
 * Timing windows for hit detection (in milliseconds)
 */
const TIMING_WINDOWS = {
  perfect: 50,   // ±50ms
  good: 100,     // ±100ms
  early: 200,    // up to 200ms early
  late: 200,     // up to 200ms late
};

/**
 * Points awarded for each accuracy level
 */
const POINTS = {
  perfect: 100,
  good: 75,
  early: 50,
  late: 50,
  miss: 0,
};

export class LessonEngine {
  private lesson: Lesson | null = null;
  private state: LessonEngineState = 'stopped';
  private callbacks: LessonEngineCallbacks;
  private practiceMode: PracticeModeSettings;

  private currentTick: number = 0;
  private scheduledSteps: Map<number, LessonStep> = new Map();
  private expectedSteps: Map<number, { step: LessonStep; time: number }> = new Map();
  private processedSteps: Set<number> = new Set();

  private score: LessonScore = {
    totalSteps: 0,
    hits: 0,
    misses: 0,
    perfectHits: 0,
    goodHits: 0,
    accuracy: 0,
    totalPoints: 0,
    maxPoints: 0,
  };

  private loopStartTick: number = 0;
  private loopEndTick: number = 0;
  private playbackStartTime: number = 0;

  constructor(callbacks: LessonEngineCallbacks = {}) {
    this.callbacks = callbacks;
    this.practiceMode = {
      loopEnabled: false,
      speedMultiplier: 1.0,
      autoBpmEnabled: false,
      autoBpmStartSpeed: 0.5,
      autoBpmIncrementSteps: 0.1,
      waitModeEnabled: false,
    };
  }

  /**
   * Load a lesson into the engine
   */
  loadLesson(lesson: Lesson): void {
    this.stop();
    this.lesson = lesson;
    this.score = {
      totalSteps: lesson.steps.length,
      hits: 0,
      misses: 0,
      perfectHits: 0,
      goodHits: 0,
      accuracy: 0,
      totalPoints: 0,
      maxPoints: lesson.steps.length * POINTS.perfect,
    };

    // Set up loop points
    if (lesson.loop) {
      this.loopStartTick = lesson.loop.startTick;
      this.loopEndTick = lesson.loop.endTick;
    } else {
      this.loopStartTick = 0;
      const lastStep = lesson.steps[lesson.steps.length - 1];
      this.loopEndTick = lastStep ? lastStep.tick + lastStep.dur : 0;
    }

    // Apply practice mode settings
    if (this.practiceMode.loopEnabled && this.practiceMode.loopSection) {
      this.loopStartTick = this.practiceMode.loopSection.startTick;
      this.loopEndTick = this.practiceMode.loopSection.endTick;
    }
  }

  /**
   * Start playing the lesson
   */
  async start(): Promise<void> {
    if (!this.lesson) {
      throw new Error('No lesson loaded');
    }

    if (this.state === 'playing') {
      return;
    }

    await Tone.start();

    // Set BPM with speed multiplier
    const effectiveBpm = this.lesson.bpm * this.practiceMode.speedMultiplier;
    Tone.Transport.bpm.value = effectiveBpm;

    this.currentTick = this.loopStartTick;
    this.playbackStartTime = Tone.now();
    this.processedSteps.clear();
    this.scheduleSteps();

    Tone.Transport.start();
    this.setState('playing');
  }

  /**
   * Pause the lesson
   */
  pause(): void {
    if (this.state !== 'playing') {
      return;
    }

    Tone.Transport.pause();
    this.setState('paused');
  }

  /**
   * Resume from pause
   */
  resume(): void {
    if (this.state !== 'paused') {
      return;
    }

    Tone.Transport.start();
    this.setState('playing');
  }

  /**
   * Stop the lesson
   */
  stop(): void {
    Tone.Transport.stop();
    Tone.Transport.cancel();
    this.currentTick = this.loopStartTick;
    this.scheduledSteps.clear();
    this.expectedSteps.clear();
    this.processedSteps.clear();
    this.setState('stopped');
  }

  /**
   * Process a MIDI input note
   */
  processNote(note: number, timestamp: number): void {
    if (this.state === 'waiting') {
      this.handleWaitModeInput(note, timestamp);
      return;
    }

    // Find the closest expected step for this note
    const currentTime = Tone.now();
    let closestMatch: { step: LessonStep; time: number; delta: number } | null = null;

    for (const [stepIndex, expected] of this.expectedSteps.entries()) {
      if (expected.step.note === note && !this.processedSteps.has(stepIndex)) {
        const delta = (timestamp - expected.time) * 1000; // Convert to ms

        if (Math.abs(delta) < TIMING_WINDOWS.late + TIMING_WINDOWS.early) {
          if (!closestMatch || Math.abs(delta) < Math.abs(closestMatch.delta)) {
            closestMatch = { step: expected.step, time: expected.time, delta };
          }
        }
      }
    }

    if (closestMatch) {
      const feedback = this.generateFeedback(
        closestMatch.step,
        note,
        timestamp,
        closestMatch.delta
      );
      this.updateScore(feedback);

      // Mark as processed
      const stepIndex = this.lesson!.steps.indexOf(closestMatch.step);
      this.processedSteps.add(stepIndex);

      if (this.callbacks.onHitFeedback) {
        this.callbacks.onHitFeedback(feedback);
      }
    }
  }

  /**
   * Update practice mode settings
   */
  setPracticeMode(settings: Partial<PracticeModeSettings>): void {
    this.practiceMode = { ...this.practiceMode, ...settings };

    // Update BPM if playing
    if (this.state === 'playing' && this.lesson) {
      const effectiveBpm = this.lesson.bpm * this.practiceMode.speedMultiplier;
      Tone.Transport.bpm.value = effectiveBpm;
    }
  }

  /**
   * Get current score
   */
  getScore(): LessonScore {
    return { ...this.score };
  }

  /**
   * Get current state
   */
  getState(): LessonEngineState {
    return this.state;
  }

  private scheduleSteps(): void {
    if (!this.lesson) return;

    const loopDuration = this.ticksToSeconds(this.loopEndTick - this.loopStartTick);

    for (let i = 0; i < this.lesson.steps.length; i++) {
      const step = this.lesson.steps[i];

      // Only schedule steps within the current loop
      if (step.tick >= this.loopStartTick && step.tick < this.loopEndTick) {
        const offsetTick = step.tick - this.loopStartTick;
        const timeOffset = this.ticksToSeconds(offsetTick);
        const scheduleTime = `+${timeOffset}`;

        Tone.Transport.schedule((time) => {
          this.expectedSteps.set(i, { step, time });

          if (this.callbacks.onStepExpected) {
            this.callbacks.onStepExpected(step, time);
          }

          // Check for missed notes after timing window
          Tone.Transport.schedule(() => {
            if (!this.processedSteps.has(i)) {
              const feedback: HitFeedback = {
                expectedStep: step,
                actualNote: step.note,
                actualTime: time + TIMING_WINDOWS.late / 1000,
                timingDelta: TIMING_WINDOWS.late,
                accuracy: 'miss',
                points: POINTS.miss,
              };
              this.updateScore(feedback);
              this.processedSteps.add(i);

              if (this.callbacks.onHitFeedback) {
                this.callbacks.onHitFeedback(feedback);
              }
            }
          }, time + TIMING_WINDOWS.late / 1000);

        }, scheduleTime);
      }
    }

    // Schedule loop restart
    if (this.practiceMode.loopEnabled || this.lesson.loop) {
      Tone.Transport.schedule(() => {
        this.handleLoop();
      }, `+${loopDuration}`);
    }
  }

  private handleLoop(): void {
    this.processedSteps.clear();
    this.expectedSteps.clear();
    this.scheduleSteps();

    if (this.callbacks.onLoop) {
      this.callbacks.onLoop();
    }
  }

  private handleWaitModeInput(note: number, timestamp: number): void {
    // Find the next expected step
    const nextStep = this.findNextExpectedStep();

    if (nextStep && nextStep.note === note) {
      // Correct input, resume playback
      this.setState('playing');
      Tone.Transport.start();
    }
  }

  private findNextExpectedStep(): LessonStep | null {
    if (!this.lesson) return null;

    for (let i = 0; i < this.lesson.steps.length; i++) {
      if (!this.processedSteps.has(i)) {
        return this.lesson.steps[i];
      }
    }

    return null;
  }

  private generateFeedback(
    expectedStep: LessonStep,
    actualNote: number,
    actualTime: number,
    timingDelta: number
  ): HitFeedback {
    let accuracy: HitAccuracy;

    if (Math.abs(timingDelta) <= TIMING_WINDOWS.perfect) {
      accuracy = 'perfect';
    } else if (Math.abs(timingDelta) <= TIMING_WINDOWS.good) {
      accuracy = 'good';
    } else if (timingDelta < 0) {
      accuracy = 'early';
    } else {
      accuracy = 'late';
    }

    return {
      expectedStep,
      actualNote,
      actualTime,
      timingDelta,
      accuracy,
      points: POINTS[accuracy],
    };
  }

  private updateScore(feedback: HitFeedback): void {
    this.score.totalPoints += feedback.points;

    if (feedback.accuracy !== 'miss') {
      this.score.hits++;
    } else {
      this.score.misses++;
    }

    if (feedback.accuracy === 'perfect') {
      this.score.perfectHits++;
    } else if (feedback.accuracy === 'good') {
      this.score.goodHits++;
    }

    this.score.accuracy = (this.score.totalPoints / this.score.maxPoints) * 100;

    if (this.callbacks.onScoreUpdate) {
      this.callbacks.onScoreUpdate(this.getScore());
    }
  }

  private ticksToSeconds(ticks: number): number {
    if (!this.lesson) return 0;
    const bpm = this.lesson.bpm * this.practiceMode.speedMultiplier;
    const ticksPerBeat = 480; // Standard MIDI ticks per quarter note
    const beatsPerSecond = bpm / 60;
    return ticks / (ticksPerBeat * beatsPerSecond);
  }

  private setState(state: LessonEngineState): void {
    this.state = state;
    if (this.callbacks.onStateChange) {
      this.callbacks.onStateChange(state);
    }
  }
}
