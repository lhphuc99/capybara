/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Server to connect to when the UI runs under `vite dev`, e.g. ws://localhost:7357 */
  readonly VITE_CAPYBARA_SERVER?: string;
}
