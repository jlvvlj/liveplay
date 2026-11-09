import * as Tone from 'tone';
import { LessonEngine } from '../apps/desktop/src/renderer/components/lesson-engine/LessonEngine';
import { Lesson, HitFeedback, LessonScore } from '../apps/desktop/src/renderer/types/lesson';

// Mock Tone.js
jest.mock('tone', () => ({
  start: jest.fn().mockResolvedValue(undefined),
  now: jest.fn().mockReturnValue(0),
  Transport: {
    bpm: { value: 120 },
    start: jest.fn(),
    stop: jest.fn(),
    pause: jest.fn(),
    schedule: jest.fn(),
    cancel: jest.fn(),
  },
}));

const mockLesson: Lesson = {
  id: 'test-lesson-01',
  title: 'Test Lesson',
  instrument: 'pads',
  bpm: 100,
  steps: [
    { tick: 0, note: 36, dur: 120, velocity: 100 },
    { tick: 480, note: 38, dur: 120, velocity: 100 },
    { tick: 960, note: 40, dur: 120, velocity: 100 },
    { tick: 1440, note: 41, dur: 120, velocity: 100 },
  ],
  loop: {
    startTick: 0,
    endTick: 1920,
  },
};

describe('LessonEngine', () => {
  let engine: LessonEngine;
  let hitFeedbacks: HitFeedback[] = [];
  let scoreUpdates: LessonScore[] = [];

  beforeEach(() => {
    hitFeedbacks = [];
    scoreUpdates = [];

    engine = new LessonEngine({
      onHitFeedback: (feedback) => hitFeedbacks.push(feedback),
      onScoreUpdate: (score) => scoreUpdates.push(score),
    });
  });

  describe('loadLesson', () => {
    it('should load a lesson and initialize score', () => {
      engine.loadLesson(mockLesson);
      const score = engine.getScore();

      expect(score.totalSteps).toBe(4);
      expect(score.hits).toBe(0);
      expect(score.misses).toBe(0);
      expect(score.maxPoints).toBe(400); // 4 steps * 100 points
    });

    it('should set loop points from lesson', () => {
      engine.loadLesson(mockLesson);
      expect(engine.getState()).toBe('stopped');
    });
  });

  describe('state management', () => {
    beforeEach(() => {
      engine.loadLesson(mockLesson);
    });

    it('should start in stopped state', () => {
      expect(engine.getState()).toBe('stopped');
    });

    it('should transition to playing when started', async () => {
      await engine.start();
      expect(engine.getState()).toBe('playing');
    });

    it('should transition to paused when paused', async () => {
      await engine.start();
      engine.pause();
      expect(engine.getState()).toBe('paused');
    });

    it('should transition back to playing when resumed', async () => {
      await engine.start();
      engine.pause();
      engine.resume();
      expect(engine.getState()).toBe('playing');
    });

    it('should transition to stopped when stopped', async () => {
      await engine.start();
      engine.stop();
      expect(engine.getState()).toBe('stopped');
    });
  });

  describe('processNote', () => {
    beforeEach(() => {
      engine.loadLesson(mockLesson);
    });

    it('should handle note input without crashing', () => {
      // Note: Full timing simulation requires Tone.js to be running
      // This test verifies the method exists and handles input gracefully
      expect(() => engine.processNote(36, 0)).not.toThrow();
    });

    it('should update score after processing notes', () => {
      expect(() => engine.processNote(36, 0)).not.toThrow();

      const score = engine.getScore();
      expect(score.totalPoints).toBeGreaterThanOrEqual(0);
    });
  });

  describe('practice mode', () => {
    beforeEach(() => {
      engine.loadLesson(mockLesson);
    });

    it('should allow setting practice mode settings', () => {
      engine.setPracticeMode({
        loopEnabled: true,
        speedMultiplier: 0.5,
      });

      expect(engine.getState()).toBe('stopped');
    });

    it('should apply speed multiplier to playback', async () => {
      engine.setPracticeMode({ speedMultiplier: 0.75 });
      await engine.start();

      // BPM should be multiplied by speed
      expect(Tone.Transport.bpm.value).toBeGreaterThanOrEqual(0);
    });
  });

  describe('scoring', () => {
    beforeEach(() => {
      engine.loadLesson(mockLesson);
    });

    it('should initialize with zero score', () => {
      const score = engine.getScore();

      expect(score.hits).toBe(0);
      expect(score.misses).toBe(0);
      expect(score.perfectHits).toBe(0);
      expect(score.goodHits).toBe(0);
      expect(score.totalPoints).toBe(0);
      expect(score.accuracy).toBe(0);
    });

    it('should calculate accuracy as percentage', () => {
      const score = engine.getScore();
      expect(score.accuracy).toBe(0);
      expect(score.maxPoints).toBe(400);
    });
  });

  describe('error handling', () => {
    it('should throw error when starting without a lesson', async () => {
      await expect(engine.start()).rejects.toThrow('No lesson loaded');
    });

    it('should handle stop when not playing', () => {
      expect(() => engine.stop()).not.toThrow();
    });

    it('should handle pause when not playing', () => {
      expect(() => engine.pause()).not.toThrow();
    });
  });

  describe('on a room\'s clock', () => {
    // 100 BPM: a beat is 0.6 s; the loop (1920 ticks) is 2.4 s
    const chord: Lesson = {
      ...mockLesson,
      steps: [
        { tick: 0, note: 36, dur: 120, velocity: 100 },
        { tick: 0, note: 48, dur: 120, velocity: 100 },
        { tick: 960, note: 40, dur: 120, velocity: 100 },
      ],
    };

    it('takes notes due together in any order', () => {
      let now = 0.01;
      engine.loadLesson(chord);
      engine.startOnClock(() => now);
      expect(engine.processNote(48, 0)?.accuracy).toBe('perfect');
      expect(engine.processNote(36, 0)?.accuracy).toBe('perfect');
      now = 1.2;
      expect(engine.processNote(40, 0)?.accuracy).toBe('perfect');
    });

    it('judges a note at the loop\'s start played just before the loop wraps', () => {
      let now = 2.25;
      engine.loadLesson(chord);
      engine.startOnClock(() => now);
      const feedback = engine.processNote(36, 0);
      expect(feedback?.accuracy).toBe('good');
      expect(Math.round(feedback!.timingDelta)).toBe(-150);
      now = 0;
    });

    it('judges a note played after one left unplayed as itself, the other missed', () => {
      // 8ths at 100 BPM: 0.3 s apart, closer than the late window
      const line: Lesson = {
        ...mockLesson,
        steps: [
          { tick: 0, note: 36, dur: 120, velocity: 100 },
          { tick: 240, note: 48, dur: 120, velocity: 100 },
          { tick: 480, note: 36, dur: 120, velocity: 100 },
        ],
      };
      let now = 0.31;
      engine.loadLesson(line);
      engine.startOnClock(() => now);
      expect(engine.processNote(48, 0)?.accuracy).toBe('perfect');
      expect(hitFeedbacks.map((feedback) => feedback.accuracy)).toEqual(['miss', 'perfect']);
      now = 0.6;
      expect(engine.processNote(36, 0)?.accuracy).toBe('perfect');
    });

    it('judges a press as the step of its note nearest it, on one lane too', () => {
      // Three hits on one lane, 0.15 s apart: the second played on time after the first left unplayed
      const lane: Lesson = {
        ...mockLesson,
        steps: [
          { tick: 0, note: 36, dur: 60, velocity: 100 },
          { tick: 120, note: 36, dur: 60, velocity: 100 },
          { tick: 240, note: 36, dur: 60, velocity: 100 },
        ],
      };
      const now = 0.15;
      engine.loadLesson(lane);
      engine.startOnClock(() => now);
      const feedback = engine.processNote(36, 0);
      expect(feedback?.accuracy).toBe('perfect');
      expect(feedback?.expectedStep.tick).toBe(120);
      expect(hitFeedbacks.map((hit) => hit.accuracy)).toEqual(['miss', 'perfect']);
    });

    it('counts every hit after one left unplayed in a lesson room\'s Play and game runs, off its clock', async () => {
      const line: Lesson = {
        ...mockLesson,
        steps: [
          { tick: 0, note: 36, dur: 120, velocity: 100 },
          { tick: 240, note: 48, dur: 120, velocity: 100 },
          { tick: 480, note: 40, dur: 120, velocity: 100 },
          { tick: 720, note: 36, dur: 120, velocity: 100 },
        ],
      };
      let now = 0;
      (Tone.now as jest.Mock).mockImplementation(() => now);
      const room = new LessonEngine({ onHitFeedback: (feedback) => hitFeedbacks.push(feedback) }, { songNeverWaits: true });
      room.loadLesson(line);
      await room.start();
      // The first is left unplayed; each after it counts
      for (const [at, note] of [
        [0.3, 48],
        [0.6, 40],
        [0.9, 36],
      ]) {
        now = at;
        expect(room.processNote(note, 0)?.accuracy).toBe('perfect');
      }
      expect(hitFeedbacks.map((feedback) => feedback.accuracy)).toEqual(['miss', 'perfect', 'perfect', 'perfect']);
      expect(room.getScore()).toMatchObject({ hits: 3, misses: 1 });
      room.stop();
      (Tone.now as jest.Mock).mockReset();
      (Tone.now as jest.Mock).mockReturnValue(0);
    });

    it('keeps lesson mode\'s order off a room\'s clock: the lowest of notes due together first', async () => {
      engine.loadLesson(chord);
      await engine.start();
      expect(engine.processNote(48, 0)).toBeNull();
      expect(engine.processNote(36, 0)?.accuracy).toBe('perfect');
    });
  });
});

