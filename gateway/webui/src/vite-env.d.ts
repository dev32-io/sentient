/// <reference types="vite/client" />

// Vite worker+url import — returns the URL of a bundled worker script as a string.
declare module "*?worker&url" {
  const url: string;
  export default url;
}
