/// <reference types="vite/client" />

/**
 * Vite's `?url` imports, which hand back the built asset's path as a string.
 *
 * Declared here because TypeScript has no idea what a query string on an import
 * specifier means; without this, importing pdf.js's worker — the one thing that
 * has to be a URL rather than a module — fails to typecheck.
 */
declare module '*?url' {
  const url: string;
  export default url;
}
