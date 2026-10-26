// Loss of OCR is not proof of leaving an instance. It does remove permission
// to start a new fight; prolonged loss without combat evidence clears stale state.
export class ContentPresence {
    constructor() { this.reset(); }
    reset() { this.confirmedAt = null; this.missingSince = null; }
    observe(at, confirmed) {
        if (confirmed) { this.confirmedAt = at; this.missingSince = null; }
        else { this.missingSince ??= at; }
    }
    canStart(at) { return this.confirmedAt !== null && this.missingSince === null && at - this.confirmedAt <= 6000; }
    shouldClear(at, combatEvidence) {
        return !combatEvidence && this.missingSince !== null && at - this.missingSince >= 6000;
    }
}
