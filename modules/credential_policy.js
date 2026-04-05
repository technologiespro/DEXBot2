/**
 * DEXBot2 Credential Daemon Policy Engine
 *
 * Evaluates policies before key material is decrypted. Inspired by OWS pattern.
 * Supports declarative rules (fast, in-process) + executable hooks (subprocess).
 * AND semantics: all policies must allow, or signing is denied.
 * Default-deny on errors: validation failures, executable timeouts, etc.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const POLICY_DENIED_PREFIX = 'POLICY_DENIED: ';
const EXECUTABLE_TIMEOUT_MS = 5000;

// BitShares operation types that DEXBot2 uses
const ALLOWED_OP_TYPES = [
    'transfer',
    'limit_order_create',
    'limit_order_cancel',
    'call_order_update',
    'liquidity_pool_exchange',
    'limit_order_update',
];

// Hardcoded fallback policy — now forces Strict Mode Granular constraints
const BUILTIN_DEFAULT_POLICY = Object.freeze({
    allowedOps: Object.freeze({
        limit_order_create: null,
        limit_order_cancel: null,
        limit_order_update: null,
        call_order_update: null,
        liquidity_pool_exchange: null,
        transfer: null
    }),
    maxOpsPerBatch: 200,
    allowedAssetIds: null,
    executable: null,
});

const policyCache = new Map();

/**
 * Load and parse daemon-policies.json. Returns normalized config or null on error.
 * On error, logs a warning and returns null (daemon will use BUILTIN_DEFAULT_POLICY).
 *
 * @param {string} filePath - Path to daemon-policies.json
 * @param {object} [options={}] - Options
 * @param {boolean} [options.forceReload=false] - If true, bypass cache and reload from disk
 */
function loadPolicyConfig(filePath, options = {}) {
    const forceReload = options.forceReload || false;
    if (!forceReload && policyCache.has(filePath)) {
        return policyCache.get(filePath);
    }

    try {
        if (!fs.existsSync(filePath)) {
            console.warn(`[policy] config file not found: ${filePath} — using builtin defaults`);
            policyCache.set(filePath, null);
            return null;
        }

        const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const { valid, errors } = validatePolicyConfig(raw);

        if (!valid) {
            console.warn(`[policy] config validation failed: ${errors.join('; ')} — using builtin defaults`);
            policyCache.set(filePath, null);
            return null;
        }

        policyCache.set(filePath, raw);
        return raw;
    } catch (error) {
        console.warn(`[policy] failed to load config: ${error.message} — using builtin defaults`);
        policyCache.set(filePath, null);
        return null;
    }
}

/**
 * Helper: check if value is an array of strings
 */
