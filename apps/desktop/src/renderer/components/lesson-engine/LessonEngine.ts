import * as Tone from 'tone';
import {
  Lesson,
  LessonStep,
  HitFeedback,
  HitAccuracy,
  LessonScore,
  PracticeModeSettings,
} from '../../types/lesson';
import { holdToleranceMs, isHoldStep, stepDurationMs } from './holdNotes';

export type LessonEngineState = 'stopped' | 'playing' | 'paused' | 'waiting';

export interface LessonEngineCallbacks {
  onStepExpected?: (step: LessonStep, expectedTime: number) => void;
  onHitFeedback?: (feedback: HitFeedback) => void;
  onScoreUpdate?: (score: LessonScore) => void;
  onStateChange?: (state: LessonEngineState) => void;
  onLoop?: () => void;
  onComplete?: (finalScore: LessonScore) => void;
  // Hold notes: a hold starts when its note is hit on time and ends when it
  // is released or reaches its end; only then is it scored
  onHoldStart?: (stepIndex: number, step: LessonStep) => void;
  onHoldEnd?: (stepIndex: number, completed: boolean) => void;
}

interface ActiveHold {
  note: number;
  endTime: number; // lesson seconds at which the note's sound ends
  toleranceSeconds: number; // released this close to the end still counts
  feedback: HitFeedback; // timing of the press, reported if the hold completes
}

/**
 * Timing windows for hit detection (in milliseconds)
 * NOTE: Very forgiving for testing - tighten for production
 */
const TIMING_WINDOWS = {
  perfect: 100,   
  good: 300,     
  early: 400,  
  late: 400,   
};

