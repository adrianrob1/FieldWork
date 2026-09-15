export interface BackendCredentialStore {
  setCredential(backendName: string, apiKey: string): void;
  hasCredential(backendName: string): boolean;
  getCredential(backendName: string): string | undefined;
  deleteCredential(backendName: string): void;
}

export function createBackendCredentialStore(): BackendCredentialStore {
  const credentials = new Map<string, string>();
  return {
    setCredential(backendName, apiKey) {
      credentials.set(backendName, apiKey);
    },
    hasCredential(backendName) {
      return credentials.has(backendName);
    },
    getCredential(backendName) {
      return credentials.get(backendName);
    },
    deleteCredential(backendName) {
      credentials.delete(backendName);
    },
  };
}
