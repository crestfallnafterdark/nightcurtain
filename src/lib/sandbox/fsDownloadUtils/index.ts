/**
 * @packageDocumentation
 * Module `fsDownloadUtils`.
 * Type definitions for VirtualFS Download, Archiving, and Upload Ingestion Utilities.
 * Supports downloading individual files separately and folders/workspaces as archives (.zip or browser-native .tar.gz),
 * detecting browser compression capabilities without custom JavaScript compression engines,
 * filtering virtual directories, sanitizing export filenames, and recursively extracting dropped folder hierarchies.
 *
 * @module fsDownloadUtils
 * @invariant Leaf: zero imports (including type-only); browser platform types (`Blob`, `File`, `FileList`, `DataTransfer`) cross as data only, and engine discovery is probe-injected through the optional `scope` realm (defaulting to `globalThis`, falling back to `window`).
 * @invariant Archive engine precedence: `createArchiveBlob` uses a discovered ZIP engine exposing `createZipBlob` first, otherwise browser-native `CompressionStream('gzip')` over a POSIX.1-1988 USTAR byte array, and otherwise throws an `Error` carrying `capability = 'none'`. A discovered ZIP global without a callable `createZipBlob` is not a usable engine and falls through.
 * @invariant `downloadFolderAsArchive` never throws: a missing engine or a `createArchiveBlob` rejection resolves to a `success: false` receipt with `format: 'none'`, and an empty file list resolves to `success: true`, `filesCount: 0`, `message: 'No files to archive'`.
 * @invariant `downloadFilesSeparately` never rejects on entry-level failure: each failed entry is recorded in `BatchDownloadReceipt.failures`, remaining entries continue downloading, and `success` is `false` whenever `failures` is non-empty.
 * @invariant Download filenames are sanitized: `sanitizeDownloadFilename` maps directory separators and illegal characters to `_` and strips leading `_`; when a name sanitizes to empty (all-symbol or all-CJK names), `downloadSingleFile` falls back to the sanitized `baseName` and then to `'file.txt'`. `downloadSingleFile` throws on a missing file object or non-string `path`, while batch and archive downloads report failure in their receipts.
 * @invariant Headless/non-browser realm (`window`/`document` undefined): `triggerBrowserBlobDownload` performs no DOM access and returns `success: true` with `simulated: true`.
 */

// ============================================================================
// 1. Data Models & Capability Interfaces
// ============================================================================

/**
 * Capability descriptor representing available browser compression engines.
 *
 * @example
 * ```typescript
 * const cap: ArchiveCapability = detectArchiveCapability();
 * console.log(`Compression engine: ${cap.name} (type: ${cap.type})`);
 * ```
 */
export interface ArchiveCapability {
  /** Compression engine type: 'zip' for a discovered ZipWriter/JSZip/ZipArchive engine exposing a callable `createZipBlob` (unusable ZIP globals fall through), 'compression_stream' for native CompressionStream('gzip'), or 'none'. */
  readonly type: 'zip' | 'compression_stream' | 'none';
  /** Archive file format extension (e.g. 'zip', 'tar.gz', or 'none'). */
  readonly format: string;
  /** Human-readable engine name (e.g. 'ZIP Engine', 'Browser Native CompressionStream (GZIP)', or 'None'). */
  readonly name: string;
  /** Explanatory error message if no native archive utility is supported in this browser. */
  readonly error?: string;
  /** Resolved ambient engine handle (ZIP engine object or `CompressionStream` constructor) used by archive creation. */
  readonly engine?: unknown;
}

/**
 * Input file record structure accepted by download and archive utilities.
 *
 * @example
 * ```typescript
 * const file: FileInput = {
 *   path: '/lore/factions.json',
 *   content: '{"factions": ["Solaris", "Lunari"]}',
 *   workspaceId: 'global',
 *   updatedAt: 1726531200000,
 *   readOnly: false
 * };
 * ```
 */
export interface FileInput {
  /** Canonical virtual path of the file (e.g. '/lore/codex.json'). */
  path: string;
  /** String content or JSON-serializable object payload. */
  content?: unknown;
  /** Workspace identifier where this file resides (e.g. 'global', 'agent_writer'). */
  workspaceId?: string;
  /** Millisecond epoch timestamp of last modification. */
  updatedAt?: number;
  /** Whether the file has read-only protection. */
  readOnly?: boolean;
}

/**
 * Receipt confirming triggering of a single file browser download.
 *
 * @example
 * ```typescript
 * const receipt: DownloadReceipt = downloadSingleFile({ path: '/lore/world.md', content: '# World' });
 * console.log(`Downloaded ${receipt.filename} (${receipt.size} bytes)`);
 * ```
 */
export interface DownloadReceipt {
  /** Indicates whether the download was successfully initiated. */
  readonly success: boolean;
  /** Sanitized local filename used for the browser download. */
  readonly filename: string;
  /** Total byte size of the downloaded file. */
  readonly size: number;
  /** If true, indicates download was simulated in non-browser / headless environment. */
  readonly simulated?: boolean;
}