const TICKS_PER_BEAT = 480;
const MIN_TIMER_SPEED = 0.01;

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

  private scheduledSteps: Map<number, LessonStep> = new Map();
  private expectedSteps: Map<number, { step: LessonStep; time: number }> = new Map();
  private processedSteps: Set<number> = new Set();
  private activeHolds: Map<number, ActiveHold> = new Map();

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
  private scheduleVersion: number = 0;
  private timeoutIds: number[] = [];
  private playbackStartRealTime: number | null = null;
  private playbackStartLessonTime: number = 0;
  // A lesson room's song: the lesson follows its clock (lesson seconds, back
  // to 0 at each loop) instead of its own, at the song's own speed
  private clock: (() => number) | null = null;
  // A lesson room's lesson, on its clock or not: the song never waits for a note
  private songNeverWaits: boolean;

  constructor(callbacks: LessonEngineCallbacks = {}, { songNeverWaits = false }: { songNeverWaits?: boolean } = {}) {
    this.callbacks = callbacks;
    this.songNeverWaits = songNeverWaits;
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

    Tone.Transport.stop();
    Tone.Transport.cancel();

    this.processedSteps.clear();
    this.playbackStartLessonTime = 0;
    this.playbackStartRealTime = Tone.now();
    this.scheduleSteps(0);

    console.log('[LessonEngine] Lesson clock started at 0');
    this.setState('playing');
  }

  /**
   * Plays the lesson on an outside clock, looping with it: from where that
   * clock is now. pause() and resume() follow it too.
   */
  startOnClock(clock: () => number): void {
    if (!this.lesson) {
      throw new Error('No lesson loaded');
    }
    this.clock = clock;
    this.practiceMode = { ...this.practiceMode, loopEnabled: true, speedMultiplier: 1, waitModeEnabled: false };
    this.processedSteps.clear();
    this.playbackStartRealTime = Tone.now();
    this.scheduleSteps(clock());
    this.setState('playing');
  }

  /**
   * Pause the lesson
   */
  pause(): void {
    if (this.state !== 'playing') {
      return;
    }

    this.playbackStartLessonTime = this.getCurrentTimeSeconds();
    this.playbackStartRealTime = null;
    this.clearScheduledTimeouts();
    this.setState('paused');
  }

  /**
   * Resume from pause
   */
  resume(): void {
    if (this.state !== 'paused') {
      return;
    }

    this.playbackStartRealTime = Tone.now();
    this.scheduleSteps(this.clock ? this.clock() : this.playbackStartLessonTime);
    this.setState('playing');
  }

  /**
   * Stop the lesson
   */
  stop(): void {
    this.clock = null;
    this.scheduleVersion++;
    Tone.Transport.stop();
    Tone.Transport.cancel();
    this.clearScheduledTimeouts();
    this.playbackStartRealTime = null;
    this.playbackStartLessonTime = 0;
    this.scheduledSteps.clear();
    this.expectedSteps.clear();
    this.processedSteps.clear();
    this.activeHolds.clear();
    this.setState('stopped');
  }

  /**
   * Process a MIDI input note
   */
  processNote(note: number, timestamp: number): HitFeedback | null {
    console.log('[LessonEngine] processNote called:', {
      note,
      timestamp,
      state: this.state,
      expectedStepsCount: this.expectedSteps.size,
      processedStepsCount: this.processedSteps.size,
    });

    if (this.state === 'waiting') {
      this.handleWaitModeInput(note, timestamp);
      return null;
    }

    const currentTime = this.getCurrentTimeSeconds();
    console.log('[LessonEngine] Current lesson time:', currentTime);

    // Strict sequential play: the ONLY hittable note is the next unprocessed step,
    // in order. This prevents matching an identical pitch further down the track
    // (e.g. next is A then D, D, J — pressing J must do nothing; only A counts).
    let targetIndex = -1;
    let target: { step: LessonStep; time: number } | null = null;
    for (const [stepIndex, expected] of this.expectedSteps.entries()) {
      if (this.processedSteps.has(stepIndex)) continue;
      if (targetIndex === -1 || stepIndex < targetIndex) {
        targetIndex = stepIndex;
        target = expected;
      }
    }

    if (targetIndex === -1 || !target) {
      console.log('[LessonEngine] No pending note to hit for input:', note);
      return null;
    }

    // In a lesson room the song never waits: notes due together (a chord, an
    // octave, drums hit at once) can be played in any order, as one ship plays
    // one row at a time; and a press is judged as the step of its note nearest
    // it, those left unplayed before it counted as missed (else, with notes
    // closer than the late window, every press after one miss would be judged
    // against the note before it)
    if (this.clock || this.songNeverWaits) {
      const pending = [...this.expectedSteps.entries()]
        .filter(([stepIndex]) => !this.processedSteps.has(stepIndex))
        .sort((a, b) => a[0] - b[0]);
      const delta = (time: number) => this.loopDelta(currentTime, time);
      const played = pending
        .filter(([, expected]) => expected.step.note === note && delta(expected.time) <= TIMING_WINDOWS.late && delta(expected.time) >= -TIMING_WINDOWS.early)
        .sort((a, b) => Math.abs(delta(a[1].time)) - Math.abs(delta(b[1].time)))[0];
      if (played) {
        const left = pending.filter(([stepIndex, expected]) => stepIndex < played[0] && expected.step.tick < played[1].step.tick);
        if (left.every(([, expected]) => delta(expected.time) > 0)) {
          for (const [stepIndex, expected] of left) this.markMissed(stepIndex, expected.step, expected.time);
          [targetIndex, target] = played;
        }
      }
    }

    // Wrong note: the input does not match the next expected note — ignore it.
    if (target.step.note !== note) {
      console.log(`[LessonEngine] Ignoring note ${note}: next expected note is ${target.step.note} (step ${targetIndex})`);
      return null;
    }

    // Right note, but only counts near the hit line.
    // delta > 0 = pressed after the note's time (late), delta < 0 = before (early).
    // On a looping clock a note near the loop's start can be hit just before it wraps.
    const delta = this.loopDelta(currentTime, target.time);
    const withinWindow = delta <= TIMING_WINDOWS.late && delta >= -TIMING_WINDOWS.early;
    if (!withinWindow) {
      console.log(`[LessonEngine] Note ${note} matches next step ${targetIndex} but OUTSIDE timing window. Delta: ${delta.toFixed(0)}ms, Window: [-${TIMING_WINDOWS.early}, +${TIMING_WINDOWS.late}]ms`);
      return null;
    }

    console.log(`[LessonEngine] ✓ Hit on next step ${targetIndex}. Delta: ${delta.toFixed(0)}ms`);
    const feedback = this.generateFeedback(target.step, note, currentTime, delta);
    this.processedSteps.add(targetIndex);

    if (this.lesson && isHoldStep(this.lesson, target.step)) {
      // A hold note is scored when it is released or reaches its end
      const durationMs = stepDurationMs(target.step, this.lesson.bpm);
      const hold: ActiveHold = {
        note,
        endTime: target.time + durationMs / 1000,
        toleranceSeconds: holdToleranceMs(durationMs) / 1000,
        feedback,
      };
      this.activeHolds.set(targetIndex, hold);
      this.callbacks.onHoldStart?.(targetIndex, target.step);
      const version = this.scheduleVersion;
      this.scheduleTimeout(() => {
        if (version === this.scheduleVersion) this.finishHold(targetIndex, true);
      }, Math.max(0, hold.endTime - hold.toleranceSeconds - currentTime));
      return null;
    }

    this.updateScore(feedback);

    if (this.callbacks.onHitFeedback) {
      this.callbacks.onHitFeedback(feedback);
    } else {
      console.warn('[LessonEngine] No onHitFeedback callback registered!');
    }

    return feedback;
  }

  /**
   * Process the release of a note: a hold note let go before its end is a
   * miss, one held to (nearly) its end is a hit.
   */
  processNoteOff(note: number): void {
    const currentTime = this.getCurrentTimeSeconds();
    for (const [stepIndex, hold] of this.activeHolds) {
      if (hold.note !== note) continue;
      this.finishHold(stepIndex, currentTime >= hold.endTime - hold.toleranceSeconds);
    }
  }

  /** Whether a hold note on this note is in progress. */
  isHolding(note: number): boolean {
    for (const hold of this.activeHolds.values()) {
      if (hold.note === note) return true;
    }
    return false;
  }

  // How far (ms) `now` is past `time`; on a looping clock the nearest way round
  private loopDelta(now: number, time: number): number {
    const raw = (now - time) * 1000;
    const loopMs = this.ticksToSeconds(this.loopEndTick - this.loopStartTick) * 1000;
    return this.clock && loopMs > 0 ? raw - loopMs * Math.round(raw / loopMs) : raw;
  }

  // A step left unplayed, counted as missed now
  private markMissed(stepIndex: number, step: LessonStep, time: number): void {
    const actualTime = this.getCurrentTimeSeconds();
    const feedback: HitFeedback = {
      expectedStep: step,
      actualNote: step.note,
      actualTime,
      timingDelta: this.loopDelta(actualTime, time),
      accuracy: 'miss',
      points: POINTS.miss,
    };
    this.processedSteps.add(stepIndex);
    this.updateScore(feedback);
    this.callbacks.onHitFeedback?.(feedback);
  }

  private finishHold(stepIndex: number, completed: boolean): void {
    const hold = this.activeHolds.get(stepIndex);
    if (!hold) return;
    this.activeHolds.delete(stepIndex);
    const feedback: HitFeedback = completed
      ? hold.feedback
      : { ...hold.feedback, accuracy: 'miss', points: POINTS.miss };
    this.updateScore(feedback);
    this.callbacks.onHitFeedback?.(feedback);
    this.callbacks.onHoldEnd?.(stepIndex, completed);
  }

  /**
   * Update practice mode settings
   */
  setPracticeMode(settings: Partial<PracticeModeSettings>): void {
    const speedChanged = settings.speedMultiplier !== undefined && settings.speedMultiplier !== this.practiceMode.speedMultiplier;
    const currentTime = this.state === 'playing' && this.lesson ? this.getCurrentTimeSeconds() : this.playbackStartLessonTime;
    this.practiceMode = { ...this.practiceMode, ...settings };

    // Update BPM if playing
    if (this.state === 'playing' && this.lesson) {
      this.playbackStartLessonTime = currentTime;
      this.playbackStartRealTime = Tone.now();

      if (speedChanged) {
        this.clearScheduledTimeouts();
        this.scheduleSteps(currentTime);
      }
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

  getCurrentTimeSeconds(): number {
    if (this.clock) return this.state === 'playing' ? this.clock() : this.playbackStartLessonTime;
    if (this.state === 'playing' && this.playbackStartRealTime !== null) {
      return this.playbackStartLessonTime + (Tone.now() - this.playbackStartRealTime) * this.getEffectiveSpeed();
    }
    return this.playbackStartLessonTime;
  }

  private scheduleSteps(fromTime: number = 0): void {
    if (!this.lesson) return;

    const version = ++this.scheduleVersion;
    this.clearScheduledTimeouts();
    const loopDuration = this.ticksToSeconds(this.loopEndTick - this.loopStartTick);
    this.expectedSteps.clear();
    console.log('[LessonEngine] Scheduling steps:', {
      loopStartTick: this.loopStartTick,
      loopEndTick: this.loopEndTick,
      loopDuration,
      fromTime,
      totalSteps: this.lesson.steps.length,
    });

    // Pre-populate ALL expected steps with their calculated times
    // This allows hitting notes early (before the scheduled callback fires)
    for (let i = 0; i < this.lesson.steps.length; i++) {
      const step = this.lesson.steps[i];

      // Only include steps within the current loop
      if (step.tick >= this.loopStartTick && step.tick < this.loopEndTick) {
        const offsetTick = step.tick - this.loopStartTick;
        const expectedTime = this.ticksToSeconds(offsetTick);

        console.log('[LessonEngine] Adding expected step:', {
          stepIndex: i,
          note: step.note,
          tick: step.tick,
          offsetTick,
          expectedTime,
        });

        // Add to expectedSteps immediately with pre-calculated time
        this.expectedSteps.set(i, { step, time: expectedTime });

        // Schedule miss check after the timing window
        const secondsUntilStep = expectedTime - fromTime;
        const missCheckTime = Math.max(0, secondsUntilStep + (TIMING_WINDOWS.late / 1000));
        const markMiss = () => {
          if (version !== this.scheduleVersion || this.state !== 'playing') return;
          if (!this.processedSteps.has(i)) {
            const actualTime = this.getCurrentTimeSeconds();
            const timingDelta = (actualTime - expectedTime) * 1000;
            if (timingDelta < TIMING_WINDOWS.late) {
              this.scheduleTimeout(markMiss, (TIMING_WINDOWS.late - timingDelta + 25) / 1000);
              return;
            }
            console.log('[LessonEngine] Step missed:', { stepIndex: i, note: step.note });
            const feedback: HitFeedback = {
              expectedStep: step,
              actualNote: step.note,
              actualTime,
              timingDelta,
              accuracy: 'miss',
              points: POINTS.miss,
            };
            this.updateScore(feedback);
            this.processedSteps.add(i);

            if (this.callbacks.onHitFeedback) {
              this.callbacks.onHitFeedback(feedback);
            }
          }
        };
        this.scheduleTimeout(markMiss, missCheckTime);
      }
    }

    console.log('[LessonEngine] All expected steps pre-populated:', this.expectedSteps.size);

    // Schedule loop restart or completion
    // Practice mode loopEnabled setting takes precedence
    if (this.practiceMode.loopEnabled) {
      const secondsUntilLoop = Math.max(0, loopDuration - fromTime);
      console.log('[LessonEngine] Scheduling loop restart at', secondsUntilLoop, 'seconds');
      this.scheduleTimeout(() => {
        if (version !== this.scheduleVersion) return;
        this.handleLoop();
      }, secondsUntilLoop);
    } else {
      // Schedule completion when lesson ends
      const secondsUntilCompletion = Math.max(0, loopDuration - fromTime);
      console.log('[LessonEngine] Scheduling completion at', secondsUntilCompletion, 'seconds');
      this.scheduleTimeout(() => {
        if (version !== this.scheduleVersion) return;
        this.handleCompletion();
      }, secondsUntilCompletion);
    }
  }

  private handleLoop(): void {
    console.log('[LessonEngine] Handling loop - resetting Transport position');

    // Clear processed and expected steps
    this.processedSteps.clear();
    this.expectedSteps.clear();
    this.activeHolds.clear();

    this.playbackStartLessonTime = 0;
    this.playbackStartRealTime = Tone.now();
    // On an outside clock the next loop starts from where that clock is
    // (the timer may fire a little before or after it wraps)
    const now = this.clock ? this.clock() : 0;
    this.scheduleSteps(now > this.ticksToSeconds(this.loopEndTick - this.loopStartTick) / 2 ? 0 : now);

    console.log('[LessonEngine] Lesson clock restarted for loop');

    if (this.callbacks.onLoop) {
      this.callbacks.onLoop();
    }
  }

  private handleCompletion(): void {
    console.log('[LessonEngine] Lesson completed! Final score:', this.getScore());
    this.stop();

    if (this.callbacks.onComplete) {
      console.log('[LessonEngine] Calling onComplete callback');
      this.callbacks.onComplete(this.getScore());
    } else {
      console.warn('[LessonEngine] No onComplete callback registered!');
    }
  }

  private handleWaitModeInput(note: number, _timestamp: number): void {
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
    const bpm = this.lesson.bpm;
    const beatsPerSecond = bpm / 60;
    return ticks / (TICKS_PER_BEAT * beatsPerSecond);
  }

  private getEffectiveSpeed(): number {
    return Math.max(this.practiceMode.speedMultiplier, 0);
  }

  private scheduleTimeout(callback: () => void, lessonSeconds: number): void {
    const speed = this.getEffectiveSpeed();
    if (speed <= 0) return;
    const delayMs = Math.max(0, (lessonSeconds / Math.max(speed, MIN_TIMER_SPEED)) * 1000);
    const id = window.setTimeout(callback, delayMs);
    this.timeoutIds.push(id);
  }

  private clearScheduledTimeouts(): void {
    for (const id of this.timeoutIds) {
      window.clearTimeout(id);
    }
    this.timeoutIds = [];
  }

  private setState(state: LessonEngineState): void {
    this.state = state;
    if (this.callbacks.onStateChange) {
      this.callbacks.onStateChange(state);
    }
  }
}
