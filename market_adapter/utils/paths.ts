'use strict';

const path = require('path');
const { BUILD_DIR } = require('../../modules/constants');

const _adapterDir = path.dirname(__dirname);
const _projectRoot = path.dirname(_adapterDir);
const PROJECT_ROOT = path.basename(_projectRoot) === BUILD_DIR ? path.dirname(_projectRoot) : _projectRoot;

export = {
    PROJECT_ROOT,
};
