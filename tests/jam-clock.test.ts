import {
  ServerClock,
  audioTimeAt,
  hitSlot,
  remoteNoteSlot,
  roundTripP90,
  swungPosition,
} from '../apps/desktop/src/renderer/components/lesson-engine/jamClock';

describe('ServerClock', () => {
  it('takes its offset from the ping with the shortest round trip', () => {
    const clock = new ServerClock();
    expect(clock.synced).toBe(false);
    // Server is 1000 ms ahead; the slow ping came back unevenly
    clock.add({ sent: 0, received: 80, server: 1070 });
    clock.add({ sent: 100, received: 110, server: 1105 });
    clock.add({ sent: 200, received: 260, server: 1210 });
    expect(clock.synced).toBe(true);
    expect(clock.offset).toBe(1000);
    expect(clock.roundTrip).toBe(10);
    expect(clock.now(500)).toBe(1500);
    expect(clock.toPage(1500)).toBe(500);
  });

  it('forgets old pings', () => {
    const clock = new ServerClock();
    clock.add({ sent: 0, received: 2, server: 1001 });
    for (let i = 1; i <= 16; i++) clock.add({ sent: i * 100, received: i * 100 + 20, server: i * 100 + 2010 });
    expect(clock.offset).toBe(2000);
  });
});

describe('audioTimeAt', () => {
  const realNow = performance.now;
  afterEach(() => {
    performance.now = realNow;
  });

  it('maps page time to the audio time leaving the speakers', () => {
    const context = {
      getOutputTimestamp: () => ({ contextTime: 10, performanceTime: 5000 }),
    } as unknown as AudioContext;
    expect(audioTimeAt(context, 5500)).toBeCloseTo(10.5);
  });

  it('uses the output latency where output timestamps are missing', () => {
    performance.now = () => 1000;
    const context = { currentTime: 4, outputLatency: 0.02, baseLatency: 0.005 } as unknown as AudioContext;
    expect(audioTimeAt(context, 1100)).toBeCloseTo(4.08);
  });
});

describe('hitSlot', () => {
  it('snaps to the next 16th, or the one just passed within the grace', () => {
    expect(hitSlot(4.5, 0.2, 0)).toBe(5);
    expect(hitSlot(4.1, 0.2, 0)).toBe(4);
    expect(hitSlot(4, 0.2, 0)).toBe(4);
    expect(hitSlot(0.05, 0.2, 0)).toBe(0);
  });

  it('snaps to a coarser grid', () => {
    expect(hitSlot(4.5, 0.2, 0, 2)).toBe(6);
    expect(hitSlot(4.5, 0.2, 0, 2 / 3)).toBeCloseTo(14 / 3);
  });

  it('in a room, never lands sooner than every player can schedule it', () => {
    expect(hitSlot(4.1, 0.2, 0.3)).toBe(5);
    expect(hitSlot(4.5, 0.2, 0.3)).toBe(5);
    expect(hitSlot(4.8, 0.2, 0.3)).toBe(6);
  });
});

describe('remoteNoteSlot', () => {
  it('keeps the note on its own 16th when it arrives in time', () => {
    expect(remoteNoteSlot(8, 7.6, 0.2)).toBe(8);
  });

  it('plays a slightly late note right away', () => {
    expect(remoteNoteSlot(8, 8.1, 0.2)).toBe(8.1);
  });

  it('moves a very late note to the next 16th', () => {
    expect(remoteNoteSlot(8, 8.5, 0.2)).toBe(9);
  });
});

describe('roundTripP90', () => {
  it('skips the occasional spike', () => {
    expect(roundTripP90([])).toBeNull();
    expect(roundTripP90([10, 12, 11, 13, 10, 12, 11, 10, 12, 11, 90])).toBe(13);
  });
});

describe('swungPosition', () => {
  it('leaves straight time as it is', () => {
    for (const position of [0, 1, 2, 3, 4, 6.5, 13]) expect(swungPosition(position, 0.5)).toBeCloseTo(position);
  });

  it('plays the second 8th of each beat late and keeps the beats', () => {
    expect(swungPosition(2, 2 / 3)).toBeCloseTo(8 / 3);
    expect(swungPosition(6, 0.62)).toBeCloseTo(6.48);
    for (const beat of [0, 4, 8, 12]) expect(swungPosition(beat, 0.62)).toBeCloseTo(beat);
  });

  it('spreads the 16ths in between in proportion', () => {
    expect(swungPosition(1, 0.62)).toBeCloseTo(1.24);
    expect(swungPosition(3, 0.62)).toBeCloseTo(3.24);
  });
});
