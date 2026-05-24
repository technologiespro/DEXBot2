const path = require('path');

function isDistCodeRoot(codeRoot: string) {
    return path.basename(codeRoot) === 'dist';
}

function stripKnownExtension(fileName: string) {
    return fileName.replace(/\.(?:[cm]?js|ts)$/i, '');
}

function buildRuntimeScriptPath(codeRoot: string, scriptSegments: string[]) {
    if (!Array.isArray(scriptSegments) || scriptSegments.length === 0) {
        throw new Error('scriptSegments must contain at least one path segment');
    }

    const scriptExt = isDistCodeRoot(codeRoot) ? '.js' : '.ts';
    const normalizedSegments = [...scriptSegments];
    const lastSegment = normalizedSegments.pop() as string;
    normalizedSegments.push(`${stripKnownExtension(lastSegment)}${scriptExt}`);
    return path.join(codeRoot, ...normalizedSegments);
}

function buildRuntimeScriptArgs({
    codeRoot,
    scriptSegments,
    scriptArgs = [],
}: {
    codeRoot: string;
    scriptSegments: string[];
    scriptArgs?: string[];
}) {
    const scriptPath = buildRuntimeScriptPath(codeRoot, scriptSegments);
    if (isDistCodeRoot(codeRoot)) {
        return [scriptPath, ...scriptArgs];
    }
    return ['--import', 'tsx', scriptPath, ...scriptArgs];
}

export = {
    buildRuntimeScriptArgs,
    buildRuntimeScriptPath,
    isDistCodeRoot,
};
