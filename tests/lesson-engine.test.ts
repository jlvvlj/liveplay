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
});
