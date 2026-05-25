const chainKeys = require('../chain_keys');

function normalizeBootstrapCredential(credential: any): any {
    if (chainKeys.isVaultSecret(credential)) {
        return credential;
    }

    if (credential && typeof credential === 'object' && typeof credential.vaultKeyHex === 'string') {
        return credential;
    }

    if (typeof credential === 'string' && credential.length > 0) {
        return chainKeys.unlockWithPassword(credential);
    }

    throw new Error('Invalid bootstrap credential payload');
}

export = {
    normalizeBootstrapCredential,
};
