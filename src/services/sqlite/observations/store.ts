/**
 * Store observation function
 * Extracted from SessionStore.ts for modular organization
 */

import { createHash } from 'crypto';
import { Database } from 'bun:sqlite';
import { logger } from '../../../utils/logger.js';
import { similarity } from '../../../utils/string-similarity.js';
import { getCurrentProjectName } from '../../../shared/paths.js';
import type { ObservationInput, StoreObservationResult } from './types.js';

/** Deduplication window: observations with the same content hash within this window are skipped */
const DEDUP_WINDOW_MS = 30_000;

/** Similarity threshold for fuzzy dedup (0.0–1.0). Set high (0.95) to avoid suppressing similar but meaningfully different observations. */
const FUZZY_SIMILARITY_THRESHOLD = 0.95;

/**
 * Normalize a string for content hashing:
 * - Apply Unicode NFC normalization
 * - Collapse all runs of whitespace to a single space
 * - Trim leading/trailing whitespace
 *
 * Case-sensitive by design — "API endpoint" and "api endpoint" should produce different hashes.
 * This differs from normalizeForComparison() in string-similarity.ts which also lowercases.
 */
function normalizeForHash(s: string | null): string {
  if (!s) return '';
  return s.normalize('NFC').replace(/\s+/g, ' ').trim();
}

/**
 * Compute a short content hash for deduplication.
 * Uses (memory_session_id, title, narrative) as the semantic identity of an observation.
 * Applies whitespace normalization before hashing to prevent invisible differences
 * (trailing spaces, multiple spaces, Unicode variants) from producing different hashes.
 */
export function computeObservationContentHash(
  memorySessionId: string,
  title: string | null,
  narrative: string | null
): string {
  return createHash('sha256')
    .update((memorySessionId || '') + normalizeForHash(title) + normalizeForHash(narrative))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Check if a duplicate observation exists within the dedup window.
 *
 * Two-tier strategy:
 * 1. Primary: exact content hash match (fast, uses index)
 * 2. Secondary: title-based lookup + narrative similarity check (catches near-duplicates
 *    where the LLM generates slightly different wording)
 *
 * Returns the existing observation's id and timestamp if found, null otherwise.
 */
export function findDuplicateObservation(
  db: Database,
  contentHash: string,
  timestampEpoch: number,
  title?: string | null,
  narrative?: string | null
): { id: number; created_at_epoch: number } | null {
  const windowStart = timestampEpoch - DEDUP_WINDOW_MS;

  // Primary: exact content hash match (fast, indexed)
  const hashStmt = db.prepare(
    'SELECT id, created_at_epoch FROM observations WHERE content_hash = ? AND created_at_epoch > ?'
  );
  const exact = hashStmt.get(contentHash, windowStart) as { id: number; created_at_epoch: number } | null;
  if (exact) return exact;

  // Secondary: fuzzy match — find observations with the same title within the dedup window,
  // then check narrative similarity. Catches near-duplicates from LLM wording variations.
  // Uses raw title for SQL match (DB stores raw values), similarity() handles normalization internally.
  if (title) {
    const candidates = db.prepare(
      'SELECT id, created_at_epoch, narrative FROM observations WHERE title = ? AND created_at_epoch > ? LIMIT 5'
    ).all(title, windowStart) as Array<{ id: number; created_at_epoch: number; narrative: string | null }>;

    for (const candidate of candidates) {
      const sim = similarity(candidate.narrative ?? '', narrative ?? '');
      if (sim === 0.0 && (candidate.narrative ?? '').length > 1000) {
        logger.debug('DEDUP', `Fuzzy match skipped — narrative exceeds max length for Levenshtein | title="${title}" | existingId=${candidate.id}`);
        continue;
      }
      if (sim > FUZZY_SIMILARITY_THRESHOLD) {
        logger.debug('DEDUP', `Fuzzy match found | title="${title}" | similarity=${sim.toFixed(3)} | existingId=${candidate.id}`);
        return { id: candidate.id, created_at_epoch: candidate.created_at_epoch };
      }
    }
  }

  return null;
}

/**
 * Store an observation (from SDK parsing)
 * Assumes session already exists (created by hook)
 * Performs content-hash deduplication: skips INSERT if an identical observation exists within 30s
 */
export function storeObservation(
  db: Database,
  memorySessionId: string,
  project: string,
  observation: ObservationInput,
  promptNumber?: number,
  discoveryTokens: number = 0,
  overrideTimestampEpoch?: number
): StoreObservationResult {
  // Use override timestamp if provided (for processing backlog messages with original timestamps)
  const timestampEpoch = overrideTimestampEpoch ?? Date.now();
  const timestampIso = new Date(timestampEpoch).toISOString();

  // Guard against empty project string (race condition where project isn't set yet)
  const resolvedProject = project || getCurrentProjectName();

  // Content-hash deduplication (with fuzzy fallback)
  const contentHash = computeObservationContentHash(memorySessionId, observation.title, observation.narrative);
  const existing = findDuplicateObservation(db, contentHash, timestampEpoch, observation.title, observation.narrative);
  if (existing) {
    logger.debug('DEDUP', `Skipped duplicate observation | contentHash=${contentHash} | existingId=${existing.id}`);
    return { id: existing.id, createdAtEpoch: existing.created_at_epoch };
  }

  const stmt = db.prepare(`
    INSERT INTO observations
    (memory_session_id, project, type, title, subtitle, facts, narrative, concepts,
     files_read, files_modified, prompt_number, discovery_tokens, content_hash, created_at, created_at_epoch)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    memorySessionId,
    resolvedProject,
    observation.type,
    observation.title,
    observation.subtitle,
    JSON.stringify(observation.facts),
    observation.narrative,
    JSON.stringify(observation.concepts),
    JSON.stringify(observation.files_read),
    JSON.stringify(observation.files_modified),
    promptNumber || null,
    discoveryTokens,
    contentHash,
    timestampIso,
    timestampEpoch
  );

  return {
    id: Number(result.lastInsertRowid),
    createdAtEpoch: timestampEpoch
  };
}
