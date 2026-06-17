#!/usr/bin/env node
/**
 * Lightweight DB repair loop for portable Plex setups (no full vault server required).
 * Polls the Plex library DB and re-applies remote URLs after agent/scanner resets them.
 */
require('dotenv').config();

const { startPlexDbWatchdog } = require('../server/services/plex-db-watchdog');

console.log('[plex-repair-watch] watching vault library DB (Ctrl+C to stop)');
startPlexDbWatchdog();