/**
 * Descriptor of a single entry that failed while processing a batch download.
 *
 * @example
 * ```typescript
 * const failure: BatchDownloadFailure = { index: 2, path: '/lore/broken.json', error: 'Valid file object with path property is required for downloadSingleFile' };
 * console.error(`Entry ${failure.index} (${failure.path ?? '<invalid>'}) failed: ${failure.error}`);
 * ```
 */
export interface BatchDownloadFailure {
  /** Zero-based position of the failed entry in the input list. */
  readonly index: number;
  /** Path of the failed entry when the entry exposed a string `path`, otherwise `null`. */
  readonly path: string | null;
  /** Error message describing why the entry could not be downloaded. */
  readonly error: string;
}

/**
 * Receipt summarizing sequential execution of multiple file downloads.
 *
 * Failed entries are reported in `failures` instead of rejecting the batch.
 *
 * @example
 * ```typescript
 * const receipt: BatchDownloadReceipt = await downloadFilesSeparately(files);
 * console.log(`Downloaded ${receipt.count} files separately.`);
 * if (receipt.failures.length > 0) {
 *   console.warn(`${receipt.failures.length} entries failed.`);
 * }
 * ```
 */
export interface BatchDownloadReceipt {
  /** Indicates whether every entry in the batch downloaded successfully. */
  readonly success: boolean;
  /** Total number of files successfully downloaded. */
  readonly count: number;
  /** List of successfully downloaded filenames. */
  readonly files: string[];
  /** Per-entry failures captured while processing the batch; empty when every entry succeeded. */
  readonly failures: BatchDownloadFailure[];
}

/**
 * Result of programmatically creating a compressed archive `Blob` in memory.
 *
 * @example
 * ```typescript
 * const archive: ArchiveBlobResult = await createArchiveBlob(files, { archiveName: 'story_backup' });
 * console.log(`Generated ${archive.filename} (${archive.format}) using ${archive.capability}`);
 * ```
 */
export interface ArchiveBlobResult {
  /** Binary archive Blob instance (.zip or .tar.gz). */
  readonly blob: Blob;
  /** Proposed archive filename with extension (e.g. 'fs_export.tar.gz'). */
  readonly filename: string;
  /** Archive format identifier ('zip' or 'tar.gz'). */
  readonly format: string;
  /** Compression capability type utilized ('zip' or 'compression_stream'). */
  readonly capability: string;
}

/**
 * Receipt confirming packaging and triggering of a workspace/folder archive download.
 *
 * @example
 * ```typescript
 * const receipt: ArchiveDownloadReceipt = await downloadFolderAsArchive(files, { archiveName: 'lore_export' });
 * if (receipt.success) {
 *   console.log(`Exported ${receipt.filesCount} files in ${receipt.filename}`);
 * } else {
 *   console.error(`Export failed: ${receipt.error}`);
 * }
 * ```
 */
export interface ArchiveDownloadReceipt {
  /** Indicates whether archive creation and download succeeded. */
  readonly success: boolean;
  /** Generated archive filename. */
  readonly filename?: string;
  /** Archive format used ('zip' or 'tar.gz'), or 'none' when no archive is produced (empty input or failure). */
  readonly format?: string;
  /** Compression capability attempted or utilized ('zip' or 'compression_stream'), or 'none' when no archive engine was detected. On a `createArchiveBlob` rejection this echoes the attempted engine while `format` is `'none'`. */
  readonly capability?: string;
  /** Error message if archiving failed. */
  readonly error?: string;
  /** Informational message (e.g. 'No files to archive' when the input list is empty). */
  readonly message?: string;
  /** Number of input records; on success, the files included in the archive. */
  readonly filesCount: number;
}

/**
 * Normalized file item extracted from browser file inputs or drag-and-drop events.
 * Ready for immediate ingestion into VirtualFS.
 *
 * @example
 * ```typescript
 * const records: UploadedFileRecord[] = await processUploadedFiles(fileList);
 * for (const rec of records) {
 *   virtualFs.writeFile(rec.path, rec.content);
 * }
 * ```
 */
export interface UploadedFileRecord {
  /** Normalized virtual absolute path starting with leading slash (e.g. '/config.json'). */
  readonly path: string;
  /** Text content of the uploaded file. */
  readonly content: string;
  /** Resolved size: explicit wrapper `size` override, wrapped file handle byte size, or `content.length` (UTF-16 code units) when neither is available. */
  readonly size: number;
  /** Original filename from the client filesystem. */
  readonly originalName: string;
}

// ============================================================================
// 2. Options Interfaces
// ============================================================================

/**
 * Options for processing uploaded files from browser inputs.
 *
 * @example
 * ```typescript
 * const opts: ProcessUploadOptions = {
 *   baseDir: '/imported_data',
 *   onProgress: (cur, total, path) => console.log(`Importing ${cur}/${total}: ${path}`)
 * };
 * ```
 */
export interface ProcessUploadOptions {
  /** Virtual base directory prefix to prepend to uploaded file paths (defaults to '/'; trailing slashes are stripped and a blank file name yields '/unnamed_file'). */
  baseDir?: string;
  /** Progress callback invoked per emitted record with its position in the input list; skipped falsy entries do not fire it. */
  onProgress?: (current: number, total: number, path: string) => void;
}

