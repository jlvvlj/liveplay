import { useEffect, useRef } from 'react';

// The jam highway's backdrop: flying right through deep space, in black and
// greys only. A passing planet barely moves, three layers of faint stars
// stream left the nearer the faster (the nearest drawn out into streaks with
// speed), and thin speed lines rush past. It travels with the highway (`travel`, in its
// pixels), so space moves exactly as fast as the notes, and drifts on
// slowly while the song is paused. The nearest stars and the speed lines
// brighten on each beat.

interface JamSpaceProps {
  // How far the highway has scrolled (px)
  travel: number;
  // The song's clock (ms) and its beat (ms), for the pulse on each beat
  time: number;
  beatMs: number;
}

interface Star {
  x: number;
  y: number;
  r: number;
  alpha: number;
  tint: string;
  twinkle: number;
  phase: number;
  // Its own speed within its layer, so no two stars move quite alike
  speed: number;
}

// Each layer moves `depth` times as fast as the highway
const STAR_LAYERS = [
  { depth: 0.035, perPx: 0.00016, radius: [0.3, 0.65], alpha: [0.1, 0.3], twinkle: 0.5 },
  { depth: 0.11, perPx: 0.00007, radius: [0.45, 0.9], alpha: [0.18, 0.42], twinkle: 0.3 },
  { depth: 0.3, perPx: 0.00002, radius: [0.6, 1.2], alpha: [0.28, 0.55], twinkle: 0 },
];
// Whites and greys, never a color
const STAR_TINTS = ['#ffffff', '#e5e5e5', '#d4d4d4'];
const PLANET_DEPTH = 0.022;
const LINE_DEPTH = 1.5;
const LINES_PER_PX = 0.0000075;
// Space drifts this fast (highway px/s) while the song is paused
const IDLE_DRIFT = 22;
// The highway's fastest speed (px/s): streaks and speed lines are full length there
const FULL_SPEED = 600;

const rand = (min: number, max: number) => min + Math.random() * (max - min);
const wrap = (value: number, size: number) => ((value % size) + size) % size;

function makeStars(width: number, height: number, layer: (typeof STAR_LAYERS)[number]): Star[] {
  return Array.from({ length: Math.round(width * height * layer.perPx) }, () => ({
    x: Math.random() * width,
    y: Math.random() * height,
    r: rand(layer.radius[0], layer.radius[1]),
    alpha: rand(layer.alpha[0], layer.alpha[1]),
    tint: STAR_TINTS[Math.floor(Math.random() * STAR_TINTS.length)],
    twinkle: Math.random() * layer.twinkle,
    phase: Math.random() * Math.PI * 2,
    speed: rand(0.65, 1.4),
  }));
}

