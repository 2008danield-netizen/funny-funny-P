/**
 * Where plan images live.
 *
 * -----------------------------------------------------------------------------
 * WHY THIS IS NOT PART OF THE DOCUMENT.
 *
 * A scanned floor plan is two to ten megabytes. The design document is written
 * to `localStorage` on every edit, and `localStorage` is a five-megabyte,
 * synchronous, string-only box. Putting a scan in the document therefore does
 * three bad things at once: it blows the quota, it turns every autosave into a
 * multi-megabyte string copy on the main thread, and — because a failed
 * autosave is silent — it breaks the one promise this app makes, which is that
 * you cannot lose your work.
 *
 * So the pixels go in IndexedDB, which is asynchronous, roughly a hundred times
 * larger, and stores blobs natively, and the document keeps only a key. The
 * document stays small enough to read, diff, hand to a language model, and save
 * in a millisecond.
 *
 * The cost of that choice is that images and documents can now disagree: a
 * document can name an image this browser has never seen. That is handled by
 * saying so — see `MissingImage` — rather than by pretending. Exporting bundles
 * the images back into the file, so a design you send somebody is still one
 * thing.
 * -----------------------------------------------------------------------------
 *
 * There is an in-memory fallback for environments with no IndexedDB — private
 * browsing modes that disable it, and the test runner. It behaves identically
 * and simply does not survive a reload, which is the honest degradation.
 */

const DATABASE = 'havavamama';
const STORE = 'planImages';
const VERSION = 1;

/** A stored image, as a data URL plus what the app needs to place it. */
export interface StoredImage {
  id: string;
  /** `data:image/...;base64,...` — self-contained, so it survives an export. */
  dataUrl: string;
  width: number;
  height: number;
  /** ISO timestamp, so a store cleanup can find orphans oldest-first. */
  storedAt: string;
}

/** In-memory fallback, and a read-through cache in front of IndexedDB. */
const memory = new Map<string, StoredImage>();

function newId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `img-${Date.now().toString(36)}-${random}`;
}

/* ------------------------------- IndexedDB -------------------------------- */

function openDatabase(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }

    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DATABASE, VERSION);
    } catch {
      resolve(null);
      return;
    }

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    // Blocked, denied, or corrupt: fall back to memory rather than failing the
    // import. Somebody tracing a plan would rather lose it on reload than be
    // unable to start.
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest,
): Promise<T | null> {
  const db = await openDatabase();
  if (!db) return null;

  return new Promise<T | null>((resolve) => {
    let request: IDBRequest;
    try {
      request = run(db.transaction(STORE, mode).objectStore(STORE));
    } catch {
      db.close();
      resolve(null);
      return;
    }
    request.onsuccess = () => {
      db.close();
      resolve(request.result as T);
    };
    request.onerror = () => {
      db.close();
      resolve(null);
    };
  });
}

/* --------------------------------- The API -------------------------------- */

/** Saves an image and returns its key. */
export async function putImage(
  dataUrl: string,
  width: number,
  height: number,
  id = newId(),
): Promise<string> {
  const record: StoredImage = { id, dataUrl, width, height, storedAt: new Date().toISOString() };
  memory.set(id, record);
  await withStore('readwrite', (store) => store.put(record));
  return id;
}

/** Reads an image back, or null if this browser has never seen it. */
export async function getImage(id: string): Promise<StoredImage | null> {
  const cached = memory.get(id);
  if (cached) return cached;

  const stored = await withStore<StoredImage | undefined>('readonly', (store) => store.get(id));
  if (!stored) return null;

  memory.set(id, stored);
  return stored;
}

export async function deleteImage(id: string): Promise<void> {
  memory.delete(id);
  await withStore('readwrite', (store) => store.delete(id));
}

/** Every key the store holds, for cleanup and for bundling an export. */
export async function listImageIds(): Promise<string[]> {
  const keys = await withStore<IDBValidKey[]>('readonly', (store) => store.getAllKeys());
  if (keys) return keys.map(String);
  return [...memory.keys()];
}

/**
 * Forgets images that no document refers to any more.
 *
 * Deleting a storey, or replacing its plan, leaves its scan behind. Nothing
 * breaks, but the browser's storage fills up with pictures of houses nobody is
 * drawing, and the user has no way to see or clear them.
 */
export async function forgetUnusedImages(keep: readonly string[]): Promise<number> {
  const wanted = new Set(keep.filter(Boolean));
  const all = await listImageIds();

  let removed = 0;
  for (const id of all) {
    if (wanted.has(id)) continue;
    await deleteImage(id);
    removed += 1;
  }
  return removed;
}

/** Only for tests: empties the in-memory half of the store. */
export function resetImageMemory(): void {
  memory.clear();
}

/* -------------------------------- Importing ------------------------------- */

export interface ImportedImage {
  id: string;
  dataUrl: string;
  width: number;
  height: number;
  /** True when the picture was shrunk on the way in. */
  downscaled: boolean;
}

/**
 * Brings a picture in, shrinking it if it is enormous.
 *
 * A phone photograph is twelve megapixels and a scan can be more. None of that
 * resolution helps: the picture is traced over at screen scale, and a texture
 * larger than about 4000 pixels is refused outright by some GPUs — which shows
 * up as a plan that silently fails to appear. Longest side capped, aspect kept,
 * re-encoded as JPEG unless it has transparency to preserve.
 */
export async function importImage(
  source: HTMLImageElement | HTMLCanvasElement,
  maxPixels: number,
  mime = 'image/jpeg',
): Promise<ImportedImage> {
  const naturalWidth = source instanceof HTMLCanvasElement ? source.width : source.naturalWidth;
  const naturalHeight = source instanceof HTMLCanvasElement ? source.height : source.naturalHeight;

  const longest = Math.max(naturalWidth, naturalHeight);
  const factor = longest > maxPixels ? maxPixels / longest : 1;
  const width = Math.max(1, Math.round(naturalWidth * factor));
  const height = Math.max(1, Math.round(naturalHeight * factor));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const context = canvas.getContext('2d');
  if (!context) throw new Error('This browser would not give us a 2D canvas to read the plan with.');

  // White underneath, because a PDF or a PNG with transparency otherwise comes
  // out as a black sheet with black lines on it.
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, height);

  const dataUrl = canvas.toDataURL(mime, 0.92);
  const id = await putImage(dataUrl, width, height);

  return { id, dataUrl, width, height, downscaled: factor < 1 };
}

/** Loads a data URL or object URL into an image element. */
export function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That file could not be read as an image.'));
    image.src = url;
  });
}

/** Reads a File into a data URL. */
export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}