/**
 * Options for single file browser download.
 *
 * @example
 * ```typescript
 * const opts: DownloadFilesOptions = {
 *   prefixWorkspace: true
 * };
 * ```
 */
export interface DownloadFilesOptions {
  /** Whether to prepend the workspace ID to the downloaded filename (defaults to false for single-file downloads and true for batch downloads). */
  prefixWorkspace?: boolean;
}

/**
 * Options for multi-file batch downloading with polite throttling.
 *
 * @example
 * ```typescript
 * const opts: BatchDownloadFilesOptions = {
 *   delayMs: 150,
 *   prefixWorkspace: true,
 *   onProgress: (done, total, name) => console.log(`Downloaded ${done}/${total}: ${name}`)
 * };
 * ```
 */
export interface BatchDownloadFilesOptions extends DownloadFilesOptions {
  /** Delay in milliseconds inserted between consecutive browser downloads (non-numeric values default to 120ms; zero or negative values skip delays). */
  delayMs?: number;
  /** Progress callback invoked after each file is triggered for download. */
  onProgress?: (downloaded: number, total: number, filename: string) => void;
}

/**
 * Options for archive creation and folder downloads.
 *
 * @example
 * ```typescript
 * const opts: CreateArchiveOptions = {
 *   archiveName: 'lore_backup',
 *   baseFolder: 'lore'
 * };
 * ```
 */
export interface CreateArchiveOptions {
  /** Base filename for the archive without extension (defaults to 'fs_export'); sanitized before use. */
  archiveName?: string;
  /** Optional root directory prefix inside the archive structure (defaults to ''). */
  baseFolder?: string;
}

// ============================================================================
// 3. Exported Subsystem Functions
// ============================================================================

type ZipEngineProbe = {
  createZipBlob: (...args: unknown[]) => Blob | Promise<Blob>;
};

type CompressionStreamConstructor = new (format: string) => CompressionStream;

type ArchiveProbeRealm = {
  ZipWriter?: ZipEngineProbe;
  zip?: { ZipWriter?: ZipEngineProbe };
  JSZip?: ZipEngineProbe;
  ZipArchive?: ZipEngineProbe;
  CompressionStream?: CompressionStreamConstructor;
};

function isZipEngine(value: unknown): value is ZipEngineProbe {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  return 'createZipBlob' in value && typeof value.createZipBlob === 'function';
}

function isCompressionStreamConstructor(value: unknown): value is CompressionStreamConstructor {
  return typeof value === 'function';
}

function errorMessage(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = err.message;
    return typeof message === 'string' ? message : undefined;
  }
  return undefined;
}

/**
 * Detects available archiving / compression capabilities in the current environment.
 * Checks for a usable global/window ZIP engine (one exposing a callable `createZipBlob`),
 * then browser-native `CompressionStream('gzip')`, or reports capability failure.
 *
 * @param scope - Optional ambient realm to probe for ZIP / `CompressionStream` engines (defaults to `globalThis`, falling back to `window`).
 * @returns Capability descriptor object.
 *
 * @example
 * ```typescript
 * const cap = detectArchiveCapability();
 * if (cap.type === 'none') {
 *   console.warn('Archiving not supported in this browser:', cap.error);
 * } else {
 *   console.log(`Archive engine available: ${cap.name} (.${cap.format})`);
 * }
 *
 * // Dependency-injected engine scope (e.g. for headless/testing realms)
 * const injected = detectArchiveCapability({ CompressionStream: FakeCompressionStream });
 * ```
 */
export function detectArchiveCapability(scope?: object): ArchiveCapability {
  // 1. Check for environment / browser ZIP capabilities
  const g = (scope !== undefined && scope !== null
    ? scope
    : (typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : {}))) as ArchiveProbeRealm;

  const zipEngine = g.ZipWriter || g.zip?.ZipWriter || g.JSZip || g.ZipArchive;
  if (zipEngine && typeof zipEngine.createZipBlob === 'function') {
    return {
      type: 'zip',
      format: 'zip',
      name: 'ZIP Engine',
      engine: zipEngine
    };
  }

  // 2. Check for browser-native CompressionStream
  if (typeof g.CompressionStream === 'function') {
    try {
      // Validate gzip support
      new g.CompressionStream('gzip');
      return {
        type: 'compression_stream',
        format: 'tar.gz',
        name: 'Browser Native CompressionStream (GZIP)',
        engine: g.CompressionStream
      };
    } catch {
      // Fall through if instantiation fails
    }
  }

  // 3. Nothing available
  return {
    type: 'none',
    format: 'none',
    name: 'None',
    error: 'No native archiving or compression utility is available in this browser environment.'
  };
}

/**
 * Resolves standard MIME type based on a file path's extension.
 *
 * @param filePath - File path or filename (e.g. '/lore/codex.json'); defaults to `''`.
 * @returns MIME type string (e.g. 'application/json;charset=utf-8'); unrecognized or missing extensions resolve to 'application/octet-stream'.
 *
 * @example
 * ```typescript
 * getMimeType('/data/codex.json'); // 'application/json;charset=utf-8'
 * getMimeType('/readme.md');        // 'text/markdown;charset=utf-8'
 * getMimeType('/binary.dat');       // 'application/octet-stream'
 * ```
 */