// A small dark planet lit from the right (where the ship is heading), in greys, with a thin ring
function makePlanet(radius: number, scale: number): HTMLCanvasElement {
  const size = radius * 3.2;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.ceil(size * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  const c = size / 2;
  // Its glow
  const halo = ctx.createRadialGradient(c, c, radius * 0.9, c, c, radius * 1.5);
  halo.addColorStop(0, 'rgba(255, 255, 255, 0.06)');
  halo.addColorStop(1, 'transparent');
  ctx.fillStyle = halo;
  ctx.fillRect(0, 0, size, size);
  // Its body, light on the right fading to night on the left
  const body = ctx.createRadialGradient(c + radius * 0.45, c - radius * 0.25, radius * 0.1, c, c, radius);
  body.addColorStop(0, '#3a3a3a');
  body.addColorStop(0.55, '#1a1a1a');
  body.addColorStop(1, '#050505');
  ctx.beginPath();
  ctx.arc(c, c, radius, 0, Math.PI * 2);
  ctx.fillStyle = body;
  ctx.fill();
  // Bands across it
  ctx.save();
  ctx.clip();
  ctx.globalAlpha = 0.1;
  for (let i = -3; i <= 3; i++) {
    ctx.fillStyle = i % 2 ? '#8a8a8a' : '#000000';
    ctx.fillRect(c - radius, c + i * radius * 0.22 - radius * 0.06, radius * 2, radius * 0.1);
  }
  ctx.restore();
  // Its ring, tilted
  ctx.save();
  ctx.translate(c, c);
  ctx.rotate(-0.28);
  ctx.scale(1, 0.24);
  ctx.beginPath();
  ctx.arc(0, 0, radius * 1.45, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
  ctx.lineWidth = radius * 0.16;
  ctx.stroke();
  ctx.restore();
  return canvas;
}

export function JamSpace({ travel, time, beatMs }: JamSpaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The highway's latest position and clock, read by the drawing loop
  const live = useRef({ travel, time, beatMs });
  live.current = { travel, time, beatMs };

  useEffect(() => {
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d')!;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let scale = 1;
    let stars: Star[][] = [];
    let lines: { x: number; y: number; length: number; alpha: number }[] = [];
    let planet: HTMLCanvasElement | null = null;
    let planetSize = 0;
    let planetY = 0;
    // Stars' tiles are a little wider than the view, so the same star never shows twice
    let tile = 0;

    const build = () => {
      const rect = canvas.getBoundingClientRect();
      width = Math.max(1, rect.width);
      height = Math.max(1, rect.height);
      scale = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      tile = width + 160;
      stars = STAR_LAYERS.map((layer) => makeStars(tile, height, layer));
      lines = Array.from({ length: Math.max(3, Math.round(tile * height * LINES_PER_PX)) }, () => ({
        x: Math.random() * tile,
        y: Math.random() * height,
        length: rand(0.5, 1),
        alpha: rand(0.03, 0.07),
      }));
      const radius = Math.max(14, Math.min(width, height) * 0.05);
      planet = makePlanet(radius, scale);
      planetSize = radius * 3.2;
      planetY = height * rand(0.22, 0.4);
    };
    build();
    const resized = new ResizeObserver(build);
    resized.observe(canvas);

    let frame = 0;
    let last = performance.now();
    let drift = 0;
    let lastTravel = live.current.travel;
    let speed = 0; // highway px/s, smoothed
    let shooting: { x: number; y: number; vx: number; vy: number; life: number } | null = null;
    let nextShooting = last + rand(6000, 14000);

    const draw = (now: number) => {
      const elapsed = (now - last) / 1000;
      const dt = Math.min(0.1, elapsed);
      last = now;
      const { travel: at, time: songTime, beatMs: beat } = live.current;
      const moved = at - lastTravel;
      lastTravel = at;
      // A jump (a seek, a restart) is not speed
      const instant = elapsed > 0 ? moved / elapsed : 0;
      speed += ((Math.abs(instant) > FULL_SPEED * 3 ? speed : instant) - speed) * Math.min(1, dt * 6);
      drift += IDLE_DRIFT * dt * (1 - Math.min(1, Math.abs(speed) / 60));
      const camera = at + drift;
      const fast = still ? 0 : Math.min(1, Math.abs(speed) / FULL_SPEED);
      const beatPhase = beat > 0 ? wrap(songTime, beat) / beat : 1;
      const pulse = fast * Math.exp(-beatPhase * 5);

      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      // Deep space: black, a shade lighter ahead (right)
      const deep = ctx.createLinearGradient(0, 0, width, 0);
      deep.addColorStop(0, '#000000');
      deep.addColorStop(1, '#0b0b0b');
      ctx.fillStyle = deep;
      ctx.fillRect(0, 0, width, height);

      // The planet passes now and then: once every four widths of travel
      if (planet) {
        const period = width * 4;
        const x = width - wrap(camera * PLANET_DEPTH + width * 0.6, period) + planetSize;
        if (x > -planetSize && x < width + planetSize) {
          ctx.globalAlpha = 0.7;
          ctx.drawImage(planet, x - planetSize / 2, planetY - planetSize / 2, planetSize, planetSize);
          ctx.globalAlpha = 1;
        }
      }

      // Stars, far to near
      const seconds = now / 1000;
      STAR_LAYERS.forEach((layer, index) => {
        const streak = index === STAR_LAYERS.length - 1 ? fast * 12 : index === 1 ? fast * 3 : 0;
        for (const star of stars[index]) {
          const x = wrap(star.x - camera * layer.depth * star.speed, tile) - 80;
          if (x < -40 || x > width + 40) continue;
          const twinkle = star.twinkle ? 1 - star.twinkle * (0.5 + 0.5 * Math.sin(seconds * 1.7 + star.phase)) : 1;
          const alpha = Math.min(1, star.alpha * twinkle * (index === 2 ? 1 + pulse * 0.4 : 1));
          ctx.globalAlpha = alpha;
          ctx.fillStyle = star.tint;
          if (streak > 1) {
            const length = streak * star.r * star.speed * star.speed;
            const gradient = ctx.createLinearGradient(x, 0, x + length, 0);
            gradient.addColorStop(0, star.tint);
            gradient.addColorStop(1, 'transparent');
            ctx.fillStyle = gradient;
            ctx.fillRect(x, star.y - star.r * 0.55, length, star.r * 1.1);
            ctx.fillStyle = star.tint;
          }
          ctx.beginPath();
          ctx.arc(x, star.y, star.r, 0, Math.PI * 2);
          ctx.fill();
          // The nearest stars glow
          if (index === 2) {
            ctx.globalAlpha = alpha * 0.12;
            ctx.beginPath();
            ctx.arc(x, star.y, star.r * 3, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      });

      // Speed lines, only while moving
      if (fast > 0.02) {
        const offset = camera * LINE_DEPTH;
        for (const line of lines) {
          const length = line.length * 150 * fast;
          const x = wrap(line.x - offset, tile) - 80;
          if (x + length < 0 || x > width) continue;
          const gradient = ctx.createLinearGradient(x, 0, x + length, 0);
          gradient.addColorStop(0, '#ffffff');
          gradient.addColorStop(1, 'transparent');
          ctx.globalAlpha = line.alpha * fast * (1 + pulse);
          ctx.fillStyle = gradient;
          ctx.fillRect(x, line.y, length, 1);
        }
      }

      // Now and then a shooting star falls across, down and back
      if (!still) {
        if (!shooting && now > nextShooting) {
          shooting = { x: rand(0.35, 1) * width, y: rand(0, 0.35) * height, vx: -rand(500, 800), vy: rand(160, 300), life: 1 };
          nextShooting = now + rand(9000, 20000);
        }
        if (shooting) {
          shooting.x += shooting.vx * dt;
          shooting.y += shooting.vy * dt;
          shooting.life -= dt * 1.4;
          const tail = 0.12;
          const gradient = ctx.createLinearGradient(shooting.x, shooting.y, shooting.x - shooting.vx * tail, shooting.y - shooting.vy * tail);
          gradient.addColorStop(0, '#ffffff');
          gradient.addColorStop(1, 'transparent');
          ctx.globalAlpha = Math.max(0, Math.sin(Math.max(0, shooting.life) * Math.PI)) * 0.8;
          ctx.strokeStyle = gradient;
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.moveTo(shooting.x, shooting.y);
          ctx.lineTo(shooting.x - shooting.vx * tail, shooting.y - shooting.vy * tail);
          ctx.stroke();
          if (shooting.life <= 0) shooting = null;
        }
      }
      ctx.globalAlpha = 1;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className="jam-space" aria-hidden="true" />;
}
