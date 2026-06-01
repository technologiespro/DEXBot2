#!/usr/bin/env node
// Shim: prefers compiled dist/credential-daemon.js, falls back to tsx for direct TS execution
'use strict';
const fs = require('fs');
const path = require('path');
const distTarget = path.join(__dirname, 'dist', 'credential-daemon.js');
if (fs.existsSync(distTarget)) {
  require(distTarget);
} else {
  require('tsx/cjs');
  require('./credential-daemon.ts');
}