export function getMimeType(filePath: string = ''): string {
  const ext = String(filePath).split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'json':
      return 'application/json;charset=utf-8';
    case 'md':
    case 'markdown':
      return 'text/markdown;charset=utf-8';
    case 'txt':
    case 'log':
      return 'text/plain;charset=utf-8';
    case 'js':
    case 'mjs':
      return 'application/javascript;charset=utf-8';
    case 'html':
    case 'htm':
      return 'text/html;charset=utf-8';
    case 'css':
      return 'text/css;charset=utf-8';
    case 'csv':
      return 'text/csv;charset=utf-8';
    case 'xml':
      return 'application/xml;charset=utf-8';
    case 'svg':
      return 'image/svg+xml;charset=utf-8';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Sanitizes a string for use as a local operating system download filename.
 * Strips directory separators and illegal characters.
 *
 * @param name - Raw filename string; `null` and `undefined` are treated as `''`.
 * @returns Sanitized filename safe for OS filesystem storage.
 *
 * @example
 * ```typescript
 * sanitizeDownloadFilename('lore/world/../map:v1?.json'); // 'lore_world_.._map_v1_.json'
 * ```
 */
export function sanitizeDownloadFilename(name: string = ''): string {
  return String(name || '')
    .replace(/[\\/]/g, '_')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .replace(/^_+/, '');
}

/**
 * Low-level browser anchor click simulation for triggering client download of a generated Blob.
 *
 * @param data - Blob or Uint8Array payload to download.
 * @param filename - Local filename to propose in download dialog.
 * @param mimeType - Optional MIME type override (defaults to 'application/octet-stream').
 * @returns Download receipt; when `window` or `document` are unavailable, no DOM access occurs and the receipt carries `success: true` and `simulated: true`.
 *
 * @example
 * ```typescript
 * const blob = new Blob(['Hello world'], { type: 'text/plain' });
 * triggerBrowserBlobDownload(blob, 'hello.txt', 'text/plain');
 * ```
 */
export function triggerBrowserBlobDownload(data: Blob | Uint8Array, filename: string, mimeType: string = 'application/octet-stream'): DownloadReceipt {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    const sizeSource: { length?: number, size?: number } = data;
    return { success: true, simulated: true, filename, size: sizeSource?.length || sizeSource?.size || 0 };
  }

  const blob = data instanceof Blob ? data : new Blob([data as BlobPart], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  if (anchor.style) {
    anchor.style.display = 'none';
  }
  document.body.appendChild(anchor);
  anchor.click();

  setTimeout(() => {
    if (document.body.contains(anchor)) {
      document.body.removeChild(anchor);
    }
    URL.revokeObjectURL(url);
  }, 200);

  return { success: true, filename, size: blob.size };
}

/**
 * Exports and downloads an individual virtual file directly through the browser.
 *
 * @param file - File object containing path and content.
 * @param options - Download options.
 * @returns Download receipt confirming filename and byte size.
 * @throws `Error` - If `file` is missing or lacks a valid `path`.
 *
 * @example
 * ```typescript
 * const receipt = downloadSingleFile({
 *   path: '/lore/world_map.json',
 *   content: { continents: ['Eldoria', 'Valen'] },
 *   workspaceId: 'global'
 * }, { prefixWorkspace: true });
 * console.log(`Saved ${receipt.filename}`);
 * ```
 */
export function downloadSingleFile(file: FileInput, options: DownloadFilesOptions = {}): DownloadReceipt {
  if (!file || typeof file.path !== 'string') {
    throw new Error('Valid file object with path property is required for downloadSingleFile');
  }

  const rawContent = file.content !== undefined ? file.content : '';
  const contentStr = typeof rawContent === 'object' && rawContent !== null
    ? JSON.stringify(rawContent, null, 2)
    : String(rawContent);

  const cleanPath = file.path.replace(/^\/+/, '');
  const baseName = cleanPath.split('/').pop() || 'file.txt';
  const wsPrefix = options.prefixWorkspace && file.workspaceId ? `${file.workspaceId}_` : '';
  const filename = sanitizeDownloadFilename(`${wsPrefix}${cleanPath.replace(/\//g, '_')}`)
    || sanitizeDownloadFilename(baseName)
    || 'file.txt';

  const mimeType = getMimeType(file.path);
  const blob = new Blob([contentStr], { type: mimeType });

  return triggerBrowserBlobDownload(blob, filename, mimeType);
}

/**
 * Sequentially downloads multiple files with polite delays between downloads to avoid browser throttling.
 *
 * @param files - Array of virtual file input records.
 * @param options - Batch options including delayMs and onProgress callback.
 * @returns Promise resolving to a batch download summary receipt; an empty or non-array `files` list resolves to `{ success: true, count: 0, files: [], failures: [] }`. Never rejects on entry-level failure: failed entries are collected in `failures`, remaining entries continue, and `success` is `false` when `failures` is non-empty.
 *
 * @example
 * ```typescript
 * const batchReceipt = await downloadFilesSeparately(filesList, {
 *   delayMs: 120,
 *   prefixWorkspace: true,
 *   onProgress: (current, total, filename) => {
 *     console.log(`Downloading ${current}/${total}: ${filename}`);
 *   }
 * });
 * console.log(`Downloaded ${batchReceipt.count} files.`);
 * for (const failure of batchReceipt.failures) {
 *   console.warn(`Entry ${failure.index} failed: ${failure.error}`);
 * }
 * ```
 */
export async function downloadFilesSeparately(files: FileInput[] = [], options: BatchDownloadFilesOptions = {}): Promise<BatchDownloadReceipt> {
  if (!Array.isArray(files) || files.length === 0) {
    return { success: true, count: 0, files: [], failures: [] };
  }

  const delayMs = typeof options.delayMs === 'number' ? options.delayMs : 120;
  const downloadedFiles: string[] = [];
  const failures: BatchDownloadFailure[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    let receipt: DownloadReceipt | null = null;

    try {
      receipt = downloadSingleFile(file, {
        prefixWorkspace: options.prefixWorkspace !== false
      });
    } catch (err) {
      failures.push({
        index: i,
        path: file && typeof file.path === 'string' ? file.path : null,
        error: err instanceof Error ? err.message : String(err)
      });
    }

    if (receipt) {
      downloadedFiles.push(receipt.filename || file.path);

      if (typeof options.onProgress === 'function') {
        options.onProgress(i + 1, files.length, receipt.filename || file.path);
      }
    }

    if (i < files.length - 1 && delayMs > 0) {
      await new Promise<void>(r => setTimeout(r, delayMs));
    }
  }

  return {
    success: failures.length === 0,
    count: downloadedFiles.length,
    files: downloadedFiles,
    failures
  };
}

/**
 * Creates a standard 512-byte POSIX USTAR TAR header block.
 * (Pure binary layout conforming to POSIX.1-1988 USTAR standard; no compression in JS).
 *
 * @param relativePath - Relative path inside archive (e.g. 'global/data.json')
 * @param byteLength - Size of file in bytes
 * @param mode - File permissions (defaults to 0o644)
 * @param mtime - Modification timestamp in seconds
 * @returns 512-byte header block
 */
function createTarHeader(relativePath: string, byteLength: number, mode: number = 0o644, mtime: number = Math.floor(Date.now() / 1000)): Uint8Array {
  const header = new Uint8Array(512);
  const encoder = new TextEncoder();

  // Normalize path without leading slash
  const normPath = String(relativePath).replace(/^\/+/, '');
  const pathBytes = encoder.encode(normPath);

  if (pathBytes.length <= 100) {
    header.set(pathBytes, 0);
  } else {
    // POSIX.1-1988 USTAR path splitting: find slash separator such that prefix <= 155 and name <= 100
    let splitIdx = -1;
    for (let i = normPath.length - 1; i >= 0; i--) {
      if (normPath[i] === '/') {
        const prefix = normPath.slice(0, i);
        const name = normPath.slice(i + 1);
        const pLen = encoder.encode(prefix).length;
        const nLen = encoder.encode(name).length;
        if (pLen > 0 && pLen <= 155 && nLen > 0 && nLen <= 100) {
          splitIdx = i;
          break;
        }
      }
    }

    if (splitIdx !== -1) {
      const prefix = normPath.slice(0, splitIdx);
      const name = normPath.slice(splitIdx + 1);
      header.set(encoder.encode(name), 0);
      header.set(encoder.encode(prefix), 345);
    } else {
      // Fallback if no valid slash split fits constraints: truncate to 100 bytes
      header.set(pathBytes.subarray(0, 100), 0);
    }
  }

  // File Mode (8 bytes: 6 octal digits + space + null)
  const modeStr = mode.toString(8).padStart(6, '0') + ' \0';
  header.set(encoder.encode(modeStr), 100);

  // UID & GID (8 bytes each)
  header.set(encoder.encode('0000000\0'), 108);
  header.set(encoder.encode('0000000\0'), 116);

  // File size in bytes (12 bytes: 11 octal digits + space)
  const sizeStr = byteLength.toString(8).padStart(11, '0') + ' ';
  header.set(encoder.encode(sizeStr), 124);

  // MTime (12 bytes: 11 octal digits + space)
  const mtimeStr = mtime.toString(8).padStart(11, '0') + ' ';
  header.set(encoder.encode(mtimeStr), 136);

  // Type flag: '0' for regular file (byte index 156)
  header[156] = 48; // '0'

  // Magic 'ustar\0' (6 bytes) + version '00' (2 bytes)
  header.set(encoder.encode('ustar\0'), 257);
  header.set(encoder.encode('00'), 263);

  // Checksum calculation: fill checksum field (bytes 148..155) with 8 spaces (0x20)
  header.set(encoder.encode('        '), 148);
  let checksum = 0;
  for (let i = 0; i < 512; i++) {
    checksum += header[i];
  }

  // Checksum (8 bytes: 6 octal digits + null + space)
  const chkStr = checksum.toString(8).padStart(6, '0') + '\0 ';
  header.set(encoder.encode(chkStr), 148);

  return header;
}

/**
 * Builds an uncompressed POSIX USTAR TAR byte array from a list of files.
 *
 * @param filesList - Virtual file records to pack
 * @param options - Archive structure options
 * @returns Packed TAR byte array
 */
function createTarByteArray(filesList: FileInput[] = [], options: CreateArchiveOptions = {}): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  for (const file of filesList) {
    const rawContent = file.content !== undefined ? file.content : '';
    const contentStr = typeof rawContent === 'object' && rawContent !== null
      ? JSON.stringify(rawContent, null, 2)
      : String(rawContent);
    const contentBytes = encoder.encode(contentStr);

    const cleanPath = file.path.replace(/^\/+/, '');
    const ws = file.workspaceId ? `${file.workspaceId}/` : '';
    const base = options.baseFolder ? `${options.baseFolder.replace(/^\/+|\/+$/g, '')}/` : '';
    const archivePath = `${base}${ws}${cleanPath}`.replace(/^\/+/, '');

    const mode = file.readOnly ? 0o444 : 0o644;
    const mtime = file.updatedAt ? Math.floor(file.updatedAt / 1000) : Math.floor(Date.now() / 1000);

    // 1. 512-byte header
    const header = createTarHeader(archivePath, contentBytes.length, mode, mtime);
    parts.push(header);

    // 2. File content bytes
    if (contentBytes.length > 0) {
      parts.push(contentBytes);
      // 3. 512-byte block padding
      const pad = (512 - (contentBytes.length % 512)) % 512;
      if (pad > 0) {
        parts.push(new Uint8Array(pad));
      }
    }
  }

  // Two 512-byte zero blocks at the end of archive (1024 bytes)
  parts.push(new Uint8Array(1024));

  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const tarBytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    tarBytes.set(part, offset);
    offset += part.length;
  }

  return tarBytes;
}

