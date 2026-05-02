import { useState, useEffect, useCallback, useMemo } from 'react';

import {
  type BaseMode,
  type ViewedFileRecord,
  type DiffFile,
  type ViewedHashIndexEntry,
} from '../../types/diff';
import { getDiffSelectionKey } from '../../utils/diffSelection';
import { storageService, VIEWED_HASH_VERSION } from '../services/StorageService';
import { matchesAutoViewedPatterns } from '../utils/autoViewedPatterns';
import { generateDiffHash, getDiffContentForHashing } from '../utils/diffUtils';

interface UseViewedFilesReturn {
  viewedFiles: Set<string>; // Set of file paths
  hasLoadedInitialViewedFiles: boolean;
  toggleFileViewed: (filePath: string, diffFile: DiffFile) => Promise<void>;
  isFileContentChanged: (filePath: string, diffFile: DiffFile) => Promise<boolean>;
  getViewedFileRecord: (filePath: string) => ViewedFileRecord | undefined;
  clearViewedFiles: () => void;
}

export function useViewedFiles(
  baseCommitish?: string,
  targetCommitish?: string,
  currentCommitHash?: string,
  branchToHash?: Map<string, string>,
  initialFiles?: DiffFile[],
  repositoryId?: string,
  autoViewedPatterns: string[] = [],
  baseMode?: BaseMode,
  keepViewedAcrossComparisons: boolean = true,
): UseViewedFilesReturn {
  const [viewedFileRecords, setViewedFileRecords] = useState<ViewedFileRecord[]>([]);
  const [loadedViewedFilesKey, setLoadedViewedFilesKey] = useState<string | null>(null);
  const [fileHashes, setFileHashes] = useState<Map<string, string>>(new Map());
  const viewedFilesKey =
    baseCommitish && targetCommitish
      ? `${repositoryId ?? 'default'}:${getDiffSelectionKey({
          baseCommitish,
          targetCommitish,
          baseMode,
        })}:${currentCommitHash ?? 'no-commit'}`
      : null;
  const hasLoadedInitialViewedFiles =
    viewedFilesKey !== null && loadedViewedFilesKey === viewedFilesKey;

  // Load viewed files from storage and auto-mark configured/generated files
  useEffect(() => {
    if (!baseCommitish || !targetCommitish || !viewedFilesKey) return;

    let cancelled = false;

    const loadedFiles = storageService.getViewedFiles(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );

    // Auto-mark generated, deleted, or pattern-matched files as viewed if they
    // are not already marked. Pattern changes are intentionally not reactive here
    // so editing the textarea does not immediately re-mark the current diff.
    const processAutoCollapsedFiles = async () => {
      const additions: ViewedFileRecord[] = [];

      if (initialFiles && initialFiles.length > 0) {
        const knownPaths = new Set(loadedFiles.map((f) => f.filePath));

        // Hash every displayed file once so we can both auto-mark and
        // hydrate-from-index without recomputing.
        const hashByPath = new Map<string, string>();
        await Promise.all(
          initialFiles.map(async (file) => {
            try {
              const hash = await generateDiffHash(getDiffContentForHashing(file));
              hashByPath.set(file.path, hash);
            } catch (err) {
              console.error('Failed to generate hash for file:', file.path, err);
            }
          }),
        );

        // Auto-mark generated / deleted / pattern-matched files.
        for (const file of initialFiles) {
          if (knownPaths.has(file.path)) continue;
          const shouldAutoMarkViewed =
            file.isGenerated ||
            file.status === 'deleted' ||
            matchesAutoViewedPatterns(file.path, autoViewedPatterns);
          if (!shouldAutoMarkViewed) continue;

          const hash = hashByPath.get(file.path);
          if (!hash) continue;

          additions.push({
            filePath: file.path,
            viewedAt: new Date().toISOString(),
            diffContentHash: hash,
          });
          knownPaths.add(file.path);
        }

        // Hydrate from the per-repository hash index so files that were marked
        // viewed in a prior comparison stay viewed when their diff is unchanged.
        if (keepViewedAcrossComparisons) {
          const index = storageService.getViewedHashIndex(repositoryId);
          const indexed = new Map(index.entries.map((entry) => [entry.filePath, entry]));
          for (const file of initialFiles) {
            if (knownPaths.has(file.path)) continue;
            const entry = indexed.get(file.path);
            if (!entry || entry.hashVersion !== VIEWED_HASH_VERSION) continue;

            const currentHash = hashByPath.get(file.path);
            if (!currentHash || currentHash !== entry.diffContentHash) continue;

            additions.push({
              filePath: file.path,
              viewedAt: entry.viewedAt, // preserve original timestamp
              diffContentHash: currentHash,
            });
            knownPaths.add(file.path);
          }
        }
      }

      if (additions.length > 0) {
        const updatedRecords = [...loadedFiles, ...additions];
        storageService.saveViewedFiles(
          baseCommitish,
          targetCommitish,
          updatedRecords,
          currentCommitHash,
          branchToHash,
          repositoryId,
          baseMode,
        );
        if (!cancelled) {
          setViewedFileRecords(updatedRecords);
          setLoadedViewedFilesKey(viewedFilesKey);
        }
        return;
      }

      if (!cancelled) {
        setViewedFileRecords(loadedFiles);
        setLoadedViewedFilesKey(viewedFilesKey);
      }
    };

    void processAutoCollapsedFiles();
    return () => {
      cancelled = true;
    };
    // oxlint-disable-next-line react/exhaustive-deps
  }, [
    baseCommitish,
    targetCommitish,
    currentCommitHash,
    branchToHash,
    repositoryId,
    viewedFilesKey,
    baseMode,
    keepViewedAcrossComparisons,
  ]); // initialFiles and autoViewedPatterns intentionally omitted to run only on diff init

  // Save viewed files to storage
  const saveViewedFiles = useCallback(
    (newRecords: ViewedFileRecord[]) => {
      if (!baseCommitish || !targetCommitish) return;

      storageService.saveViewedFiles(
        baseCommitish,
        targetCommitish,
        newRecords,
        currentCommitHash,
        branchToHash,
        repositoryId,
        baseMode,
      );
      setViewedFileRecords(newRecords);
    },
    [baseCommitish, targetCommitish, currentCommitHash, branchToHash, repositoryId, baseMode],
  );

  // Convert records to Set of file paths for easy checking
  const viewedFiles = useMemo(() => {
    return new Set(viewedFileRecords.map((record) => record.filePath));
  }, [viewedFileRecords]);

  // Get specific file record
  const getViewedFileRecord = useCallback(
    (filePath: string): ViewedFileRecord | undefined => {
      return viewedFileRecords.find((record) => record.filePath === filePath);
    },
    [viewedFileRecords],
  );

  // Generate and cache hash for a file
  const getFileHash = useCallback(
    async (diffFile: DiffFile): Promise<string> => {
      const cached = fileHashes.get(diffFile.path);
      if (cached) return cached;

      const content = getDiffContentForHashing(diffFile);
      const hash = await generateDiffHash(content);

      setFileHashes((prev) => new Map(prev).set(diffFile.path, hash));
      return hash;
    },
    [fileHashes],
  );

  // Check if file content has changed
  const isFileContentChanged = useCallback(
    async (filePath: string, diffFile: DiffFile): Promise<boolean> => {
      const record = getViewedFileRecord(filePath);
      if (!record) return false;

      const currentHash = await getFileHash(diffFile);
      return record.diffContentHash !== currentHash;
    },
    [getViewedFileRecord, getFileHash],
  );

  // Toggle viewed state for a file
  const toggleFileViewed = useCallback(
    async (filePath: string, diffFile: DiffFile): Promise<void> => {
      const existingRecord = getViewedFileRecord(filePath);

      if (existingRecord) {
        // File is already viewed, remove it
        const newRecords = viewedFileRecords.filter((r) => r.filePath !== filePath);
        saveViewedFiles(newRecords);
        // Drop from the cross-comparison index so it doesn't get auto-restored
        // the next time the user changes commit ranges.
        storageService.removeViewedHashes(repositoryId, [filePath]);
      } else {
        // File is not viewed, add it
        const hash = await getFileHash(diffFile);
        const viewedAt = new Date().toISOString();
        const newRecord: ViewedFileRecord = {
          filePath,
          viewedAt,
          diffContentHash: hash,
        };

        const newRecords = [...viewedFileRecords, newRecord];
        saveViewedFiles(newRecords);

        const indexEntry: ViewedHashIndexEntry = {
          filePath,
          diffContentHash: hash,
          hashVersion: VIEWED_HASH_VERSION,
          viewedAt,
        };
        storageService.recordViewedHashes(repositoryId, [indexEntry]);
      }
    },
    [viewedFileRecords, getViewedFileRecord, getFileHash, saveViewedFiles, repositoryId],
  );

  // Clear all viewed files
  const clearViewedFiles = useCallback(() => {
    saveViewedFiles([]);
    setFileHashes(new Map());
    storageService.clearViewedHashIndex(repositoryId);
  }, [saveViewedFiles, repositoryId]);

  return {
    viewedFiles,
    hasLoadedInitialViewedFiles,
    toggleFileViewed,
    isFileContentChanged,
    getViewedFileRecord,
    clearViewedFiles,
  };
}
