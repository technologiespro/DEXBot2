const fs = require('fs');
const { assertPrivatePathSecurity } = require('../credential_runtime');

function readHeadlessPassword({ passwordFile }: { passwordFile?: string | null } = {}): string {
    let password: string | null = null;

    if (passwordFile) {
        try {
            assertPrivatePathSecurity(passwordFile, { expectedType: 'file', requiredMode: 0o400 });
            password = fs.readFileSync(passwordFile, 'utf8').trim().split('\n')[0];
        } catch (err: any) {
            throw new Error(`Cannot read master password from '${passwordFile}': ${err.message}`);
        }
        if (!password) {
            throw new Error(`Master password file '${passwordFile}' is empty`);
        }
    } else if (process.env.DEXBOT_MASTER_PASSWORD) {
        password = process.env.DEXBOT_MASTER_PASSWORD;
    }

    if (!password) {
        throw new Error(
            'Headless mode requires either --password-file <path> or DEXBOT_MASTER_PASSWORD env var'
        );
    }

    console.warn(
        '⚠️  WARNING: Running in headless mode. The master password is being read from a non-interactive source.\n' +
        '   This is less secure than interactive entry. Use only in trusted environments.'
    );

    return password;
}

export = {
    readHeadlessPassword,
};
