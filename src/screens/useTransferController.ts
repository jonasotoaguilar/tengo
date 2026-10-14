/**
 * U6 transfer controller hook (no navigation, no DB open).
 *
 * Owns the export/import sessions for one container mount: export builds
 * the versioned document through the repository layer, writes it to a
 * cache file and hands it to the system share sheet; import picks a user
 * file, parses it, and STAGES it for an explicit confirmation — the
 * import replaces the whole inventory and cannot be undone, so nothing
 * is applied until the user confirms (ROADMAP section 9
 * deletion/backup gate). A refused confirmation applies nothing and is
 * silent. A cancelled pick or a failed parse is refused before any
 * confirmation with the typed reason (version mismatch, malformed,
 * invalid data, storage) as localized copy. One session at a time: a
 * second press while busy (including while staged) is refused. Never
 * opens, reopens, or closes the database: it uses the injected
 * already-open handle (null until the container bootstrap resolves).
 * Outcomes leave through `onNotice` (the container's existing notice
 * surface) and `onChanged` (the container's background refresh), so this
 * hook owns no list state. No network call on any path: the file the
 * user owns stays on the device.
 *
 * The file/share/pick seams default to the installed Expo modules
 * (`expo-file-system` File API, `expo-sharing`, `expo-document-picker`,
 * lazily required so unit tests never load native code) and are
 * injectable for fakes; the document build/apply default to the real
 * transfer functions with the same injectable seam as the item-form
 * repository adapter.
 */
import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { RepositoryDb } from '../inventory/database';
import { listItems } from '../inventory/itemRepository';
import {
  applyTransferDocument,
  buildTransferDocument,
  parseTransferDocument,
  serializeTransferDocument,
  type TransferDocument,
  TransferError,
  type TransferSummary,
} from '../inventory/transfer';
import type { ItemDetail } from '../inventory/types';

/** File/share/pick boundary: real Expo modules by default, fakes in tests. */
export interface TransferFileDeps {
  writeExportFile: (filename: string, content: string) => Promise<string>;
  shareExportFile: (uri: string) => Promise<void>;
  pickImportFile: () => Promise<string | null>;
  buildDocument?: (db: RepositoryDb) => Promise<TransferDocument>;
  applyDocument?: (
    db: RepositoryDb,
    doc: TransferDocument,
  ) => Promise<TransferSummary>;
  /**
   * Full-detail reads around the wipe, so the owner can re-home
   * id-keyed side effects (reminders). Defaults to the real `listItems`.
   */
  listDetails?: (db: RepositoryDb) => Promise<ItemDetail[]>;
}

interface ExpoFileModule {
  File: new (
    ...uris: unknown[]
  ) => {
    uri: string;
    write: (content: string) => void;
    text: () => Promise<string>;
  };
  Paths: { cache: unknown };
}

async function defaultWriteExportFile(
  filename: string,
  content: string,
): Promise<string> {
  // Lazy require (same pattern as `src/dev/*`): the native module loads
  // only when a real export runs, never under Jest.
  const FileSystem = require('expo-file-system') as ExpoFileModule;
  const file = new FileSystem.File(FileSystem.Paths.cache, filename);
  file.write(content);
  return file.uri;
}

async function defaultShareExportFile(uri: string): Promise<void> {
  const Sharing = require('expo-sharing') as {
    shareAsync: (url: string) => Promise<void>;
  };
  await Sharing.shareAsync(uri);
}

async function defaultPickImportFile(): Promise<string | null> {
  const Picker = require('expo-document-picker') as {
    getDocumentAsync: (options: {
      type: string;
      copyToCacheDirectory: boolean;
    }) => Promise<{
      canceled: boolean;
      assets?: { uri: string }[] | null;
    }>;
  };
  const picked = await Picker.getDocumentAsync({
    type: 'application/json',
    copyToCacheDirectory: true,
  });
  if (picked.canceled || !picked.assets || picked.assets.length === 0) {
    return null;
  }
  const FileSystem = require('expo-file-system') as ExpoFileModule;
  const file = new FileSystem.File(picked.assets[0].uri);
  return file.text();
}

const defaultDeps: TransferFileDeps = {
  writeExportFile: defaultWriteExportFile,
  shareExportFile: defaultShareExportFile,
  pickImportFile: defaultPickImportFile,
  buildDocument: buildTransferDocument,
  applyDocument: applyTransferDocument,
  listDetails: listItems,
};

export interface TransferControllerOptions {
  /** Already-open managed handle; null until the container bootstrap resolves. */
  db: RepositoryDb | null;
  /** Injectable file/document seam (fakes in unit tests). */
  deps?: Partial<TransferFileDeps>;
  /** Localized outcome copy for the container notice surface. */
  onNotice?: (message: string) => void;
  /** Fired after a successful import so the container refreshes. */
  onChanged?: () => void;
  /**
   * Fired after a successful import with the pre-wipe and post-wipe
   * details, so the container can move id-keyed side effects (reminders)
   * from the replaced ids to the fresh ones.
   */
  onImported?: (prev: ItemDetail[], next: ItemDetail[]) => void;
}

/** A parsed file staged for confirmation: the doc plus its impact counts. */
export interface PendingImport {
  doc: TransferDocument;
  summary: TransferSummary;
}

export interface TransferController {
  busy: boolean;
  onExport: () => Promise<void>;
  onImport: () => Promise<void>;
  /** Non-null while a parsed file awaits confirmation; null otherwise. */
  pendingImport: PendingImport | null;
  /** Apply the staged file (validates + writes), then refresh + notice. */
  onConfirmImport: () => Promise<void>;
  /** Discard the staged file silently: no apply, no notice, no refresh. */
  onCancelImport: () => void;
}

