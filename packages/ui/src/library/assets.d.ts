// Vite resolves image imports to hashed asset URL strings at build time.
declare module "*.jpg" {
  const src: string;
  export default src;
}
