
const EventEmitter = require('events');

class DataStore extends EventEmitter {
    constructor() {
        super();
        this.records = new Map();
        this.transactionActive = false;
        this.pendingChanges = [];
    }

    beginTransaction() {
        if (this.transactionActive) throw new Error("Transaction already active");
        this.transactionActive = true;
        this.pendingChanges = [];
        this.emit('transactionStart');
    }

    commit() {
        if (!this.transactionActive) throw new Error("No active transaction");
        for (const {key, value} of this.pendingChanges) {
            this.records.set(key, value);
        }
        this.transactionActive = false;
        this.pendingChanges = [];
        this.emit('transactionCommit');
    }

    rollback() {
        if (!this.transactionActive) throw new Error("No active transaction");
        this.transactionActive = false;
        this.pendingChanges = [];
        this.emit('transactionRollback');
    }

    set(key, value) {
        if (this.transactionActive) {
            this.pendingChanges.push({key, value});
        } else {
            this.records.set(key, value);
            this.emit('change', key, value);
        }
    }

    get(key) {
        if (this.transactionActive) {
            const pending = this.pendingChanges.find(p => p.key === key);
            if (pending) return pending.value;
        }
        return this.records.get(key);
    }
}

module.exports = DataStore;