function isStringArray(v) {
    return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Helper: check if value is a positive integer
 */
function isPositiveInt(v) {
    return typeof v === 'number' && Number.isInteger(v) && v > 0;
}

/**
 * Validate per-operation constraints. Returns { errors: string[] }.
 * Constraint fields are validated based on operation type.
 */
function validateOpConstraints(opName, constraints) {
    const errors = [];

    // transfer
    if (opName === 'transfer') {
        if (constraints.allowedToAccounts !== undefined && !isStringArray(constraints.allowedToAccounts))
            errors.push('allowedToAccounts must be an array of strings');
        if (constraints.allowedAssets !== undefined && !isStringArray(constraints.allowedAssets))
            errors.push('allowedAssets must be an array of strings');
        if (constraints.maxAmount !== undefined && !isPositiveInt(constraints.maxAmount))
            errors.push('maxAmount must be a positive integer');
    }

    // Fields valid for limit_order_create and limit_order_update
    if (['limit_order_create', 'limit_order_update'].includes(opName)) {
        if (constraints.allowedSellAssets !== undefined) {
            if (!isStringArray(constraints.allowedSellAssets))
                errors.push('allowedSellAssets must be an array of strings');
        }
        if (constraints.allowedReceiveAssets !== undefined) {
            if (!isStringArray(constraints.allowedReceiveAssets))
                errors.push('allowedReceiveAssets must be an array of strings');
        }
    }

    // maxSellAmount, maxReceiveAmount, allowFillOrKill — only for limit_order_create
    if (opName === 'limit_order_create') {
        if (constraints.maxSellAmount !== undefined && !isPositiveInt(constraints.maxSellAmount))
            errors.push('maxSellAmount must be a positive integer');
        if (constraints.maxReceiveAmount !== undefined && !isPositiveInt(constraints.maxReceiveAmount))
            errors.push('maxReceiveAmount must be a positive integer');
        if (constraints.allowFillOrKill !== undefined && typeof constraints.allowFillOrKill !== 'boolean')
            errors.push('allowFillOrKill must be a boolean');
    }

    // maxDeltaSellAmount — only for limit_order_update
    if (opName === 'limit_order_update') {
        if (constraints.maxDeltaSellAmount !== undefined && !isPositiveInt(constraints.maxDeltaSellAmount))
            errors.push('maxDeltaSellAmount must be a positive integer');
    }

    // call_order_update
    if (opName === 'call_order_update') {
        if (constraints.allowedAssets !== undefined && !isStringArray(constraints.allowedAssets))
            errors.push('allowedAssets must be an array of strings');
        if (constraints.maxDeltaCollateral !== undefined && !isPositiveInt(constraints.maxDeltaCollateral))
            errors.push('maxDeltaCollateral must be a positive integer');
        if (constraints.maxDeltaDebt !== undefined && !isPositiveInt(constraints.maxDeltaDebt))
            errors.push('maxDeltaDebt must be a positive integer');
    }

    // liquidity_pool_exchange
    if (opName === 'liquidity_pool_exchange') {
        if (constraints.allowedPools !== undefined && !isStringArray(constraints.allowedPools))
            errors.push('allowedPools must be an array of strings');
        if (constraints.allowedSellAssets !== undefined && !isStringArray(constraints.allowedSellAssets))
            errors.push('allowedSellAssets must be an array of strings');
        if (constraints.allowedReceiveAssets !== undefined && !isStringArray(constraints.allowedReceiveAssets))
            errors.push('allowedReceiveAssets must be an array of strings');
        if (constraints.maxSellAmount !== undefined && !isPositiveInt(constraints.maxSellAmount))
            errors.push('maxSellAmount must be a positive integer');
    }

    // limit_order_cancel has no constraints

    return { errors };
}

/**
 * Validate raw policy config. Returns { valid: boolean, errors: string[] }.
 */
function validatePolicyConfig(raw) {
    const errors = [];

    if (typeof raw !== 'object' || raw === null) {
        errors.push('root must be an object');
        return { valid: false, errors };
    }

    // sessionTtlMs: optional positive integer
    if (raw.sessionTtlMs !== undefined) {
        if (typeof raw.sessionTtlMs !== 'number' || raw.sessionTtlMs <= 0) {
            errors.push('sessionTtlMs must be a positive integer');
        }
    }

    // default: optional policy object
    if (raw.default !== undefined) {
        if (typeof raw.default !== 'object' || raw.default === null) {
            errors.push('default must be an object');
        } else {
            const { valid: validDefault, errors: defaultErrors } = validatePolicyObject(raw.default);
            if (!validDefault) {
                errors.push(`default: ${defaultErrors.join('; ')}`);
            }
        }
    }

    // accounts: optional object of policies
    if (raw.accounts !== undefined) {
        if (typeof raw.accounts !== 'object' || Array.isArray(raw.accounts)) {
            errors.push('accounts must be an object');
        } else {
            for (const [accountName, policy] of Object.entries(raw.accounts)) {
                if (typeof policy !== 'object' || policy === null) {
                    errors.push(`accounts.${accountName} must be an object`);
                } else {
                    const { valid: validPolicy, errors: policyErrors } = validatePolicyObject(policy);
                    if (!validPolicy) {
                        errors.push(`accounts.${accountName}: ${policyErrors.join('; ')}`);
                    }
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Validate a single policy object (used by both default and per-account policies).
 */
function validatePolicyObject(policy) {
    const errors = [];

    // allowedOpTypes: must be array of strings
    if (policy.allowedOpTypes !== undefined) {
        if (!Array.isArray(policy.allowedOpTypes)) {
            errors.push('allowedOpTypes must be an array');
        } else if (!policy.allowedOpTypes.every((x) => typeof x === 'string')) {
            errors.push('allowedOpTypes must be an array of strings');
        }
    }

    // maxOpsPerBatch: must be positive integer
    if (policy.maxOpsPerBatch !== undefined) {
        if (typeof policy.maxOpsPerBatch !== 'number' || policy.maxOpsPerBatch <= 0) {
            errors.push('maxOpsPerBatch must be a positive integer');
        }
    }

    // allowedAssetIds: optional array of strings
    if (policy.allowedAssetIds !== undefined) {
        if (policy.allowedAssetIds !== null) {
            if (!Array.isArray(policy.allowedAssetIds)) {
                errors.push('allowedAssetIds must be an array or null');
            } else if (!policy.allowedAssetIds.every((x) => typeof x === 'string')) {
                errors.push('allowedAssetIds must be an array of strings');
            }
        }
    }

    // executable: optional string path or null
    if (policy.executable !== undefined) {
        if (policy.executable !== null && typeof policy.executable !== 'string') {
            errors.push('executable must be a string path or null');
        }
    }

    // botHmacSecret: optional 64-char hex string (32 bytes)
    if (policy.botHmacSecret !== undefined) {
        if (typeof policy.botHmacSecret !== 'string' || !/^[0-9a-f]{64}$/i.test(policy.botHmacSecret)) {
            errors.push('botHmacSecret must be a 64-char hex string (32 bytes)');
        }
    }

    // allowedOps: optional object keyed by op_name → constraints (object or null)
    if (policy.allowedOps !== undefined) {
        if (policy.allowedOps !== null) {
            if (typeof policy.allowedOps !== 'object' || Array.isArray(policy.allowedOps)) {
                errors.push('allowedOps must be an object or null');
            } else {
                for (const [opName, constraints] of Object.entries(policy.allowedOps)) {
                    if (constraints !== null) {
                        if (typeof constraints !== 'object' || Array.isArray(constraints)) {
                            errors.push(`allowedOps.${opName} must be an object or null`);
                        } else {
                            const { errors: cErrors } = validateOpConstraints(opName, constraints);
                            for (const e of cErrors) errors.push(`allowedOps.${opName}: ${e}`);
                        }
                    }
                }
            }
        }
    }

    return { valid: errors.length === 0, errors };
}

/**
 * Resolve the effective policy for an account by merging layers:
 * builtin default → config.default → config.accounts[accountName]
 */
function resolveAccountPolicy(config, accountName) {
    // Start with builtin
    let policy = JSON.parse(JSON.stringify(BUILTIN_DEFAULT_POLICY));

    // Layer on config.default
    if (config && config.default) {
        policy = { ...policy, ...config.default };
    }

    // Layer on config.accounts[accountName]
    if (config && config.accounts && config.accounts[accountName]) {
        policy = { ...policy, ...config.accounts[accountName] };
    }

    return policy;
}

/**
 * Build the PolicyContext passed to evaluatePolicy and to executable hooks.
 */
function buildPolicyContext(request) {
    return {
        accountName: request.accountName,
        requestType: request.type,
        sessionId: request.sessionId || null,
        timestamp: new Date().toISOString(),
        operations: request.operations || [],
    };
}

/**
 * Evaluate per-operation parameter constraints.
 * Returns { allow: boolean, reason: string|null, policyId: string }
 */
function evaluateOpConstraints(opName, opData, constraints) {
    if (!constraints) return { allow: true, reason: null, policyId: null };
    const d = opData || {};

    if (opName === 'transfer') {
        // allowedToAccounts
        if (constraints.allowedToAccounts) {
            if (!constraints.allowedToAccounts.includes(d.to)) {
                return {
                    allow: false,
                    reason: `transfer: recipient "${d.to}" not in allowedToAccounts`,
                    policyId: 'opParams',
                };
            }
        }
        // allowedAssets
        if (constraints.allowedAssets) {
            const id = d.amount && d.amount.asset_id;
            if (id && !constraints.allowedAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `transfer: asset "${id}" not in allowedAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // maxAmount
        if (constraints.maxAmount != null) {
            const amt = d.amount && d.amount.amount;
            if (typeof amt === 'number' && amt > constraints.maxAmount) {
                return {
                    allow: false,
                    reason: `transfer: amount ${amt} exceeds maxAmount ${constraints.maxAmount}`,
                    policyId: 'opParams',
                };
            }
        }
    }

    if (opName === 'limit_order_create') {
        // allowedSellAssets
        if (constraints.allowedSellAssets) {
            const id = d.amount_to_sell && d.amount_to_sell.asset_id;
            if (id && !constraints.allowedSellAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `limit_order_create: sell asset "${id}" not in allowedSellAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // allowedReceiveAssets
        if (constraints.allowedReceiveAssets) {
            const id = d.min_to_receive && d.min_to_receive.asset_id;
            if (id && !constraints.allowedReceiveAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `limit_order_create: receive asset "${id}" not in allowedReceiveAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // maxSellAmount
        if (constraints.maxSellAmount != null) {
            const amt = d.amount_to_sell && d.amount_to_sell.amount;
            if (typeof amt === 'number' && amt > constraints.maxSellAmount) {
                return {
                    allow: false,
                    reason: `limit_order_create: sell amount ${amt} exceeds maxSellAmount ${constraints.maxSellAmount}`,
                    policyId: 'opParams',
                };
            }
        }
        // maxReceiveAmount
        if (constraints.maxReceiveAmount != null) {
            const amt = d.min_to_receive && d.min_to_receive.amount;
            if (typeof amt === 'number' && amt > constraints.maxReceiveAmount) {
                return {
                    allow: false,
                    reason: `limit_order_create: receive amount ${amt} exceeds maxReceiveAmount ${constraints.maxReceiveAmount}`,
                    policyId: 'opParams',
                };
            }
        }
        // allowFillOrKill
        if (constraints.allowFillOrKill === false && d.fill_or_kill === true) {
            return {
                allow: false,
                reason: 'limit_order_create: fill_or_kill=true not permitted',
                policyId: 'opParams',
            };
        }
    }

    if (opName === 'limit_order_update') {
        // allowedSellAssets via new_price.base
        if (constraints.allowedSellAssets) {
            const id = d.new_price && d.new_price.base && d.new_price.base.asset_id;
            if (id && !constraints.allowedSellAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `limit_order_update: base asset "${id}" not in allowedSellAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // allowedReceiveAssets via new_price.quote
        if (constraints.allowedReceiveAssets) {
            const id = d.new_price && d.new_price.quote && d.new_price.quote.asset_id;
            if (id && !constraints.allowedReceiveAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `limit_order_update: quote asset "${id}" not in allowedReceiveAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // maxDeltaSellAmount (abs value)
        if (constraints.maxDeltaSellAmount != null) {
            const delta = d.delta_amount_to_sell && d.delta_amount_to_sell.amount;
            if (typeof delta === 'number' && Math.abs(delta) > constraints.maxDeltaSellAmount) {
                return {
                    allow: false,
                    reason: `limit_order_update: |delta| ${Math.abs(delta)} exceeds maxDeltaSellAmount ${constraints.maxDeltaSellAmount}`,
                    policyId: 'opParams',
                };
            }
        }
    }

    if (opName === 'call_order_update') {
        // allowedAssets
        if (constraints.allowedAssets) {
            const collId = d.delta_collateral && d.delta_collateral.asset_id;
            const debtId = d.delta_debt && d.delta_debt.asset_id;
            if (collId && !constraints.allowedAssets.includes(collId)) {
                return {
                    allow: false,
                    reason: `call_order_update: collateral asset "${collId}" not in allowedAssets`,
                    policyId: 'opParams',
                };
            }
            if (debtId && !constraints.allowedAssets.includes(debtId)) {
                return {
                    allow: false,
                    reason: `call_order_update: debt asset "${debtId}" not in allowedAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // maxDeltaCollateral
        if (constraints.maxDeltaCollateral != null) {
            const amt = d.delta_collateral && d.delta_collateral.amount;
            if (typeof amt === 'number' && Math.abs(amt) > constraints.maxDeltaCollateral) {
                return {
                    allow: false,
                    reason: `call_order_update: |delta_collateral| ${Math.abs(amt)} exceeds maxDeltaCollateral ${constraints.maxDeltaCollateral}`,
                    policyId: 'opParams',
                };
            }
        }
        // maxDeltaDebt
        if (constraints.maxDeltaDebt != null) {
            const amt = d.delta_debt && d.delta_debt.amount;
            if (typeof amt === 'number' && Math.abs(amt) > constraints.maxDeltaDebt) {
                return {
                    allow: false,
                    reason: `call_order_update: |delta_debt| ${Math.abs(amt)} exceeds maxDeltaDebt ${constraints.maxDeltaDebt}`,
                    policyId: 'opParams',
                };
            }
        }
    }

    if (opName === 'liquidity_pool_exchange') {
        // allowedPools
        if (constraints.allowedPools) {
            if (!constraints.allowedPools.includes(d.pool)) {
                return {
                    allow: false,
                    reason: `liquidity_pool_exchange: pool "${d.pool}" not in allowedPools`,
                    policyId: 'opParams',
                };
            }
        }
        // allowedSellAssets
        if (constraints.allowedSellAssets) {
            const id = d.amount_to_sell && d.amount_to_sell.asset_id;
            if (id && !constraints.allowedSellAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `liquidity_pool_exchange: sell asset "${id}" not in allowedSellAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // allowedReceiveAssets
        if (constraints.allowedReceiveAssets) {
            const id = d.min_to_receive && d.min_to_receive.asset_id;
            if (id && !constraints.allowedReceiveAssets.includes(id)) {
                return {
                    allow: false,
                    reason: `liquidity_pool_exchange: receive asset "${id}" not in allowedReceiveAssets`,
                    policyId: 'opParams',
                };
            }
        }
        // maxSellAmount
        if (constraints.maxSellAmount != null) {
            const amt = d.amount_to_sell && d.amount_to_sell.amount;
            if (typeof amt === 'number' && amt > constraints.maxSellAmount) {
                return {
                    allow: false,
                    reason: `liquidity_pool_exchange: sell amount ${amt} exceeds maxSellAmount ${constraints.maxSellAmount}`,
                    policyId: 'opParams',
                };
            }
        }
    }

    // limit_order_cancel — no constraints
    return { allow: true, reason: null, policyId: null };
}

/**
 * Evaluate a policy against a context. AND semantics: short-circuit on first denial.
 * Returns Promise<{ allow: boolean, reason: string|null, policyId: string|null }>
 */
async function evaluatePolicy(policy, context) {
    try {
        // Step 1: allowedOps check (if present) or allowedOpTypes fallback
        if (policy.allowedOps && typeof policy.allowedOps === 'object') {
            for (const op of context.operations) {
                if (!op || typeof op !== 'object') continue;
                const opName = op.op_name;

                // Check if op type is allowed
                if (!(opName in policy.allowedOps)) {
                    return {
                        allow: false,
                        reason: `op type "${opName}" not permitted`,
                        policyId: 'allowedOps',
                    };
                }

                // Get per-op constraints and evaluate
                const constraints = policy.allowedOps[opName];
                const result = evaluateOpConstraints(opName, op.op_data, constraints);
                if (!result.allow) {
                    return result;
                }
            }
        } else {
            // Fallback: allowedOpTypes check (backward compat)
            const allowed = policy.allowedOpTypes || [];
            for (const op of context.operations) {
                if (!op || typeof op !== 'object') continue;
                if (!allowed.includes(op.op_name)) {
                    return {
                        allow: false,
                        reason: `op type "${op.op_name}" not permitted`,
                        policyId: 'allowedOpTypes',
                    };
                }
            }
        }

        // Step 2: maxOpsPerBatch check
        {
            const max = policy.maxOpsPerBatch || 200;
            if (context.operations.length > max) {
                return {
                    allow: false,
                    reason: `batch size ${context.operations.length} exceeds maxOpsPerBatch ${max}`,
                    policyId: 'maxOpsPerBatch',
                };
            }
        }

        // Step 3: allowedAssetIds check (optional)
        if (policy.allowedAssetIds && Array.isArray(policy.allowedAssetIds) && policy.allowedAssetIds.length > 0) {
            const allowed = policy.allowedAssetIds;
            for (const op of context.operations) {
                if (!op || typeof op !== 'object') continue;

                const opData = op.op_data || {};

                // Check amount_to_sell asset (for create/update)
                if (opData.amount_to_sell && opData.amount_to_sell.asset_id) {
                    if (!allowed.includes(opData.amount_to_sell.asset_id)) {
                        return {
                            allow: false,
                            reason: `asset_id "${opData.amount_to_sell.asset_id}" not in allowlist`,
                            policyId: 'allowedAssetIds',
                        };
                    }
                }

                // Check min_to_receive asset (for create/update)
                if (opData.min_to_receive && opData.min_to_receive.asset_id) {
                    if (!allowed.includes(opData.min_to_receive.asset_id)) {
                        return {
                            allow: false,
                            reason: `asset_id "${opData.min_to_receive.asset_id}" not in allowlist`,
                            policyId: 'allowedAssetIds',
                        };
                    }
                }
            }
        }

        // Step 4: executable check (optional)
        if (policy.executable && typeof policy.executable === 'string') {
            const result = await evaluateExecutable(policy.executable, context);
            if (!result.allow) {
                return {
                    allow: false,
                    reason: result.reason || 'denied by executable',
                    policyId: 'executable',
                };
            }
        }

        // All checks passed
        return { allow: true, reason: null, policyId: null };
    } catch (error) {
        // Any evaluation error → deny
        return {
            allow: false,
            reason: `policy evaluation error: ${error.message}`,
            policyId: 'policy_eval_error',
        };
    }
}

/**
 * Spawn and evaluate a custom policy executable.
 * Executable receives PolicyContext JSON on stdin.
 * Must output { "allow": true/false, "reason": "..." } to stdout within 5 seconds.
 * Returns Promise<{ allow: boolean, reason: string|null }>
 */
function evaluateExecutable(exePath, context) {
    return new Promise((resolve) => {
        // Check file exists and is executable
        try {
            fs.accessSync(exePath, fs.constants.X_OK);
        } catch {
            return resolve({ allow: false, reason: `executable not found or not executable: ${exePath}` });
        }

        let stdout = '';
        let stderr = '';

        const child = spawn(exePath, [], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: EXECUTABLE_TIMEOUT_MS,
        });

        child.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        child.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        child.on('error', (error) => {
            if (error.code === 'ETIMEDOUT') {
                resolve({ allow: false, reason: `executable timed out after ${EXECUTABLE_TIMEOUT_MS}ms` });
            } else {
                resolve({ allow: false, reason: `executable spawn failed: ${error.message}` });
            }
        });

        child.on('close', (code, signal) => {
            if (signal === 'SIGTERM') {
                return resolve({ allow: false, reason: `executable timed out after ${EXECUTABLE_TIMEOUT_MS}ms` });
            }

            if (code !== 0) {
                const stderrMsg = stderr.trim() ? `: ${stderr.trim()}` : '';
                return resolve({ allow: false, reason: `executable exited with code ${code}${stderrMsg}` });
            }

            // Parse JSON output
            try {
                const result = JSON.parse(stdout.trim());
                if (typeof result.allow !== 'boolean') {
                    return resolve({ allow: false, reason: 'executable output missing "allow" field' });
                }
                resolve({
                    allow: result.allow,
                    reason: result.allow ? null : (result.reason || 'denied by executable'),
                });
            } catch (error) {
                resolve({ allow: false, reason: `executable output invalid JSON: ${error.message}` });
            }
        });

        // Send context to stdin
        try {
            child.stdin.write(JSON.stringify(context));
            child.stdin.end();
        } catch (error) {
            child.kill();
            resolve({ allow: false, reason: `failed to pipe context to executable: ${error.message}` });
        }
    });
}

/**
 * Load the botHmacSecret for an account from the policy config file.
 * @param {string} accountName - The account name
 * @param {string} policyConfigPath - Path to daemon-policies.json
 * @returns {string|null} The botHmacSecret, or null if not configured
 */
function loadBotHmacSecret(accountName, policyConfigPath) {
    let config = loadPolicyConfig(policyConfigPath);
    if (!config) config = {};
    if (!config.accounts) config.accounts = {};
    if (!config.accounts[accountName]) config.accounts[accountName] = {};

    let secret = config.accounts[accountName].botHmacSecret;

    if (!secret) {
        const newSecret = crypto.randomBytes(32).toString('hex');
        config.accounts[accountName].botHmacSecret = newSecret;
        
        fs.writeFileSync(policyConfigPath, JSON.stringify(config, null, 2), 'utf8');
        console.log(`[policy] Auto-provisioned strict botHmacSecret for ${accountName}`);

        try {
            // Check if credential daemon is running to reload config via SIGHUP
            const readyFile = path.join(__dirname, '..', 'profiles', 'runtime', 'credential-daemon.ready');
            if (fs.existsSync(readyFile)) {
                const info = JSON.parse(fs.readFileSync(readyFile, 'utf8'));
                if (info && info.pid) {
                    process.kill(info.pid, 'SIGHUP');
                    console.log(`[policy] Sent SIGHUP to credential daemon (pid ${info.pid}) to activate new secret`);
                }
            }
        } catch (e) {
            console.log(`[policy] Note: Could not send SIGHUP to daemon: ${e.message}`);
        }
        secret = newSecret;
    }
    return secret;
}

/**
 * Verify that the signing request was HMAC-signed by the bot holding botHmacSecret.
 * Session binding: HMAC includes sessionId, so replay is impossible across sessions.
 *
 * @param {object} request - Parsed request: { accountName, sessionId, operations, hmac }
 * @param {object|null} policyConfig - Loaded daemon-policies.json content
 * @returns {{ valid: boolean, reason: string|null, skipped: boolean }}
 *   skipped=true means no secret is configured (backward-compat, caller logs warning)
 */
function verifySourceHmac(request, policyConfig) {
    const accountPolicy =
        policyConfig && policyConfig.accounts && policyConfig.accounts[request.accountName];
    const secretHex = accountPolicy && accountPolicy.botHmacSecret;

    // Strict Mode Enforcement: Reject instantly if no secret is configured
    if (!secretHex) {
        return { valid: false, reason: 'Strict Mode: botHmacSecret missing in daemon-policies.json', skipped: false };
    }

    const providedHmac = request.hmac;
    if (!providedHmac || typeof providedHmac !== 'string') {
        return { valid: false, reason: 'missing hmac field', skipped: false };
    }

    // Canonical signing payload: must match exactly what the bot computed
    const signingPayload = JSON.stringify({
        sessionId: request.sessionId,
        operations: request.operations,
    });

    const expected = crypto
        .createHmac('sha256', Buffer.from(secretHex, 'hex'))
        .update(signingPayload)
        .digest('hex');

    try {
        const valid = crypto.timingSafeEqual(
            Buffer.from(expected, 'hex'),
            Buffer.from(providedHmac, 'hex'),
        );
        return { valid, reason: valid ? null : 'hmac mismatch', skipped: false };
    } catch {
        // Buffer.from throws if provided hmac is not valid hex or wrong length
        return { valid: false, reason: 'invalid hmac format', skipped: false };
    }
}

module.exports = {
    POLICY_DENIED_PREFIX,
    BUILTIN_DEFAULT_POLICY,
    loadPolicyConfig,
    validatePolicyConfig,
    resolveAccountPolicy,
    buildPolicyContext,
    evaluatePolicy,
    verifySourceHmac,
    loadBotHmacSecret,
};
