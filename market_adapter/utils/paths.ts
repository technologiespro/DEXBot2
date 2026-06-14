'use strict';

const path = require('path');
const { resolveProjectRoot } = require('../../modules/launcher/runtime_entry');

const _adapterDir = path.dirname(__dirname);
const _projectRoot = path.dirname(_adapterDir);
const PROJECT_ROOT = resolveProjectRoot(_projectRoot);

export = {
    PROJECT_ROOT,
};
