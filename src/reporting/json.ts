/**
 * JSON renderer — full-fidelity dump for customers / sales-eng tooling
 * that wants to chart things or post-process. CSV is the canonical
 * share-with-sales artifact; JSON is the audit/debug artifact.
 */

import type { RepoSizedRow } from './csv.js';
import { sortByActivity } from './sortByActivity.js';

export interface SizedJsonReport {
  /** Schema version, bumped if the JSON shape ever changes. */
  schemaVersion: 1;
  /** ISO 8601 timestamp the report was generated. */
  generatedAt: string;
  /** Tool semver, for trace purposes. */
  generator: { name: '@damsecure/sizer'; version: string };
  rows: RepoSizedRow[];
}

export function renderSizedJson(
  rows: readonly RepoSizedRow[],
  options: { generatorVersion: string; now?: Date } = {
    generatorVersion: '0.1.0',
  }
): string {
  const report: SizedJsonReport = {
    schemaVersion: 1,
    generatedAt: (options.now ?? new Date()).toISOString(),
    generator: { name: '@damsecure/sizer', version: options.generatorVersion },
    rows: sortByActivity(rows),
  };
  return JSON.stringify(report, null, 2);
}
