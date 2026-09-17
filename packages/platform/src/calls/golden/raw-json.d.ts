/**
 * Golden vectors are loaded as raw text (`?raw`) rather than parsed JSON so the
 * tests can hash the exact bytes copied from hq-pro and compare them against
 * PROVENANCE.json. Parsing happens explicitly in ./index.ts.
 */
declare module "*.json?raw" {
  const contents: string;
  export default contents;
}
