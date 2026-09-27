import type { CloudConfig } from '../core/cloudConfig';

// Filled in at build time by vite.config.ts from cloud.config.json (empty = local-only mode).
declare const __CLOUD_URL__: string;
declare const __CLOUD_KEY__: string;

let config: CloudConfig = { url: __CLOUD_URL__, anonKey: __CLOUD_KEY__ };

/** True when this build uses the shared database (every phone sees the same menu and bills). */
export function cloudEnabled(): boolean {
  return config.url !== '' && config.anonKey !== '';
}

export function cloudConfig(): CloudConfig {
  return config;
}

/** Tests only: switch shared mode on or off. */
export function setCloudConfigForTests(c: CloudConfig): void {
  config = c;
}
