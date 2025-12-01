# Melodics MVP

A cross-platform desktop application that replicates the core Melodics experience: interactive MIDI lessons for Keys, Pads, and Drums with real-time feedback.

## Features

### Core Functionality
- **Interactive MIDI Lessons**: Real-time timing and accuracy feedback for MIDI input
- **Practice Mode**: Loop sections, slow playback, Auto-BPM, and Wait mode
- **Lesson Editor/Import**: Create and import custom lesson files
- **Scoring & Progress**: Track performance, unlock achievements, and level up
- **Multi-Device Support**: Compatible with MIDI keyboards, pad controllers, and drum kits

### Technical Stack
- **Electron**: Cross-platform desktop application
- **React + TypeScript**: Modern UI with type safety
- **Node.js**: MIDI device handling and local API
- **Tone.js**: Audio scheduling and tempo management
- **node-midi**: Low-level MIDI input (with WebMIDI fallback)
- **SQLite + Prisma**: Local data persistence
- **Jest + React Testing Library**: Unit testing
- **Playwright**: End-to-end testing

## Project Structure

```
melodics/
├── apps/desktop/              # Electron + React application
│   ├── src/
│   │   ├── main/             # Electron main process (Node.js)
│   │   │   ├── main.ts       # Main process entry
│   │   │   ├── preload.ts    # IPC bridge
│   │   │   └── midi/         # MIDI manager
│   │   └── renderer/         # React application
│   │       ├── components/
│   │       │   ├── lesson-engine/
│   │       │   ├── midi/
│   │       │   └── practice-mode/
│   │       ├── styles/
│   │       └── main.tsx
│   ├── tsconfig.main.json    # TypeScript config for main
│   └── vite.config.ts        # Vite config for renderer
├── server/                   # Optional content sync server
├── scripts/                  # Build and utility scripts
├── tests/                    # Test files
├── content/samples/          # Sample lesson JSON files
└── .github/workflows/        # CI/CD configuration

```

## Getting Started

### Prerequisites
- Node.js 18+ or 20+
- npm or yarn
- A MIDI device (keyboard, pads, or drum kit) for testing

### Installation

```bash
npm ci
```

### Development

Start the application in development mode:

```bash
npm run dev
```

This will:
1. Start the Vite dev server for the React renderer
2. Launch Electron with hot reload enabled
3. Open DevTools automatically

### Building

Build the application for production:

```bash
npm run build
```

This will:
1. Build the React renderer
2. Compile the Electron main process
3. Package the application with electron-builder

### Testing

Run unit tests:

```bash
npm run test
```

Run end-to-end tests:

```bash
npm run test:e2e
```

Run type checking:

```bash
npm run typecheck
```

Run linter:

```bash
npm run lint
```

## Development Milestones

### Step 0: Scaffold ✓
- [x] Repository structure with TypeScript configs
- [x] Basic run scripts (dev, build, test)
- [x] Electron + React app shell
- [x] CI workflow (GitHub Actions)

**Acceptance Criteria:**
- `npm ci` and `npm run dev` starts the app shell
- Homepage shows "Melodics-like MVP — DEV"
- CI workflow runs `npm run test` on push

### Step 1: MIDI Input + Device Mapping
- [ ] Node module for MIDI device listing and event streaming
- [ ] IPC channels for MIDI communication (main ↔ renderer)
- [ ] Device auto/manual mapping UI
- [ ] Save device mappings to SQLite
- [ ] Unit tests for MIDI manager

**IPC Channels:**
- `midi:event` (Main → Renderer): `{timestamp, note, velocity, type}`
- `midi:list` (Renderer → Main): Returns device list
- `midi:selectDevice` (Renderer → Main): Select device by ID

**Acceptance Criteria:**
- Unit tests: Simulate MIDI event, assert IPC emission
- Manual test: Connected controller shows real-time note events in UI

### Step 2: Lesson JSON Schema & Engine
- [ ] Define canonical lesson JSON schema
- [ ] Implement lesson engine that loads and plays lessons
- [ ] Integrate Tone.js for tempo/scheduling
- [ ] Support loop sections, BPM, and subdivisions
- [ ] Create sample lesson files

**Lesson JSON Schema:**
```json
{
  "id": "basic-pad-01",
  "title": "Basic 4/4 Pad Groove",
  "instrument": "pads",
  "bpm": 100,
  "steps": [
    {"tick": 0, "note": 36, "dur": 120, "velocity": 100}
  ],
  "loop": {"startTick": 0, "endTick": 1920}
}
```

**Acceptance Criteria:**
- Lesson engine loads JSON and publishes event timeline
- Unit tests verify timing and loop behavior

### Step 3: Real-time Feedback & Scoring
- [ ] Compare user MIDI input to expected events
- [ ] Calculate timing accuracy (early/late/perfect)
- [ ] Display visual feedback (hit/miss indicators)
- [ ] Generate score and accuracy percentage

### Step 4: Practice Mode Features
- [ ] Loop section playback
- [ ] Adjustable playback speed (slow mode)
- [ ] Auto-BPM (gradually increase tempo)
- [ ] Wait mode (pause until correct input)

### Step 5: Progress & Motivation
- [ ] SQLite schema for user progress
- [ ] Track lesson completions and scores
- [ ] Leveling system with XP
- [ ] Trophy/achievement system

### Step 6: Lesson Editor
- [ ] UI for creating/editing lessons
- [ ] Import MIDI files
- [ ] Export lesson JSON

### Step 7: Polish & Packaging
- [ ] Cross-platform testing (macOS, Windows, Linux)
- [ ] Installer generation
- [ ] Performance optimization
- [ ] Documentation

## Scripts Reference

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run dev:renderer` | Start Vite dev server only |
| `npm run dev:electron` | Start Electron only (waits for Vite) |
| `npm run build` | Build complete application |
| `npm run build:renderer` | Build React renderer only |
| `npm run build:electron` | Compile Electron main process |
| `npm run build:app` | Package with electron-builder |
| `npm run test` | Run Jest unit tests |
| `npm run test:e2e` | Run Playwright E2E tests |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run lint` | Run ESLint |
| `npm run prisma:generate` | Generate Prisma client |
| `npm run prisma:migrate` | Run database migrations |

## Contributing

This is an MVP project. When contributing:
- Write tests for new features
- Update documentation
- Follow TypeScript strict mode
- Keep commits atomic and well-described

## License

MIT
