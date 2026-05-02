import {
  type BaseMode,
  type DiffCommentThread,
  type ViewedFileRecord,
  type DiffContextStorage,
  type LegacyDiffContextStorage,
  type LegacyDiffComment,
  type ViewedHashIndex,
  type ViewedHashIndexEntry,
} from '../../types/diff';
import { normalizeBaseMode } from '../../utils/diffSelection';

const STORAGE_KEY_PREFIX = 'difit-storage-v1';
const VIEWED_INDEX_PREFIX = 'difit-viewed-index-v1';
const DEFAULT_REPO_ID = '__default__';
const MAX_VIEWED_INDEX_ENTRIES = 5000;
export const VIEWED_HASH_VERSION = 1;

function migrateLegacyComment(comment: LegacyDiffComment): DiffCommentThread {
  return {
    id: comment.id,
    filePath: comment.filePath,
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
    position: comment.position,
    codeSnapshot: comment.codeSnapshot,
    messages: [
      {
        id: comment.id,
        body: comment.body,
        author: comment.author,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
      },
    ],
  };
}

function normalizeRootComment(thread: DiffCommentThread): LegacyDiffComment | null {
  const rootMessage = thread.messages[0];
  if (!rootMessage) return null;

  return {
    id: thread.id,
    filePath: thread.filePath,
    body: rootMessage.body,
    author: rootMessage.author,
    createdAt: rootMessage.createdAt,
    updatedAt: rootMessage.updatedAt,
    position: thread.position,
    codeSnapshot: thread.codeSnapshot,
  };
}

export class StorageService {
  /**
   * Generate a filesystem-safe storage key from commitish references
   */
  private generateStorageKey(
    baseCommitish: string,
    targetCommitish: string,
    baseMode?: BaseMode,
  ): string {
    const encode = (str: string) =>
      str.replace(/[^a-zA-Z0-9-_]/g, (char) => {
        return `_${char.charCodeAt(0).toString(16)}_`;
      });

    const baseKey = `${encode(baseCommitish)}-${encode(targetCommitish)}`;

    if (normalizeBaseMode(baseMode) === 'merge-base') {
      return `${baseKey}-merge-base`;
    }

    return baseKey;
  }

  private getFullStorageKey(repositoryId: string | undefined, key: string): string {
    if (repositoryId) {
      return `${STORAGE_KEY_PREFIX}/${repositoryId}/${key}`;
    }
    return `${STORAGE_KEY_PREFIX}/${key}`;
  }

  /**
   * Normalize dynamic references like HEAD, branch names, etc.
   */
  private normalizeCommitish(
    commitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
  ): string {
    // Handle working directory and staged cases
    if (commitish === '.' || commitish === 'working') {
      return 'WORKING';
    }
    if (commitish === 'staged') {
      return 'STAGED';
    }

    // Handle HEAD reference (including @ symbol which is git shorthand for HEAD)
    if ((commitish === 'HEAD' || commitish === '@') && currentCommitHash) {
      return currentCommitHash;
    }

    // Try to resolve branch names to hashes
    if (branchToHash?.has(commitish)) {
      const hash = branchToHash.get(commitish);
      if (hash) {
        return hash;
      }
    }

    // IMPORTANT: For commitish like @^, @~1, etc., we cannot normalize without commit hash
    // These will use the literal string as key, which may cause collision across different commits
    // Warn if this looks like a symbolic reference that couldn't be resolved
    if (
      commitish.startsWith('@') ||
      commitish.includes('^') ||
      commitish.includes('~') ||
      commitish.includes('HEAD')
    ) {
      console.warn(
        `[StorageService] Cannot normalize symbolic ref '${commitish}' - may cause key collision. ` +
          `currentCommitHash=${currentCommitHash}`,
      );
    }

    // Return as-is (likely a commit hash or unresolved symbolic ref)
    return commitish;
  }

  /**
   * Get the full localStorage key for a diff context
   */
  private getStorageKey(
    baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): string {
    const normalizedBase = this.normalizeStorageBase(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
    );
    const normalizedTarget = this.normalizeStorageTarget(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
    );

    const key = this.generateStorageKey(normalizedBase, normalizedTarget, baseMode);
    return this.getFullStorageKey(repositoryId, key);
  }

  /**
   * Get diff context data from localStorage
   */
  getDiffContextData(
    baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): DiffContextStorage | null {
    try {
      const key = this.getStorageKey(
        baseCommitish,
        targetCommitish,
        currentCommitHash,
        branchToHash,
        repositoryId,
        baseMode,
      );
      const data = localStorage.getItem(key);

      if (!data) return null;

      const parsed = JSON.parse(data) as DiffContextStorage | LegacyDiffContextStorage;
      if (parsed.version === 2 && 'threads' in parsed) {
        return parsed;
      }

      if (parsed.version === 1 && 'comments' in parsed) {
        return {
          version: 2,
          baseCommitish: parsed.baseCommitish,
          targetCommitish: parsed.targetCommitish,
          createdAt: parsed.createdAt,
          lastModifiedAt: parsed.lastModifiedAt,
          threads: parsed.comments.map(migrateLegacyComment),
          viewedFiles: parsed.viewedFiles,
          appliedCommentImportIds: [],
        };
      }

      console.warn(`Unknown storage version: ${String((parsed as { version?: unknown }).version)}`);
      return null;
    } catch (error) {
      console.error('Error reading diff context data:', error);
      return null;
    }
  }

