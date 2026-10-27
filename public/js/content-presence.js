// Loss of OCR is not proof of leaving an instance. It does remove permission
// to start a new fight; prolonged loss without combat evidence clears stale state.
// 戦闘中のムービーではコンテンツ名が 55〜66 秒読めない（2026-10-26 の録画: 絶もうひとつの未来 66 秒・絶オメガ 54〜62 秒）ので、
// 戦闘中は解除を長く待ち、その間は読み上げだけを止める
export const MISSING_CLEAR_MS = 6000; // 戦闘外: これだけ読めなければ解除
export const MISSING_CLEAR_COMBAT_MS = 180000; // 戦闘中: これだけ読めなければ解除（ムービーの最長の約 3 倍）
/**
 * 読み取りで決まったコンテンツ名のうち、いまの名前として採るもの（採らなければ null）。
 * single は 1 回の読み取りで決まった名前、combined は決まらなかった読み取りを足し合わせて決めた名前。
 * 足し合わせた名前は、1 回で決まった名前より弱いので、決まっている名前を別の名前に変えない（2026-10-27 ヘビー級1 零式:
 * 1 回の読み取りでは零式に決まるのに、足し合わせがノーマルを選んで 15 秒ごとに行き来し、そのたびにタイムラインを読み直した）。
 * 戦闘中は名前を変えない（タイムラインを読み直すと、戦闘の時刻とフェーズが消える）
 */
export function acceptContentName({ single = null, combined = null, current = null, inCombat = false }) {
    const name = single ?? (combined !== null && (current === null || combined === current) ? combined : null);
    if (name !== null && current !== null && name !== current && inCombat) {
        return null;
    }
    return name;
}

export class ContentPresence {
    constructor() { this.reset(); }
    reset() { this.confirmedAt = null; this.missingSince = null; }
    observe(at, confirmed) {
        if (confirmed) { this.confirmedAt = at; this.missingSince = null; }
        else { this.missingSince ??= at; }
    }
    // 1 回読めなかっただけでは止めない（戦闘開始の前後は背景のエフェクトで読めない回が続き、カウントダウンの予想時刻を逃した。2026-10-27）
    canStart(at) { return this.confirmedAt !== null && at - this.confirmedAt <= MISSING_CLEAR_MS; }
    shouldClear(at, combatEvidence, inCombat = false) {
        return !combatEvidence && this.missingSince !== null
            && at - this.missingSince >= (inCombat ? MISSING_CLEAR_COMBAT_MS : MISSING_CLEAR_MS);
    }
    /** 戦闘中に、解除までは待つが読み上げは止める（ムービー中か、気づかないうちにコンテンツを出たか分からない間） */
    shouldMute(at, combatEvidence) {
        return !combatEvidence && this.missingSince !== null && at - this.missingSince >= MISSING_CLEAR_MS;
    }
}