/**
 * Generates a standard archive `Blob` (.zip or .tar.gz) without triggering an immediate browser download.
 * Enables programmatic ingestion, export modal previews, or external cloud storage.
 *
 * Invariants:
 * 1. Uses the discovered ZIP engine only when it exposes `createZipBlob`.
 * 2. Falls back to browser-native `CompressionStream('gzip')` with POSIX.1-1988 USTAR TAR byte packing when no usable ZIP engine is present.
 * 3. Throws an `Error` with `capability = 'none'` if neither path is available.
 *
 * @param files - Array of virtual file input records.
 * @param options - Archive naming and structure options.
 * @param scope - Optional ambient realm to probe for archiving engines (defaults to `globalThis`, falling back to `window`).
 * @returns Promise resolving to archive Blob result.
 * @throws `Error` - If no native archiving or compression utility is available.
 *
 * @example
 * ```typescript
 * const result = await createArchiveBlob(files, {
 *   archiveName: 'campaign_backup',
 *   baseFolder: 'campaign_1'
 * });
 * console.log(`Created ${result.format} blob of ${result.blob.size} bytes`);
 * ```
 */
export async function createArchiveBlob(files: FileInput[] = [], options: CreateArchiveOptions = {}, scope?: object): Promise<ArchiveBlobResult> {
  const capability = detectArchiveCapability(scope);
  const archiveName = sanitizeDownloadFilename(options.archiveName || 'fs_export') || 'fs_export';

  if (capability.type === 'zip') {
    // Environment Zip engine available
    const engine = capability.engine;
    if (isZipEngine(engine)) {
      const blob = await engine.createZipBlob(files, options);
      return {
        blob,
        filename: `${archiveName}.zip`,
        format: 'zip',
        capability: capability.type
      };
    }
  }

  if (capability.type === 'compression_stream' && isCompressionStreamConstructor(capability.engine)) {
    // Browser-native CompressionStream ('gzip')
    const tarBytes = createTarByteArray(files, options);
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(tarBytes);
        controller.close();
      }
    });

    const CompressedStreamClass = capability.engine;
    const compressedStream = stream.pipeThrough<Uint8Array>(new CompressedStreamClass('gzip'));

    const chunks: Uint8Array[] = [];
    const reader = compressedStream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const totalLen = chunks.reduce((a, b) => a + b.length, 0);
    const compressedBytes = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      compressedBytes.set(chunk, offset);
      offset += chunk.length;
    }

    const blob = new Blob([compressedBytes], { type: 'application/gzip' });
    return {
      blob,
      filename: `${archiveName}.tar.gz`,
      format: 'tar.gz',
      capability: capability.type
    };
  }

  // Nothing available in browser
  const err: Error & { capability?: string } = new Error(capability.error || 'No native archiving utility is available in this browser environment.');
  err.capability = 'none';
  throw err;
}

