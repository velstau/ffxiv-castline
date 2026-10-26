// Playback's additional kill check. HUD visibility must still be confirmed from this frame.
import { killSuspected } from './cast-recorder.js';
export function needsKillConfirmation(engine, at, hasContentRegion) {
    return Boolean(hasContentRegion && !engine.enmityShown && engine.phase && (engine.phase.next ?? []).length === 0
        && engine.lastHpAt !== null && engine.enmityOffSince !== null
        && engine.lastHpAt >= engine.enmityOffSince - 5000 && killSuspected(engine, at));
}

// Restrict this to the centered completion banner, never arbitrary chat text.
export function isDutyCompleteText(lines) {
    const normalize = (text) => String(text).normalize('NFKC').toUpperCase().replace(/[\s!！・:：.。]/g, '');
    const exact = (text) => /^(?:DUTYCOMPLETE|COMPLETE|コンテンツコンプリート|コンプリート)$/.test(normalize(text));
    const texts = lines.map((line) => line.text ?? '');
    return texts.some(exact) || exact(texts.join(''));
}

export class ClearNoticeTracker {
    constructor() { this.reset(); }
    reset() { this.firstAt = null; this.lastAt = null; }
    observe(at, found) {
        if (!found) { this.reset(); return false; }
        if (this.lastAt === null || at - this.lastAt > 5000) { this.firstAt = at; }
        this.lastAt = at;
        return at - this.firstAt >= 500;
    }
}
