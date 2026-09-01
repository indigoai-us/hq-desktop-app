// Vite resolves bundled raster imports to hashed URL strings (see
// setup-welcome-art.ts). Mirrors library/assets.d.ts for the WebP heroes.
declare module "*.webp" {
  const src: string;
  export default src;
}
