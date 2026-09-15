import { fileURLToPath } from 'node:url';
import path from 'node:path';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import type { OutputChunk } from 'rollup';

const webDir = fileURLToPath(new URL('.', import.meta.url));

interface ManifestEntry {
  js: string;
  css: string[];
}

function chunkCssOf(chunk: OutputChunk): Set<string> | undefined {
  return (chunk as { viteMetadata?: { importedCss?: Set<string> } })
    .viteMetadata?.importedCss;
}

function collectCss(
  entry: OutputChunk,
  chunks: Map<string, OutputChunk>,
): string[] {
  const cssFiles: string[] = [];
  const visited = new Set<string>();
  const queue: string[] = [entry.fileName];
  while (queue.length > 0) {
    const fileName = queue.pop();
    if (fileName === undefined || visited.has(fileName)) continue;
    visited.add(fileName);
    const chunk = chunks.get(fileName);
    if (chunk === undefined) continue;
    for (const css of chunkCssOf(chunk) ?? []) {
      if (!cssFiles.includes(css)) cssFiles.push(css);
    }
    queue.push(...chunk.imports);
  }
  return cssFiles;
}

function webManifestPlugin(): Plugin {
  return {
    name: 'fieldwork-web-manifest',
    apply: 'build',
    generateBundle(_, bundle) {
      const chunks = new Map<string, OutputChunk>();
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') chunks.set(output.fileName, output);
      }
      const manifest: Record<string, ManifestEntry> = {};
      for (const chunk of chunks.values()) {
        if (!chunk.isEntry) continue;
        manifest[chunk.name] = {
          js: chunk.fileName,
          css: collectCss(chunk, chunks),
        };
      }
      this.emitFile({
        type: 'asset',
        fileName: 'manifest.json',
        source: `${JSON.stringify(manifest, null, 2)}\n`,
      });
    },
  };
}

export default defineConfig({
  root: webDir,
  base: '/',
  plugins: [tailwindcss(), react(), webManifestPlugin()],
  build: {
    outDir: path.resolve(webDir, '../dist/web'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        app: path.resolve(webDir, 'app/index.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