  private normalizeStorageBase(
    baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
  ): string {
    if (targetCommitish === '.' || targetCommitish === 'working' || targetCommitish === 'staged') {
      return currentCommitHash || baseCommitish;
    }

    return this.normalizeCommitish(baseCommitish, currentCommitHash, branchToHash);
  }

  private normalizeStorageTarget(
    _baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
  ): string {
    if (targetCommitish === '.' || targetCommitish === 'working') {
      return 'WORKING';
    }

    if (targetCommitish === 'staged') {
      return 'STAGED';
    }

    return this.normalizeCommitish(targetCommitish, currentCommitHash, branchToHash);
  }

  /**
   * Save diff context data to localStorage
   */
  saveDiffContextData(
    baseCommitish: string,
    targetCommitish: string,
    data: DiffContextStorage,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): void {
    try {
      const key = this.getStorageKey(
        baseCommitish,
        targetCommitish,
        currentCommitHash,
        branchToHash,
        repositoryId,
        baseMode,
      );
      // Ensure data includes original commitish values
      const dataToSave: DiffContextStorage = {
        ...data,
        version: 2,
        baseCommitish,
        targetCommitish,
        baseMode,
        lastModifiedAt: new Date().toISOString(),
        appliedCommentImportIds: data.appliedCommentImportIds || [],
      };
      localStorage.setItem(key, JSON.stringify(dataToSave));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.error('localStorage quota exceeded');
        // Could implement cleanup here
      } else {
        console.error('Error saving diff context data:', error);
      }
    }
  }

  /**
   * Get comment threads for a specific diff context
   */
  getCommentThreads(
    baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): DiffCommentThread[] {
    const data = this.getDiffContextData(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
    return data?.threads || [];
  }

  /**
   * Legacy flat comment accessor retained for compatibility
   */
  getComments(
    baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): LegacyDiffComment[] {
    return this.getCommentThreads(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    )
      .map((thread) => normalizeRootComment(thread))
      .filter((comment): comment is LegacyDiffComment => comment !== null);
  }

  /**
   * Save comment threads for a specific diff context
   */
  saveCommentThreads(
    baseCommitish: string,
    targetCommitish: string,
    threads: DiffCommentThread[],
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): void {
    const existingData = this.getDiffContextData(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
    const data: DiffContextStorage = existingData || {
      version: 2,
      baseCommitish,
      targetCommitish,
      baseMode,
      createdAt: new Date().toISOString(),
      lastModifiedAt: new Date().toISOString(),
      threads: [],
      viewedFiles: [],
      appliedCommentImportIds: [],
    };

    data.threads = threads;
    this.saveDiffContextData(
      baseCommitish,
      targetCommitish,
      data,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
  }

  /**
   * Legacy flat comment writer retained for compatibility
   */
  saveComments(
    baseCommitish: string,
    targetCommitish: string,
    comments: LegacyDiffComment[],
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): void {
    this.saveCommentThreads(
      baseCommitish,
      targetCommitish,
      comments.map(migrateLegacyComment),
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
  }

  /**
   * Get viewed files for a specific diff context
   */
  getViewedFiles(
    baseCommitish: string,
    targetCommitish: string,
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): ViewedFileRecord[] {
    const data = this.getDiffContextData(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
    return data?.viewedFiles || [];
  }

  /**
   * Save viewed files for a specific diff context
   */
  saveViewedFiles(
    baseCommitish: string,
    targetCommitish: string,
    files: ViewedFileRecord[],
    currentCommitHash?: string,
    branchToHash?: Map<string, string>,
    repositoryId?: string,
    baseMode?: BaseMode,
  ): void {
    const existingData = this.getDiffContextData(
      baseCommitish,
      targetCommitish,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
    const data: DiffContextStorage = existingData || {
      version: 2,
      baseCommitish,
      targetCommitish,
      baseMode,
      createdAt: new Date().toISOString(),
      lastModifiedAt: new Date().toISOString(),
      threads: [],
      viewedFiles: [],
      appliedCommentImportIds: [],
    };

    data.viewedFiles = files;
    this.saveDiffContextData(
      baseCommitish,
      targetCommitish,
      data,
      currentCommitHash,
      branchToHash,
      repositoryId,
      baseMode,
    );
  }

  /**
   * Get the localStorage key for the per-repository viewed-hash index.
   */
  private getViewedHashIndexKey(repositoryId: string | undefined): string {
    return `${VIEWED_INDEX_PREFIX}/${repositoryId ?? DEFAULT_REPO_ID}`;
  }

  /**
   * Get the per-repository index of `(filePath -> diffContentHash)` for files
   * that have ever been marked viewed. Used to carry "viewed" state across
   * comparison-range changes when the file's diff is unchanged.
   */
  getViewedHashIndex(repositoryId?: string): ViewedHashIndex {
    const empty: ViewedHashIndex = {
      version: 1,
      lastModifiedAt: new Date(0).toISOString(),
      entries: [],
    };
    try {
      const raw = localStorage.getItem(this.getViewedHashIndexKey(repositoryId));
      if (!raw) return empty;
      const parsed = JSON.parse(raw) as ViewedHashIndex;
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return empty;
      return parsed;
    } catch (error) {
      console.error('Error reading viewed hash index:', error);
      return empty;
    }
  }

  private writeViewedHashIndex(repositoryId: string | undefined, index: ViewedHashIndex): void {
    try {
      localStorage.setItem(
        this.getViewedHashIndexKey(repositoryId),
        JSON.stringify({ ...index, lastModifiedAt: new Date().toISOString() }),
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'QuotaExceededError') {
        console.error('localStorage quota exceeded while writing viewed hash index');
      } else {
        console.error('Error saving viewed hash index:', error);
      }
    }
  }

  /**
   * Upsert entries into the per-repository viewed-hash index, then trim the
   * oldest entries (by viewedAt) once the cap is exceeded.
   */
  recordViewedHashes(repositoryId: string | undefined, entries: ViewedHashIndexEntry[]): void {
    if (entries.length === 0) return;
    const index = this.getViewedHashIndex(repositoryId);
    const byPath = new Map(index.entries.map((entry) => [entry.filePath, entry]));
    for (const entry of entries) {
      byPath.set(entry.filePath, entry);
    }

    let next = Array.from(byPath.values());
    if (next.length > MAX_VIEWED_INDEX_ENTRIES) {
      next.sort((a, b) => (a.viewedAt < b.viewedAt ? 1 : -1));
      next = next.slice(0, MAX_VIEWED_INDEX_ENTRIES);
    }

    this.writeViewedHashIndex(repositoryId, {
      version: 1,
      lastModifiedAt: index.lastModifiedAt,
      entries: next,
    });
  }

  /**
   * Remove paths from the per-repository viewed-hash index so a previously
   * viewed file does not get auto-restored on the next comparison switch.
   */
  removeViewedHashes(repositoryId: string | undefined, filePaths: string[]): void {
    if (filePaths.length === 0) return;
    const index = this.getViewedHashIndex(repositoryId);
    const drop = new Set(filePaths);
    const next = index.entries.filter((entry) => !drop.has(entry.filePath));
    if (next.length === index.entries.length) return;

    this.writeViewedHashIndex(repositoryId, {
      version: 1,
      lastModifiedAt: index.lastModifiedAt,
      entries: next,
    });
  }

  /**
   * Drop the entire per-repository viewed-hash index.
   */
  clearViewedHashIndex(repositoryId?: string): void {
    try {
      localStorage.removeItem(this.getViewedHashIndexKey(repositoryId));
    } catch (error) {
      console.error('Error clearing viewed hash index:', error);
    }
  }

  /**
   * Clean up old data based on days to keep
   */
  cleanupOldData(daysToKeep: number): void {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    const cutoffTime = cutoffDate.getTime();

    const keysToRemove: string[] = [];

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;

      const isContextKey = key.startsWith(STORAGE_KEY_PREFIX);
      const isIndexKey = key.startsWith(VIEWED_INDEX_PREFIX);
      if (!isContextKey && !isIndexKey) continue;

      try {
        const data = localStorage.getItem(key);
        if (!data) continue;

        const parsed = JSON.parse(data) as { lastModifiedAt?: string };
        const lastModifiedRaw = parsed.lastModifiedAt;
        if (!lastModifiedRaw) continue;

        const lastModified = new Date(lastModifiedRaw).getTime();
        if (Number.isFinite(lastModified) && lastModified < cutoffTime) {
          keysToRemove.push(key);
        }
      } catch {
        // Skip invalid entries
      }
    }

    // Remove old entries
    keysToRemove.forEach((key) => localStorage.removeItem(key));
  }

  /**
   * Get total storage size used by difit
   */
  getStorageSize(): number {
    let totalSize = 0;

    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (!key.startsWith(STORAGE_KEY_PREFIX) && !key.startsWith(VIEWED_INDEX_PREFIX)) continue;

      const value = localStorage.getItem(key);
      if (value) {
        // Rough estimate: 2 bytes per character (UTF-16)
        totalSize += (key.length + value.length) * 2;
      }
    }

    return totalSize;
  }
}

// Export singleton instance
export const storageService = new StorageService();
