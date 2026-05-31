#!/usr/bin/env node
// Shim: prefers compiled dist/unlock.js, falls back to tsx for direct TS execution
'use strict';
const fs = require('fs');
const path = require('path');
const distTarget = path.join(__dirname, 'dist', 'unlock.js');
if (fs.existsSync(distTarget)) {
  require(distTarget);
} else {
  require('tsx').register();
  require('./unlock.ts');
}
