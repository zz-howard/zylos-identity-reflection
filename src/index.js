#!/usr/bin/env node
/**
 * zylos-identity-reflection
 *
 * Periodic self-reflection component for zylos agents
 */

import { getConfig, watchConfig, DATA_DIR } from './lib/config.js';

// Initialize
console.log(`[identity-reflection] Starting...`);
console.log(`[identity-reflection] Data directory: ${DATA_DIR}`);

// Load configuration
let config = getConfig();
console.log(`[identity-reflection] Config loaded, enabled: ${config.enabled}`);

if (!config.enabled) {
  console.log(`[identity-reflection] Component disabled in config, exiting.`);
  process.exit(0);
}

// Watch for config changes
watchConfig((newConfig) => {
  console.log(`[identity-reflection] Config reloaded`);
  config = newConfig;
  if (!newConfig.enabled) {
    console.log(`[identity-reflection] Component disabled, stopping...`);
    shutdown();
  }
});

// Main component logic
async function main() {
  // TODO: Implement your component logic here
  //
  // Communication components: set up platform SDK, listen for events, forward to C4
  // Capability components: start HTTP server or other service interface
  // Utility components: run task and exit (remove the keepalive below)

  console.log(`[identity-reflection] Running`);
}

// Graceful shutdown
function shutdown() {
  console.log(`[identity-reflection] Shutting down...`);
  // TODO: Close connections, stop listeners, cleanup
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Run
main().catch(err => {
  console.error(`[identity-reflection] Fatal error:`, err);
  process.exit(1);
});
