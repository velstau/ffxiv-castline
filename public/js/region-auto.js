// 足りない範囲を、取り込んだ画面に出たものから自動で探して保存する（再生画面と初期設定の画面で共用）。
// コンテンツ名は入った直後、カウントダウンは告知が出たとき、HP・敵対リスト・詠唱バーは殴って戦闘になってから見つかる。
// 何の行かの判定は region-finder.js、文字認識は ocr-client.js（別スレッド。区画ごとに依頼するので、その間に読み取りが入れる）。
import { regionsFor, setRegion } from './regions.js';
import { tilesOf } from './screen-reader.js';
import { castNames } from './timeline-engine.js';
import {
    countdownSearchArea, findCountdownLine, countdownRegionFrom, classifyCombatLines, castSearchAreaNear, damagedHp,
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
// HP が 100% 未満の行が見えてからこの間は、戦闘中とみなす（戦闘の状態が分からない初期設定の画面や、
// カウントダウンなしで殴ったときのため）
const DAMAGE_COMBAT_MS = 30000;
const sameRect = (a, b) => Math.abs(a.x - b.x) <= a.h && Math.abs(a.y - b.y) <= a.h / 2;

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
     *   idleFullEveryMs?: number,
     * }} options casts: 詠唱バーとして照合する技名（タイムラインが無ければ空で、詠唱バーは探さない）。
     *   status: 戦闘の状態（null は分からない。初期設定の画面など）。カウントダウン中は読み取りを優先して、ほかを探さない。
     *   idleFullEveryMs: 戦闘外に画面全体を読む間隔（戦闘前の画面を覚えるため。読み取りと競わない初期設定の画面では短くする）
     *
     * HP・敵対リスト・詠唱バーは戦闘中（status が combat か、HP が 100% 未満の行が見えた）だけ探す。
     * 戦闘外に読んだ画面は「戦闘前から文字がある場所」として覚え、敵対リストの候補から外す（詠唱バーは名前・HP の行の近くに出るので外さない）。
     * HP は 2 回続けて同じ場所に見えたときだけ保存する（読み違いの 1 回で決めない）
     */
    constructor({ ocr, contents, casts, status = () => null, idleFullEveryMs = FULL_IDLE_EVERY_MS }) {
        Object.assign(this, { ocr, contents, casts, status, idleFullEveryMs });
        this.reset();
    }

    reset() {
        Object.assign(this, {
            lastContent: -Infinity, lastFull: -Infinity, lastNear: -Infinity, lastCountdown: -Infinity, lastDamageAt: -Infinity,
            enemyName: null, baseline: [], pendingHp: null,
        });
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
        } else if (at - this.lastFull >= (status === 'combat' || at - this.lastDamageAt < DAMAGE_COMBAT_MS ? FULL_EVERY_MS : this.idleFullEveryMs)) {
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
            const hp = damagedHp(lines);
            if (hp !== null && hp < 100) {
                this.lastDamageAt = at;
            }
            if (status !== 'combat' && at - this.lastDamageAt >= DAMAGE_COMBAT_MS) {
                // 戦闘外: 文字がある場所を覚えるだけ（画面全体を読んだときだけ。HP の周りだけを読んだときは覚え直さない）
                if (this.lastFull === at) {
                    this.baseline = lines.map(({ x, y, w, h }) => ({ x, y, w, h }));
                }
                this.pendingHp = null;
                return found;
            }
            const longestCast = Math.max(1, ...casts.map((n) => [...n].length));
            const r = classifyCombatLines(lines, {
                want, width, height, longestCast, hpRect: regions.hp ?? null, enmityRect: regions.enmity ?? null,
                enemyName: this.enemyName, baseline: this.baseline,
            });
            this.enemyName = r.enemyName ?? this.enemyName;
            if (r.hp) {
                if (this.pendingHp && sameRect(this.pendingHp, r.hp.rect)) {
                    const bar = r.hp.focus ? 'フォーカスターゲットの欄' : 'ターゲットの欄';
                    store('hp', r.hp.rect, r.hp.why === 'target' ? `HP（${bar}。ボスの欄かは確かめられていません）`
                        : `HP（ボス・${bar}。${r.hp.why === 'cast' ? '詠唱バー' : '敵対リストの名前'}で確かめました）`, r.hp.line);
                    this.pendingHp = null;
                } else {
                    this.pendingHp = r.hp.rect;
                }
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
