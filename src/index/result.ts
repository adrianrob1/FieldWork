import type { Diagnostic } from '../domain/diagnostics.js';

export interface IndexCounts {
  files: number;
  objects: number;
  references: number;
  repositories: number;
  documents: number;
}

export interface IndexResult {
  indexPath: string;
  rebuilt: boolean;
  counts: IndexCounts;
  diagnostics: Diagnostic[];
}
