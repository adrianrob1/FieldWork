import { escapeHtml } from './html.js';
import {
  assetUrlOf,
  readWebManifestEntry,
  type WebManifestEntry,
} from './webAssets.js';

export interface PageResponse {
  status: number;
  html: string;
}

const themeBootstrap =
  "try{document.documentElement.dataset.theme=localStorage.getItem('lh-sidecar-theme')||'dark';}catch{document.documentElement.dataset.theme='dark';}";

const viewport =
  'width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content';

// Every page route serves the single-page app; the client router renders the
// matching screen from window.location.
export async function appPage(
  webAssetsDir: string | undefined,
): Promise<PageResponse> {
  const entry = await readWebManifestEntry(webAssetsDir, 'app');
  const html = renderAppShell(entry);
  if (html !== null) return { status: 200, html };
  return { status: 200, html: renderBuildNotice() };
}

export async function unknownPage(
  webAssetsDir: string | undefined,
): Promise<PageResponse> {
  const entry = await readWebManifestEntry(webAssetsDir, 'app');
  const html = renderAppShell(entry);
  if (html !== null) return { status: 404, html };
  return { status: 404, html: renderBuildNotice() };
}

function renderAppShell(entry: WebManifestEntry | null): string | null {
  if (entry === null) return null;
  const jsUrl = assetUrlOf(entry.js);
  if (jsUrl === null) return null;
  const cssUrls = entry.css
    .map((reference) => assetUrlOf(reference))
    .filter((url): url is string => url !== null);
  const styles = cssUrls
    .map((url) => `<link rel="stylesheet" href="${escapeHtml(url)}">`)
    .join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="${viewport}">
<title>FieldWork</title>
<script>${themeBootstrap}</script>
${styles}
</head>
<body>
<div id="root"></div>
<script type="module" src="${escapeHtml(jsUrl)}"></script>
</body>
</html>
`;
}

function renderBuildNotice(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="${viewport}">
<title>FieldWork</title>
</head>
<body>
<main>
<h1>FieldWork</h1>
<p>The interactive interface needs the built frontend assets. Run <code>npm run build:web</code> and reload this page.</p>
</main>
</body>
</html>
`;
}