/**
 * High-level workspace or folder download bundling virtual files into a compressed archive (.zip or .tar.gz).
 * Gracefully reports failure in the returned receipt when no native archiving utility is supported.
 *
 * Never rejects: an empty or non-array `files` list resolves to `{ success: true, filesCount: 0, format: 'none', message: 'No files to archive' }`,
 * and a missing archiving engine or a `createArchiveBlob` rejection resolves to a `success: false` receipt carrying `error`, `format: 'none'`, and the input `filesCount`.
 *
 * @param files - Array of virtual file input records.
 * @param options - Archive options.
 * @param scope - Optional ambient realm to probe for archiving engines (defaults to `globalThis`, falling back to `window`).
 * @returns Promise resolving to an archive download receipt.
 *
 * @example
 * ```typescript
 * const receipt = await downloadFolderAsArchive(filesList, {
 *   archiveName: 'global_lore'
 * });
 * if (receipt.success) {
 *   console.log(`Archived ${receipt.filesCount} files into ${receipt.filename}`);
 * } else {
 *   console.error(`Archive export failed: ${receipt.error}`);
 * }
 * ```
 */
export async function downloadFolderAsArchive(files: FileInput[] = [], options: CreateArchiveOptions = {}, scope?: object): Promise<ArchiveDownloadReceipt> {
  if (!Array.isArray(files) || files.length === 0) {
    return {
      success: true,
      filesCount: 0,
      format: 'none',
      message: 'No files to archive'
    };
  }

  const capability = detectArchiveCapability(scope);
  if (capability.type === 'none') {
    return {
      success: false,
      filesCount: files.length,
      capability: 'none',
      format: 'none',
      error: capability.error || 'No native archiving utility is available in this browser.'
    };
  }

  try {
    const { blob, filename, format } = await createArchiveBlob(files, options, scope);
    triggerBrowserBlobDownload(blob, filename, format === 'zip' ? 'application/zip' : 'application/gzip');
    return {
      success: true,
      filename,
      format,
      capability: capability.type,
      filesCount: files.length
    };
  } catch (err) {
    return {
      success: false,
      filesCount: files.length,
      capability: capability.type,
      error: errorMessage(err) || 'Archiving failed',
      format: 'none'
    };
  }
}

