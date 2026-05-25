'use strict';

const path = require('path');

const _adapterDir = path.dirname(__dirname);
const _projectRoot = path.dirname(_adapterDir);
const PROJECT_ROOT = path.basename(_projectRoot) === 'dist' ? path.dirname(_projectRoot) : _projectRoot;

export = {
    PROJECT_ROOT,
};
