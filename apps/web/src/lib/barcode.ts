/**
 * Reads a barcode from a video frame.
 *
 * `BarcodeDetector` does not exist on iOS — every iOS browser is WebKit, and
 * WebKit has never shipped it. Building against only the native API works on
 * desktop Chrome and silently fails on the one device that matters here. So:
 * feature-detect and use it when present (Android/Chrome, meaningfully
 * faster), fall back to a WASM decoder otherwise.
 *
 * The WASM fallback is `zxing-wasm/reader`, loaded lazily — most sessions on
 * Chrome never need it, and it should not cost anyone a slower first paint for
 * a codec they will never touch. Its `.wasm` binary is served from jsDelivr by
 * default, so there is no bundler configuration to get wrong; see
 * https://www.npmjs.com/package/zxing-wasm for the override hook if that ever
 * needs to change.
 */

/** Retail packaging is EAN-13/EAN-8/UPC-A/UPC-E — the EANUPC symbology root
 *  covers all four in one pass. Restricting the format list is also what
 *  makes the WASM decoder fast enough to run on every frame. */
const RETAIL_FORMATS = ['EANUPC'] as const;

export function nativeBarcodeDetectorAvailable(): boolean {
  return typeof window !== 'undefined' && 'BarcodeDetector' in window;
}

interface NativeDetectedBarcode {
  rawValue: string;
}

interface NativeBarcodeDetector {
  detect(source: CanvasImageSource): Promise<NativeDetectedBarcode[]>;
}

let nativeDetector: NativeBarcodeDetector | null = null;

async function getNativeDetector(): Promise<NativeBarcodeDetector> {
  if (nativeDetector) return nativeDetector;
  const Detector = (
    window as unknown as {
      BarcodeDetector: new (opts: { formats: readonly string[] }) => NativeBarcodeDetector;
    }
  ).BarcodeDetector;
  // Native format names are lowercase-with-underscores, unlike zxing's.
  nativeDetector = new Detector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e'] });
  return nativeDetector;
}

type ZxingReader = typeof import('zxing-wasm/reader');
let zxingModule: Promise<ZxingReader> | null = null;

function loadZxing(): Promise<ZxingReader> {
  zxingModule ??= import('zxing-wasm/reader');
  return zxingModule;
}

/** Warms the WASM module ahead of the first frame, so scanning does not stall
 *  on it. Safe to call even when the native detector ends up being used. */
export function preloadZxing(): void {
  if (!nativeBarcodeDetectorAvailable()) void loadZxing();
}

/**
 * One decode attempt against the current video frame.
 *
 * Returns null on "nothing found this frame", which is the overwhelmingly
 * common result — most frames of a camera hunting for a barcode do not
 * contain one squarely enough to read. That is not an error.
 */
export async function decodeFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
): Promise<string | null> {
  if (nativeBarcodeDetectorAvailable()) {
    const detector = await getNativeDetector();
    const found = await detector.detect(video);
    return found[0]?.rawValue ?? null;
  }

  const w = video.videoWidth;
  const h = video.videoHeight;
  if (w === 0 || h === 0) return null; // stream not ready yet

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(video, 0, 0, w, h);
  const imageData = ctx.getImageData(0, 0, w, h);

  const { readBarcodes } = await loadZxing();
  const results = await readBarcodes(imageData, {
    formats: [...RETAIL_FORMATS],
    maxNumberOfSymbols: 1,
    tryHarder: true,
  });
  return results[0]?.text ?? null;
}

export type CameraError =
  | 'no-camera'
  | 'denied'
  | 'insecure-context'
  | 'unavailable'
  | 'unknown';

/**
 * Opens the rear camera. `getUserMedia` requires a secure context — fine on
 * Vercel, refused over plain HTTP on a LAN phone test, which is a real dead
 * end worth naming precisely rather than lumping into "unknown error".
 */
export async function openCamera(): Promise<
  { ok: true; stream: MediaStream } | { ok: false; error: CameraError }
> {
  if (!window.isSecureContext) return { ok: false, error: 'insecure-context' };
  if (!navigator.mediaDevices?.getUserMedia) return { ok: false, error: 'unavailable' };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    return { ok: true, stream };
  } catch (err) {
    if (err instanceof DOMException) {
      if (err.name === 'NotAllowedError') return { ok: false, error: 'denied' };
      if (err.name === 'NotFoundError') return { ok: false, error: 'no-camera' };
    }
    return { ok: false, error: 'unknown' };
  }
}

export function stopCamera(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}