/**
 * Filters a list of files by virtual directory prefix for folder-level operations.
 *
 * @param files - Array of file items.
 * @param folderPath - Directory path prefix (e.g. '/lore' or 'models/'); defaults to '/', which returns a shallow copy of all files.
 * @returns Filtered array of matching file items; a file matches when its normalized path equals the prefix or starts with the prefix plus '/'.
 *
 * @example
 * ```typescript
 * const loreFiles = filterFilesByFolder(allFiles, '/lore');
 * console.log(`Found ${loreFiles.length} files under /lore`);
 * ```
 */
export function filterFilesByFolder(files: FileInput[] = [], folderPath: string = '/'): FileInput[] {
  if (!Array.isArray(files)) return [];
  const norm = String(folderPath || '/').trim();
  if (norm === '' || norm === '/') return [...files];

  const prefix = norm.startsWith('/') ? norm : '/' + norm;
  const withSlash = prefix.endsWith('/') ? prefix : prefix + '/';

  return files.filter(f => {
    const p = f.path.startsWith('/') ? f.path : '/' + f.path;
    return p === prefix || p.startsWith(withSlash);
  });
}

/**
 * Checks whether the browser environment supports directory/folder uploads via HTML file inputs (`webkitdirectory` or the legacy `directory` attribute).
 *
 * @returns True if folder uploads are supported, false otherwise.
 *
 * @example
 * ```typescript
 * if (isFolderUploadSupported()) {
 *   // Enable "Upload Folder" button in UI
 * }
 * ```
 */
export function isFolderUploadSupported(): boolean {
  if (typeof HTMLInputElement === 'undefined') return false;
  return 'webkitdirectory' in HTMLInputElement.prototype || 'directory' in HTMLInputElement.prototype;
}

type UploadItemLike = {
  file?: File | Blob;
  path?: string;
  content?: string;
  size?: number;
  name?: string;
  webkitRelativePath?: string;
  text?: () => Promise<string>;
};

function readStringMember(source: unknown, key: string): string | undefined {
  if (source === null || (typeof source !== 'object' && typeof source !== 'function')) return undefined;
  if (!(key in source)) return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read a browser File object as text string.
 *
 * @param file - Browser file or blob handle
 * @returns File text content
 */
async function readFileAsText(file: File | Blob | UploadItemLike | null | undefined): Promise<string> {
  if (!file) return '';
  if (typeof file.text === 'function') {
    return await file.text();
  }
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
    reader.readAsText(file as Blob);
  });
}

/**
 * Normalizes an uploaded file path to a valid virtual absolute path (e.g. '/config.json').
 *
 * @param rawPath - Raw relative path
 * @param baseDir - Virtual base directory prefix
 * @returns Normalized virtual absolute path
 */
