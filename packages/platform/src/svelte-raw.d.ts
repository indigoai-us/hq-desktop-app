/**
 * Svelte sources loaded as raw text (`?raw`) so static guard tests can scan a
 * UI component without a Node fs dependency in this package.
 */
declare module "*.svelte?raw" {
  const contents: string;
  export default contents;
}
