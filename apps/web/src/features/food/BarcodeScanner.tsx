/**
 * Scan a barcode, or type the number in by hand.
 *
 * Every outcome routes into `AddFoodForm` for a human to confirm before
 * anything is written — including a clean match. One write path for the whole
 * feature, and nobody's food list gets a row they never looked at.
 *
 * The manual number field is not a fallback bolted on for browsers without a
 * camera API. It is the primary, always-available path: camera access can be
 * denied, absent, or blocked by a non-HTTPS origin, and none of that should be
 * able to take the feature down.
 */
import { useEffect, useRef, useState } from 'react';
import {
  decodeFrame,
  openCamera,
  preloadZxing,
  stopCamera,
  type CameraError,
} from '../../lib/barcode.js';
import { getFoodByBarcode } from '../../db/foods.js';
import { lookupBarcode } from '../../lib/openfoodfacts.js';
import { partialCandidateToPrefill, type Prefill } from './AddFoodForm.js';

const DECODE_INTERVAL_MS = 350;

const CAMERA_ERROR_MESSAGE: Record<CameraError, string> = {
  denied: 'Camera access was denied. You can still type the number below.',
  'no-camera': 'No camera found on this device. Type the number below.',
  'insecure-context':
    'The camera needs a secure connection (https). Type the number below — this works over plain http.',
  unavailable: 'This browser has no camera API. Type the number below.',
  unknown: 'Could not open the camera. Type the number below.',
};

export function BarcodeScanner({
  onResult,
  onCancel,
}: {
  onResult: (prefill: Prefill) => void;
  onCancel: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const deciding = useRef(false);

  const [cameraState, setCameraState] = useState<'opening' | 'scanning' | CameraError>('opening');
  const [manualBarcode, setManualBarcode] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    preloadZxing();
    let cancelled = false;
    let interval: ReturnType<typeof setInterval> | null = null;

    void openCamera().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setCameraState(result.error);
        return;
      }
      streamRef.current = result.stream;
      const video = videoRef.current;
      if (!video) {
        stopCamera(result.stream);
        return;
      }
      video.srcObject = result.stream;
      void video.play();
      setCameraState('scanning');

      interval = setInterval(() => {
        void tick();
      }, DECODE_INTERVAL_MS);
    });

    async function tick() {
      if (deciding.current || cancelled) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) return;
      deciding.current = true;
      try {
        const code = await decodeFrame(video, canvas);
        if (code && !cancelled) {
          if (interval) clearInterval(interval);
          void handleBarcode(code);
        }
      } catch {
        // A single bad frame is not worth surfacing. The next tick tries again.
      } finally {
        deciding.current = false;
      }
    }

    return () => {
      cancelled = true;
      if (interval) clearInterval(interval);
      if (streamRef.current) stopCamera(streamRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleBarcode(barcode: string) {
    if (streamRef.current) {
      stopCamera(streamRef.current);
      streamRef.current = null;
    }
    setBusy(true);
    setStatus(`Looking up ${barcode}…`);

    const existing = await getFoodByBarcode(barcode);
    if (existing) {
      onResult({
        name: existing.name,
        ...(existing.brand ? { brand: existing.brand } : {}),
        barcode,
        kcal: existing.per100g.kcal,
        proteinG: existing.per100g.proteinG,
        carbsG: existing.per100g.carbsG,
        fatG: existing.per100g.fatG,
        warning: 'Already on your list — this reopens it rather than adding a duplicate.',
      });
      return;
    }

    const result = await lookupBarcode(barcode);
    switch (result.outcome) {
      case 'found':
        onResult({
          name: result.candidate.name,
          ...(result.candidate.brand ? { brand: result.candidate.brand } : {}),
          barcode: result.candidate.barcode,
          kcal: result.candidate.per100g.kcal,
          proteinG: result.candidate.per100g.proteinG,
          carbsG: result.candidate.per100g.carbsG,
          fatG: result.candidate.per100g.fatG,
        });
        return;
      case 'suspect':
        onResult({
          name: result.candidate.name,
          ...(result.candidate.brand ? { brand: result.candidate.brand } : {}),
          barcode: result.candidate.barcode,
          kcal: result.candidate.per100g.kcal,
          proteinG: result.candidate.per100g.proteinG,
          carbsG: result.candidate.per100g.carbsG,
          fatG: result.candidate.per100g.fatG,
          warning: result.reason,
        });
        return;
      case 'incomplete':
        onResult(partialCandidateToPrefill(result.partial, result.reason));
        return;
      case 'not-found':
        setBusy(false);
        setStatus(`No match for ${barcode} on Open Food Facts.`);
        return;
      case 'error':
        setBusy(false);
        setStatus(result.reason);
        return;
    }
  }

  return (
    <section className="sheet">
      <p className="eyebrow">Scan a barcode</p>

      {cameraState === 'opening' && <p className="hint">Opening the camera…</p>}
      {cameraState !== 'opening' && cameraState !== 'scanning' && (
        <p className="hint">{CAMERA_ERROR_MESSAGE[cameraState]}</p>
      )}

      <div className="scanner-viewport" data-visible={cameraState === 'scanning'}>
        <video ref={videoRef} playsInline muted aria-label="Camera preview" />
        <div className="scanner-guide" aria-hidden="true" />
      </div>
      <canvas ref={canvasRef} hidden />

      <form
        className="scanner-manual"
        onSubmit={(e) => {
          e.preventDefault();
          const code = manualBarcode.trim();
          if (code) void handleBarcode(code);
        }}
      >
        <div className="field">
          <label htmlFor="manual-barcode">Or type the number</label>
          <input
            id="manual-barcode"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            value={manualBarcode}
            disabled={busy}
            onChange={(e) => setManualBarcode(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="e.g. 3017620422003"
          />
        </div>
        <div className="btn-row">
          <button className="btn" type="submit" disabled={busy || manualBarcode.trim() === ''}>
            Look up
          </button>
          <button className="btn" data-tone="quiet" type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>

      {status && <p className="hint">{status}</p>}
    </section>
  );
}
