/**
 * modules/btsdex_event_patch.js - BitShares Event Subsystem Patch
 *
 * Monkey-patches btsdex event subsystem to keep account history in sync
 * and to re-register subscriptions after silent WebSocket auto-reconnects.
 *
 * Purpose:
 * - Ensures account data stays synchronized with blockchain
 * - Uses history API for efficient updates
 * - Patches btsdex/lib/event.updateAccounts method
 * - Re-calls Event.resubscribe() after WebSocket auto-reconnects so that
 *   fill events are not silently dropped after a connection reset
 *
 * ===============================================================================
 * EXPORTS (1 item)
 * ===============================================================================
 *
 * 1. patched - Boolean indicating if patch was successfully applied
 *    true: Patch applied successfully
 *    false: Patch failed (module not available)
 *
 * ===============================================================================
 *
 * IMPORT:
 * Simply importing this module applies the patch automatically:
 * require('./btsdex_event_patch');
 *
 * ===============================================================================
 *
 * RECONNECT RESUBSCRIPTION (why this is needed)
 * -----------------------------------------------
 * btsdex uses btsdex-api's internal auto-reconnect: when the WebSocket drops,
 * connection.js calls setTimeout(connectSocket, reconnectTimeout) which creates
 * a new WebSocket and re-runs onOpen, but it does NOT call Event.resubscribe().
 * Without resubscribe, two critical registrations are lost on the new connection:
 *   1. database.setSubscribeCallback - the global update pump for all events
 *   2. database.getFullAccounts(accounts, true) - account-level history tracking
 * Result: all fill events are silently dropped until the bot restarts.
 *
 * Fix: hook setNotifyStatusCallback from btsdex-api. It fires on every connection
 * status change ("open", "closing", "closed"). On "open" after initial connect has
 * already completed (Event.connected.init === true), call Event.resubscribe() to
 * re-register both subscriptions on the new WebSocket connection.
 */

const historyApi = require('btsdex-api').history;
const { setNotifyStatusCallback } = require('btsdex-api');

let patched = false;
let resubscribePatchApplied = false;
const verboseReconnectLogging = process.env.BTSDEX_EVENT_PATCH_VERBOSE === '1';

try {
    const eventModule = require('btsdex/lib/event');
    const accountModule = require('btsdex/lib/account');
    const EventClass = eventModule && (eventModule.default || eventModule);
    const accountHelpers = accountModule && (accountModule.default || accountModule);

    // Patch 1: getUpdate
    // Replaces btsdex's default implementation which assumes block.map.all
    // already exists. During reconnects, notice messages can arrive before the
    // event graph is fully rehydrated, which otherwise throws at
    // `this.block.map.all.events = []`.
    if (EventClass && typeof EventClass.getUpdate === 'function') {
        EventClass.getUpdate = function (updates) {
            if (!this.block) return;
            if (!this.block.map) this.block.map = {};
            if (!this.block.map.all) {
                this.block.map.all = {
                    subs: new Set(),
                    events: []
                };
            } else if (!Array.isArray(this.block.map.all.events)) {
                this.block.map.all.events = [];
            } else {
                this.block.map.all.events.length = 0;
            }

            const accountMap = this.account && this.account.map ? this.account.map : {};
            const ids = Object.keys(accountMap)
                .map(accName => accountMap[accName] && accountMap[accName].id)
                .filter(Boolean);
            const updateAcc = new Set();

            if (Array.isArray(updates)) {
                updates.forEach(array => {
                    if (!Array.isArray(array)) return;
                    array.forEach(obj => {
                        if (!obj || !obj.id) return;
                        if (obj.id === '2.1.0') {
                            this.block.map.all.events.push(obj);
                        } else if (/^2\.5\./.test(obj.id) && ids.includes(obj.owner)) {
                            updateAcc.add(obj.owner);
                        }
                    });
                });
            }

            if (typeof this.block.notify === 'function') this.block.notify();
            if (updateAcc.size > 0 && typeof this.updateAccounts === 'function') {
                this.updateAccounts(updateAcc);
            }
        };
        patched = true;
    }

    // Patch 2: updateAccounts
    // Replaces btsdex's default implementation which crashes on empty history
    // and does not handle missing account map entries gracefully.
    if (EventClass && typeof EventClass.updateAccounts === 'function') {
        EventClass.updateAccounts = async function (ids) {
            if (!this.account || !this.account.map) return;
            const updateAcc = new Set();
            for (const id of ids) {
                try {
                    const accNameInfo = await accountHelpers.id(id);
                    if (!accNameInfo || !accNameInfo.name) continue;
                    const name = accNameInfo.name;
                    const acc = this.account.map[name];
                    if (!acc) continue;
                    if (!acc.history) acc.history = '1.11.0';
                    let events = await historyApi.getAccountHistory(id, acc.history, 100, '1.11.0');
                    if (!Array.isArray(events)) events = [];
                    acc.events = events;
                    if (acc.events.length > 0 && acc.events[0] && acc.events[0].id) {
                        acc.history = acc.events[0].id;
                    } else {
                        acc.history = acc.history || '1.11.0';
                    }
                    updateAcc.add(name);
                } catch (err) {
                    console.error('event patch: failed to update account', id, err.message || err);
                }
            }
            if (updateAcc.size > 0) this.account.notify(updateAcc);
        };
        patched = true;
    }

    // Patch 3: resubscribe on silent auto-reconnect
    // btsdex-api's onClose calls setTimeout(connectSocket, reconnectTimeout)
    // for auto-reconnect, which re-runs onOpen but never calls Event.resubscribe().
    // We use setNotifyStatusCallback (fires on every connection status change) to
    // detect "open" after initial connect and call resubscribe ourselves.
    if (EventClass && typeof setNotifyStatusCallback === 'function') {
        let isInitialConnect = true;
        setNotifyStatusCallback((status) => {
            if (status === 'open') {
                if (isInitialConnect) {
                    // First connect: btsdex itself handles subscribeBlock/subscribeAccount
                    // via the Event init chain. Mark as done and skip.
                    isInitialConnect = false;
                } else {
                    // Subsequent connect: auto-reconnect happened. Re-register
                    // setSubscribeCallback and getFullAccounts(accounts, true).
                    if (verboseReconnectLogging) {
                        console.log('[btsdex_event_patch] WebSocket reconnected, calling Event.resubscribe()');
                    }
                    EventClass.resubscribe().catch(err => {
                        console.error('[btsdex_event_patch] resubscribe failed after reconnect:', err.message || err);
                    });
                }
            }
            // Return false so btsdex-api's auto-reconnect logic continues normally.
            return false;
        });
        resubscribePatchApplied = true;
    }
} catch (err) {
    console.warn('event patch: btsdex event not available', err.message || err);
}

module.exports = { patched, resubscribePatchApplied };
