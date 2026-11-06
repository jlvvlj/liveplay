module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/apps', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.ts?(x)', '**/?(*.)+(spec|test).ts?(x)'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverageFrom: [
    'apps/**/*.{ts,tsx}',
    '!apps/**/*.d.ts',
    '!apps/**/main.ts',
  ],
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  moduleNameMapper: {
    '\\.(css|less|scss|sass)$': 'identity-obj-proxy',
    '/instrument-lab/engine/synth\\.mjs$': '<rootDir>/tests/mocks/instrumentLabSynth.ts',
    '/instrument-lab/engine/drums\\.mjs$': '<rootDir>/tests/mocks/instrumentLabDrums.ts',
    '/instrument-lab/client/TrackZoom\\.jsx$': '<rootDir>/tests/mocks/instrumentLabTrackZoom.ts',
    '/instrument-lab/client/timeline\\.mjs$': '<rootDir>/tests/mocks/instrumentLabTimeline.ts',
    '(^|/)jamRenderer$': '<rootDir>/tests/mocks/jamRenderer.ts',
    '(^|/)jamSoundFiles$': '<rootDir>/tests/mocks/jamSoundFiles.ts',
    '\\?worker&url$': '<rootDir>/tests/mocks/workerUrl.ts',
  },
};