function normalizeUploadVirtualPath(rawPath: string = '', baseDir: string = '/'): string {
  const cleanBase = String(baseDir || '/').trim().replace(/\/+$/, '');
  const cleanRaw = String(rawPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');

  if (!cleanRaw) return '/unnamed_file';

  if (!cleanBase || cleanBase === '/') {
    return `/${cleanRaw}`;
  }
  return `${cleanBase}/${cleanRaw}`;
}

/**
 * Normalizes and reads browser `File`, `FileList`, or file drop items into clean virtual file records ready for `VirtualFS.writeFile`.
 *
 * @param filesInput - Browser `FileList`, `File[]`, or wrapped file records.
 * @param options - Base directory and progress tracking options.
 * @returns Promise resolving to array of normalized virtual file records; an empty input resolves to `[]`, and falsy entries are skipped.
 *
 * @example
 * ```typescript
 * const records = await processUploadedFiles(fileInputElement.files, {
 *   baseDir: '/uploads',
 *   onProgress: (cur, total, path) => console.log(`Processed ${cur}/${total}: ${path}`)
 * });
 * for (const rec of records) {
 *   virtualFs.writeFile(rec.path, rec.content);
 * }
 * ```
 */
export async function processUploadedFiles(
  filesInput:
    | FileList
    | Array<
        | File
        | Blob
        | {
            /** Wrapped browser file handle. When present, the handle supplies fallback content, size, and name fields. */
            file?: File | Blob;
            /** Explicit virtual path override (defaults to `file.webkitRelativePath`, `file.name`, or a generated name). */
            path?: string;
            /** Pre-read text content; takes precedence over content read from a `file` handle. */
            content?: string;
            /** Numeric size override; takes precedence over the `file` handle size, otherwise resolves from the handle byte size or the string `content.length` (UTF-16 code units). */
            size?: number;
            /** Filename fallback used when the item is not a `File`/`Blob` instance. */
            name?: string;
            /** Folder-relative path fallback for directory uploads. */
            webkitRelativePath?: string;
          }
      >,
  options: ProcessUploadOptions = {}
): Promise<UploadedFileRecord[]> {
  const list: UploadItemLike[] = Array.isArray(filesInput) ? filesInput : Array.from(filesInput || []);
  if (list.length === 0) return [];

  const baseDir = options.baseDir || '/';
  const processed: UploadedFileRecord[] = [];

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    const file: File | Blob | UploadItemLike = item?.file ? item.file : item;
    const explicitPath = typeof item?.path === 'string' ? item.path : null;

    if (!file) continue;

    const fileName = readStringMember(file, 'name');
    // Use explicit path, or webkitRelativePath for folder uploads, or file.name for single files
    const relativePath = explicitPath
      || readStringMember(file, 'webkitRelativePath')
      || fileName
      || `file_${i}`;
    const virtualPath = normalizeUploadVirtualPath(relativePath, baseDir);
    const content = typeof item?.content === 'string'
      ? item.content
      : (readStringMember(file, 'content') ?? await readFileAsText(file));
    const explicitSize = typeof item?.size === 'number' ? item.size : undefined;

    processed.push({
      path: virtualPath,
      content,
      size: explicitSize !== undefined
        ? explicitSize
        : (file.size !== undefined ? file.size : content.length),
      originalName: fileName || relativePath
    });

    if (typeof options.onProgress === 'function') {
      options.onProgress(i + 1, list.length, virtualPath);
    }
  }

  return processed;
}

type FileSystemEntryLike = {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file(success: (file: File) => void, failure: (error: unknown) => void): void;
  createReader(): {
    readEntries(
      success: (entries: FileSystemEntryLike[]) => void,
      failure: (error: unknown) => void
    ): void;
  };
};

/**
 * Recursively extracts all files from a `DataTransfer` object (drag & drop events),
 * traversing directories via the FileSystemEntry API when available.
 *
 * @param dataTransfer - Browser DataTransfer object from drag-and-drop event.
 * @param _options - Reserved for future extraction options; the current traversal ignores it.
 * @returns Promise resolving to array of extracted File objects with relative paths.
 *
 * @example
 * ```typescript
 * dropZone.addEventListener('drop', async (e) => {
 *   e.preventDefault();
 *   const extracted = await extractFilesFromDataTransfer(e.dataTransfer);
 *   const records = await processUploadedFiles(extracted);
 *   console.log(`Extracted ${records.length} files from drop.`);
 * });
 * ```
 */
export async function extractFilesFromDataTransfer(dataTransfer: DataTransfer, _options: object = {}): Promise<Array<{ file: File; path: string }>> {
  if (!dataTransfer) return [];

  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const results: Array<{ file: File; path: string }> = [];

  // 1. Try modern FileSystemEntry / webkitGetAsEntry traversal
  const entries: FileSystemEntryLike[] = [];
  for (const item of items) {
    if (typeof item.webkitGetAsEntry === 'function') {
      const entry = item.webkitGetAsEntry();
      if (entry) entries.push(entry as unknown as FileSystemEntryLike);
    }
  }

  if (entries.length > 0) {
    async function traverseEntry(entry: FileSystemEntryLike, pathPrefix = ''): Promise<void> {
      if (entry.isFile) {
        const file = await new Promise<File>((res, rej) => entry.file(res, rej));
        results.push({
          file,
          path: `${pathPrefix}${entry.name}`
        });
      } else if (entry.isDirectory) {
        const dirReader = entry.createReader();
        const readEntries = async () => {
          const batch = await new Promise<FileSystemEntryLike[]>((res, rej) => dirReader.readEntries(res, rej));
          if (batch.length > 0) {
            for (const child of batch) {
              await traverseEntry(child, `${pathPrefix}${entry.name}/`);
            }
            await readEntries();
          }
        };
        await readEntries();
      }
    }

    for (const entry of entries) {
      await traverseEntry(entry);
    }

    if (results.length > 0) {
      return results;
    }
  }

  // 2. Fallback to standard dataTransfer.files
  const files = dataTransfer.files ? Array.from(dataTransfer.files) : [];
  for (const f of files) {
    results.push({
      file: f,
      path: f.webkitRelativePath || f.name
    });
  }

  return results;
}
