// 足りない範囲を、取り込んだ画面に出たものから自動で探して保存する（再生画面と初期設定の画面で共用）。
// コンテンツ名は入った直後、カウントダウンは告知が出たとき、HP・敵対リスト・詠唱バーは殴って戦闘になってから見つかる。
// 何の行かの判定は region-finder.js、文字認識は ocr-client.js（別スレッド。区画ごとに依頼するので、その間に読み取りが入れる）。
import { regionsFor, setRegion } from './regions.js';
import { tilesOf } from './screen-reader.js';
import { castNames } from './timeline-engine.js';
import {
    countdownSearchArea, findCountdownLine, countdownRegionFrom, classifyCombatLines, castSearchAreaNear,
} from './region-finder.js';

const CONTENT_EVERY_MS = 5000;
const FULL_EVERY_MS = 6000; // 画面全体を読む間隔（1 回 5〜6 秒かかる）
// 戦闘外の間隔。HP の % は殴ったあとにしか出ないので戦闘外は間を空けるが、止めはしない
// （敵対リストもカウントダウンも無いと、殴っても戦闘になったと分からないため）
const FULL_IDLE_EVERY_MS = 15000;
const NEAR_EVERY_MS = 2000; // 詠唱バーだけ残ったら、HP の近くを短い間隔で読む（詠唱は数秒で消えるため）
// カウントダウンを探す間隔。戦闘中と判定していても探す（ずれた範囲で戦闘中と誤って判定していることがあるため。
// 2026-10-21 実測: 古い敵対リストの範囲で戦闘開始になり、範囲を消したあとも戦闘中のままで、カウントダウンを探さなかった）
const COUNTDOWN_EVERY_MS = 1000;
const COUNTDOWN_COMBAT_EVERY_MS = 3000;

/** タイムラインの技名のうち、詠唱バーに出るもの（詠唱のある技） */
export function castNamesOf(timeline) {
    const names = new Set();
    for (const phase of timeline?.phases ?? []) {
        for (const e of phase.entries) {
            if (e.duration > 0 && e.sync !== false) {
                castNames(e.name).forEach((n) => names.add(n));
            }
        }
    }
    return [...names];
}

/** 範囲を決めた行と範囲（ログ用の文） */
export function foundDetail({ label, line, rect }) {
    return `${label}: ${line ? `「${line.text}」の行（x ${Math.round(line.x)}・y ${Math.round(line.y)}）から` : ''}`
        + `範囲 x ${rect.x}・y ${rect.y}・幅 ${rect.w}・高さ ${rect.h}`;
}

export class RegionAutoFinder {
    /**
     * @param {{
     *   ocr: import('./ocr-client.js').OcrClient,
     *   contents: () => string[],
     *   casts: () => string[],
     *   status?: (at:number) => ('idle'|'countdown'|'combat'|'ended'|null),
     * }} options casts: 詠唱バーとして照合する技名（タイムラインが無ければ空で、詠唱バーは探さない）。
     *   status: 戦闘の状態（null は分からない。初期設定の画面など）。カウントダウン中は読み取りを優先して、ほかを探さない
     */
    constructor({ ocr, contents, casts, status = () => null }) {
        Object.assign(this, { ocr, contents, casts, status });
        this.reset();
    }

    reset() {
        Object.assign(this, { lastContent: -Infinity, lastFull: -Infinity, lastNear: -Infinity, lastCountdown: -Infinity, enemyName: null });
    }

    /**
     * 1 フレーム分探す。見つけた範囲は保存してから返す。
     * @param {() => boolean} [live] false になったら途中でやめる（取り込みを止めた・自動で探すのを切った）
     * @returns {Promise<{id:string, label:string, rect:{x,y,w,h}, line:object|null, name?:string}[]>}
     *          name はコンテンツ名・詠唱バーで見つけた名前
     */
    async step(frame, at, live = () => true) {
        const { width, height } = frame;
        const regions = regionsFor(width, height);
        const found = [];
        const store = (id, rect, label, line = null, name = undefined) => {
            setRegion(width, height, id, rect);
            found.push({ id, label, rect, line, name });
        };
        const status = this.status(at);

        // カウントダウンは出ている時間が短い（15 秒ほど）ので、コンテンツ名より先に探す
        if (!regions.countdown && live()
            && at - this.lastCountdown >= (status === 'combat' ? COUNTDOWN_COMBAT_EVERY_MS : COUNTDOWN_EVERY_MS)) {
            this.lastCountdown = at;
            const line = findCountdownLine(await this.ocr.scanLines(frame, countdownSearchArea(width, height)));
            if (line && live()) {
                store('countdown', countdownRegionFrom(line, width, height), 'カウントダウン', line);
            }
        }
        // カウントダウンを見つけた回とカウントダウン中は、ほかを探さない（文字認識を読み取りに空け、残り秒数を読み逃さない）
        if (found.length > 0 || status === 'countdown') {
            return found;
        }

        if (!regions.content && at - this.lastContent >= CONTENT_EVERY_MS && live()) {
            this.lastContent = at;
            const hit = await this.ocr.findContent(frame, this.contents());
            if (hit && live()) {
                store('content', hit.rect, `コンテンツ名（${hit.name}）`, null, hit.name);
            }
        }

        const casts = this.casts();
        const want = new Set(['hp', 'enmity', 'cast'].filter((id) => !regions[id] && (id !== 'cast' || casts.length > 0)));
        if (want.size === 0 || !live()) {
            return found;
        }
        let lines = null;
        if (want.size === 1 && want.has('cast') && regions.hp && at - this.lastNear >= NEAR_EVERY_MS) {
            this.lastNear = at;
            lines = await this.ocr.scanLines(frame, castSearchAreaNear(regions.hp, width, height), casts);
        } else if (at - this.lastFull >= (status === 'combat' || status === null ? FULL_EVERY_MS : FULL_IDLE_EVERY_MS)) {
            this.lastFull = at;
            lines = [];
            for (const tile of tilesOf(frame)) {
                if (!live()) {
                    return found;
                }
                const part = await this.ocr.scanLines(frame, tile, want.has('cast') ? casts : []);
                // 区画の重なりで同じ行を 2 回読んだものは 1 つにする
                lines.push(...part.filter((l) => !lines.some((o) => o.text === l.text
                    && Math.abs(o.x - l.x) < l.h && Math.abs(o.y - l.y) < l.h / 2)));
            }
        }
        if (lines && live()) {
            const longestCast = Math.max(1, ...casts.map((n) => [...n].length));
            const r = classifyCombatLines(lines, { want, width, height, longestCast, hpRect: regions.hp ?? null, enemyName: this.enemyName });
            this.enemyName = r.enemyName ?? this.enemyName;
            if (r.hp) {
                store('hp', r.hp.rect, r.hp.focus ? 'HP（フォーカスターゲット）' : `HP${r.hp.others > 0 ? '（ターゲット）' : ''}`, r.hp.line);
            }
            if (r.enmity) {
                store('enmity', r.enmity.rect, '敵対リスト', r.enmity.line);
            }
            if (r.cast) {
                store('cast', r.cast.rect, `詠唱バー（${r.cast.name}）`, r.cast.line, r.cast.name);
            }
        }
        return found;
    }
}
