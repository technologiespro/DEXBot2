const assert = require('assert');

require('../modules/btsdex_event_patch');

const eventModule = require('btsdex/lib/event');
const EventClass = eventModule && (eventModule.default || eventModule);

let blockNotifyCount = 0;
let updateAccountsArg = null;

EventClass.block = {
    map: {},
    notify() {
        blockNotifyCount += 1;
    }
};

EventClass.account = {
    map: {
        alice: { id: '1.2.345' }
    }
};

EventClass.updateAccounts = function (ids) {
    updateAccountsArg = ids;
};

EventClass.getUpdate([
    [
        { id: '2.1.0', head_block_number: 123 },
        { id: '2.5.9', owner: '1.2.345' }
    ]
]);

assert.ok(EventClass.block.map.all, 'block all handler should be initialized');
assert.strictEqual(EventClass.block.map.all.events.length, 1, 'block event should be recorded');
assert.strictEqual(EventClass.block.map.all.events[0].id, '2.1.0');
assert.strictEqual(blockNotifyCount, 1, 'block notify should fire once');
assert.ok(updateAccountsArg instanceof Set, 'account updates should be forwarded');
assert.ok(updateAccountsArg.has('1.2.345'), 'owner id should be queued for account update');

console.log('test_btsdex_event_patch: OK');
