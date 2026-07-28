export class MemoryJournal {
    events = [];
    async append(event) {
        this.events.push(event);
    }
    async readValidated() {
        return this.events;
    }
}