/** Export filename from the document timestamp (filesystem-safe). */
export function transferExportFilename(exportedAt: string): string {
  const stamp = exportedAt.replace(/[^0-9A-Za-z]+/g, '-');
  return `tengo-inventory-${stamp}.json`;
}

/** Map an import failure to its localized copy key (never raw text). */
function importErrorKey(
  error: unknown,
):
  | 'transferImportVersionMismatch'
  | 'transferImportMalformed'
  | 'transferImportInvalid'
  | 'transferImportFailed' {
  if (error instanceof TransferError) {
    if (error.code === 'version-mismatch') {
      return 'transferImportVersionMismatch';
    }
    if (error.code === 'malformed') {
      return 'transferImportMalformed';
    }
    if (error.code === 'validation' || error.code === 'conflict') {
      return 'transferImportInvalid';
    }
  }
  return 'transferImportFailed';
}

/**
 * Impact counts for the confirmation copy, computed defensively: parse
 * guarantees the top-level arrays, but entries may be misshapen (a
 * shape-valid file with un-storable data still stages, then refuses at
 * apply time with the typed reason and zero writes).
 */
function summarizeDocument(doc: TransferDocument): TransferSummary {
  const locations = Array.isArray(doc.locations) ? doc.locations : [];
  const categories = Array.isArray(doc.categories) ? doc.categories : [];
  const items = Array.isArray(doc.items) ? doc.items : [];
  let stockRows = 0;
  for (const item of items) {
    if (
      item !== null &&
      typeof item === 'object' &&
      Array.isArray((item as { stock?: unknown }).stock)
    ) {
      stockRows += (item as { stock: unknown[] }).stock.length;
    }
  }
  return {
    locations: locations.length,
    categories: categories.length,
    items: items.length,
    stockRows,
  };
}

export default function useTransferController(
  options: TransferControllerOptions,
): TransferController {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(
    null,
  );
  const pendingRef = useRef<PendingImport | null>(null);
  const saved = useRef(options);
  saved.current = options;

  const onExport = useCallback(async () => {
    const active = saved.current;
    if (active.db === null || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const deps = { ...defaultDeps, ...active.deps };
      const build = deps.buildDocument ?? buildTransferDocument;
      const doc = await build(active.db);
      const uri = await deps.writeExportFile(
        transferExportFilename(doc.exportedAt),
        serializeTransferDocument(doc),
      );
      await deps.shareExportFile(uri);
      active.onNotice?.(t('transferExported'));
    } catch {
      // Export never surfaces raw storage/driver text.
      active.onNotice?.(t('transferExportFailed'));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [t]);

  const onImport = useCallback(async () => {
    const active = saved.current;
    if (active.db === null || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const deps = { ...defaultDeps, ...active.deps };
      // The picker sits inside the same typed-to-localized mapping as
      // the rest of import: a throwing picker surfaces the localized
      // import-failed notice, while a user cancel (null) stays silent.
      let content: string | null;
      try {
        content = await deps.pickImportFile();
      } catch (error) {
        active.onNotice?.(t(importErrorKey(error)));
        return;
      }
      // A cancelled pick is silent: no notice, no staging, no refresh.
      if (content === null) return;
      let doc: TransferDocument;
      try {
        doc = parseTransferDocument(content);
      } catch (error) {
        // A failed parse refuses before any confirmation and any write.
        active.onNotice?.(t(importErrorKey(error)));
        return;
      }
      // Parsed: stage for the explicit confirmation. Busy stays held
      // so no second session can start while the dialog owns the screen.
      const staged: PendingImport = { doc, summary: summarizeDocument(doc) };
      pendingRef.current = staged;
      setPendingImport(staged);
    } finally {
      // Release only when nothing is staged: a staged file keeps the
      // session (confirm/cancel releases it below).
      if (pendingRef.current === null) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [t]);

  const onConfirmImport = useCallback(async () => {
    const active = saved.current;
    const staged = pendingRef.current;
    pendingRef.current = null;
    setPendingImport(null);
    if (staged === null || active.db === null) {
      busyRef.current = false;
      setBusy(false);
      return;
    }
    let prev: ItemDetail[] = [];
    let next: ItemDetail[] = [];
    try {
      const deps = { ...defaultDeps, ...active.deps };
      const list = deps.listDetails ?? listItems;
      // Snapshot before the wipe: its id-keyed schedules become orphans.
      // A failed snapshot refuses closed instead of orphaning silently.
      prev = await list(active.db);
      const apply = deps.applyDocument ?? applyTransferDocument;
      // Validates first, then writes atomically: a refusal writes nothing.
      await apply(active.db, staged.doc);
      // Re-read after the wipe: the fresh ids own the new schedules. A
      // failed re-read degrades to cancelling the stale keys only — the
      // import itself succeeded, so it still refreshes and confirms.
      next = await list(active.db).catch((): ItemDetail[] => []);
    } catch (error) {
      active.onNotice?.(t(importErrorKey(error)));
      return;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    // Observer callbacks stay outside the try: a throwing observer must
    // not rewrite a successful import into a failure notice.
    active.onImported?.(prev, next);
    active.onChanged?.();
    active.onNotice?.(t('transferImported'));
  }, [t]);

  const onCancelImport = useCallback(() => {
    // Refused confirmation: silent — no apply, no notice, no refresh.
    pendingRef.current = null;
    setPendingImport(null);
    busyRef.current = false;
    setBusy(false);
  }, []);

  return {
    busy,
    onExport,
    onImport,
    pendingImport,
    onConfirmImport,
    onCancelImport,
  };
}
