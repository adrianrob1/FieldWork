import type { Diagnostic } from '../domain/diagnostics.js';

export interface OperationResult<T> {
  success: boolean;
  changed: boolean;
  files: string[];
  data: T | null;
  diagnostics: Diagnostic[];
}

export interface RegisteredRepository {
  id: string;
  path: string;
}

export interface ProjectRegistration {
  id: string;
  title: string;
  directory: string;
  file: string;
  repositories: RegisteredRepository[];
}

export interface ChatAttachment {
  chatId: string;
  projectId: string;
}

export interface ChatPromotion {
  chatId: string;
  project: ProjectRegistration;
}

export function operationOk<T>(
  changed: boolean,
  files: string[],
  data: T,
  diagnostics: Diagnostic[] = [],
): OperationResult<T> {
  return { success: true, changed, files, data, diagnostics };
}

export function operationFailed<T>(
  diagnostics: Diagnostic[],
  files: string[] = [],
): OperationResult<T> {
  return {
    success: false,
    changed: files.length > 0,
    files,
    data: null,
    diagnostics,
  };
}
