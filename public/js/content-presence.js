// Loss of OCR is not proof of leaving an instance. It does remove permission
// to start a new fight; prolonged loss without combat evidence clears stale state.
// 戦闘中のムービーではコンテンツ名が 55〜66 秒読めない（2026-10-26 の録画: 絶もうひとつの未来 66 秒・絶オメガ 54〜62 秒）ので、
// 戦闘中は解除を長く待ち、その間は読み上げだけを止める
export const MISSING_CLEAR_MS = 6000; // 戦闘外: これだけ読めなければ解除
export const MISSING_CLEAR_COMBAT_MS = 180000; // 戦闘中: これだけ読めなければ解除（ムービーの最長の約 3 倍）
export class ContentPresence {
    constructor() { this.reset(); }
    reset() { this.confirmedAt = null; this.missingSince = null; }
    observe(at, confirmed) {
        if (confirmed) { this.confirmedAt = at; this.missingSince = null; }
        else { this.missingSince ??= at; }
    }
    canStart(at) { return this.confirmedAt !== null && this.missingSince === null && at - this.confirmedAt <= MISSING_CLEAR_MS; }
    shouldClear(at, combatEvidence, inCombat = false) {
        return !combatEvidence && this.missingSince !== null
            && at - this.missingSince >= (inCombat ? MISSING_CLEAR_COMBAT_MS : MISSING_CLEAR_MS);
    }
    /** 戦闘中に、解除までは待つが読み上げは止める（ムービー中か、気づかないうちにコンテンツを出たか分からない間） */
    shouldMute(at, combatEvidence) {
        return !combatEvidence && this.missingSince !== null && at - this.missingSince >= MISSING_CLEAR_MS;
    }
}
