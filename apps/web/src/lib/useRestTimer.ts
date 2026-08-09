/**
 * Rest timer.
 *
 * Driven by a wall-clock start time rather than a decremented counter, because
 * a phone locked in a pocket throttles timers to nothing and a counter would
 * come back thirty seconds slow. Reading the clock on each tick means the
 * screen is right the instant you look at it.
 *
 * It counts past zero rather than stopping, since knowing you rested 4:20 is
 * more useful than knowing you rested "more than 3:00".
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const TARGET_KEY = 'overload.restTargetSec';
const DEFAULT_TARGET_SEC = 180;

function readTarget(): number {
  const raw = Number(localStorage.getItem(TARGET_KEY));
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TARGET_SEC;
}

export interface RestTimer {
  /** Seconds left; negative once the target has passed. */
  remaining: number;
  targetSec: number;
  running: boolean;
  start: () => void;
  stop: () => void;
  adjustTarget: (deltaSec: number) => void;
}

export function useRestTimer(): RestTimer {
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [targetSec, setTargetSec] = useState(readTarget);
  const [now, setNow] = useState(() => Date.now());
  const alerted = useRef(false);

  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [startedAt]);

  const remaining = startedAt === null ? targetSec : targetSec - (now - startedAt) / 1000;

  useEffect(() => {
    if (startedAt === null || alerted.current || remaining > 0) return;
    alerted.current = true;
    // Vibration is the only signal that works with the phone face-down on a
    // bench. Both calls are best-effort: iOS Safari has neither.
    navigator.vibrate?.([120, 80, 120]);
    beep();
  }, [remaining, startedAt]);

  const start = useCallback(() => {
    alerted.current = false;
    setNow(Date.now());
    setStartedAt(Date.now());
  }, []);

  const stop = useCallback(() => setStartedAt(null), []);

  const adjustTarget = useCallback((deltaSec: number) => {
    setTargetSec((prev) => {
      const next = Math.max(30, Math.min(600, prev + deltaSec));
      localStorage.setItem(TARGET_KEY, String(next));
      alerted.current = false;
      return next;
    });
  }, []);

  return { remaining, targetSec, running: startedAt !== null, start, stop, adjustTarget };
}

/** A short tone. Wrapped because an AudioContext can be blocked or absent. */
function beep(): void {
  try {
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const ctx = new Ctor();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.value = 660;
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.36);
    osc.onended = () => void ctx.close();
  } catch {
    /* No audio. The vibration and the red clock still work. */
  }
}
