// 読み上げ。ブラウザの声（Web Speech API。Windows・ブラウザに入っている声）と、VOICEVOX（利用者の PC で動かす
// 無料の読み上げソフト。http://127.0.0.1:50021 の API）を同じ形で使う。音量・速さはどちらにも効く。

export const DEFAULT_SPEECH = {
    engine: 'browser', // 'browser' | 'voicevox'
    voice: '', // ブラウザの声の名前（空なら日本語の既定の声）
    volume: 1, // 0〜1
    rate: 1, // 速さ（ブラウザ 0.5〜2、VOICEVOX は speedScale に同じ値）
    voicevoxUrl: 'http://127.0.0.1:50021',
    voicevoxSpeaker: null, // スタイルの id
    voicevoxName: '', // 表示・表記用（「VOICEVOX:ずんだもん」）
};

const CACHE_MAX = 64; // VOICEVOX で作った音声を覚えておく数（同じ技名を何度も読むため）
// ブラウザの声がこれだけ待っても読み始めなければ、詰まったとみなす（前の文を読んでいる間は待つので、短い文が続く程度では届かない長さ）
const START_TIMEOUT_MS = 8000;

/** 日本語を読める声（ブラウザ）。読み込みが遅れる環境があるので、無ければ voiceschanged を待って呼び直す */
export function japaneseVoices(win = window) {
    return win.speechSynthesis.getVoices()
        .filter((v) => /^ja\b|^ja-/i.test(v.lang))
        .map((v) => ({ name: v.name, local: v.localService, isDefault: v.default }));
}

/** VOICEVOX の話者とスタイルの一覧（[{ id, label }]。label は「ずんだもん（ノーマル）」） */
export async function voicevoxStyles(url) {
    const res = await fetch(new URL('speakers', withSlash(url)));
    if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
    }
    const speakers = await res.json();
    // 歌う用のスタイル（type が talk 以外）は読み上げに使えない
    return speakers.flatMap((s) => s.styles.filter((st) => (st.type ?? 'talk') === 'talk')
        .map((st) => ({ id: st.id, name: s.name, label: `${s.name}（${st.name}）` })));
}

const withSlash = (url) => (url.endsWith('/') ? url : `${url}/`);

export class Speech {
    /** @param {() => typeof DEFAULT_SPEECH} getSettings いまの設定（変えたらすぐ効くよう、毎回読む） */
    constructor(getSettings) {
        this.getSettings = getSettings;
        this.cache = new Map(); // `${url}|${speaker}|${rate}|${text}` → Promise<Blob>
        this.audio = null;
        this.generation = 0;
        this.speechWindows = new Set();
    }

    /** 作りかけ・読みかけの文言をすべて止める（作り終えた VOICEVOX の音声も鳴らさない） */
    cancel() {
        this.generation++;
        this.audio?.pause();
        for (const win of this.speechWindows) { win.speechSynthesis?.cancel(); }
        this.speechWindows.clear();
    }

    /**
     * 読み上げる。win は鳴らす窓（小窓が開いていれば小窓。止められにくいため）。
     * @returns {Promise<string|undefined>} ブラウザの声は読み始めたら使った声の名前で解決する。失敗したときは例外（呼ぶ側でログに出す）
     */
    async speak(text, win = window) {
        const generation = this.generation;
        for (const previous of this.speechWindows) { if (previous.closed) { this.speechWindows.delete(previous); } }
        this.speechWindows.add(win);
        const s = { ...DEFAULT_SPEECH, ...this.getSettings() };
        if (s.engine === 'voicevox' && s.voicevoxSpeaker !== null) {
            const blob = await this.synthesize(text, s);
            if (generation !== this.generation) { return; }
            this.audio?.pause();
            const audio = new win.Audio(URL.createObjectURL(blob));
            audio.volume = s.volume;
            audio.addEventListener('ended', () => URL.revokeObjectURL(audio.src), { once: true });
            this.audio = audio;
            await audio.play();
            return;
        }
        return this.speakBrowser(text, s, win);
    }

    /**
     * ブラウザの声で読む。読み始めたら解決し、失敗（始まらない・エラー）は例外にする（呼ぶ側でログに出す）。
     * @returns {Promise<string>} 使った声の名前
     */
    speakBrowser(text, s, win) {
        // 小窓では声の一覧が後から読み込まれ、選んだ声がまだ無いことがある。そのときは元の窓で鳴らす
        const has = (w) => w.speechSynthesis.getVoices().some((v) => v.name === s.voice);
        if (s.voice && win !== window && !has(win) && has(window)) {
            win = window;
            this.speechWindows.add(win); // 切り替えた先も cancel で止められるように
        }
        const synth = win.speechSynthesis;
        const utterance = new win.SpeechSynthesisUtterance(text);
        utterance.lang = 'ja-JP';
        utterance.volume = s.volume;
        utterance.rate = s.rate;
        const voice = s.voice && synth.getVoices().find((v) => v.name === s.voice);
        if (voice) {
            utterance.voice = voice;
        }
        const name = voice ? voice.name : `既定の声${s.voice ? `（${s.voice} が見つからない）` : ''}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                // Chrome の Google の声は、読み上げが詰まって以後鳴らなくなることがある。取り消して次から読めるようにする
                synth.cancel();
                reject(new Error(`${name}: ${START_TIMEOUT_MS / 1000} 秒たっても読み始めないので取り消しました`));
            }, START_TIMEOUT_MS);
            utterance.addEventListener('start', () => {
                clearTimeout(timer);
                resolve(name);
            });
            utterance.addEventListener('error', (e) => {
                clearTimeout(timer);
                // interrupted・canceled は取り消したときのもの
                if (e.error === 'interrupted' || e.error === 'canceled') {
                    resolve(name);
                } else {
                    reject(new Error(`${name}: ${e.error}`));
                }
            });
            synth.resume(); // 一時停止のまま残っていることがある（Chrome）
            synth.speak(utterance);
        });
    }

    /** これから読む文言を先に VOICEVOX で作っておく（発動の数秒前に読むので、作る時間で遅れないように） */
    prepare(texts) {
        const s = { ...DEFAULT_SPEECH, ...this.getSettings() };
        if (s.engine !== 'voicevox' || s.voicevoxSpeaker === null) {
            return;
        }
        for (const text of texts) {
            this.synthesize(text, s).catch(() => {}); // 失敗は読み上げるときに出す
        }
    }

    synthesize(text, s) {
        const key = `${s.voicevoxUrl}|${s.voicevoxSpeaker}|${s.rate}|${text}`;
        if (!this.cache.has(key)) {
            const job = (async () => {
                const base = withSlash(s.voicevoxUrl);
                const query = await fetchOk(new URL(`audio_query?${new URLSearchParams({ text, speaker: s.voicevoxSpeaker })}`, base), { method: 'POST' });
                const body = { ...(await query.json()), speedScale: s.rate };
                const wav = await fetchOk(new URL(`synthesis?${new URLSearchParams({ speaker: s.voicevoxSpeaker })}`, base), {
                    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
                });
                return wav.blob();
            })();
            job.catch(() => this.cache.delete(key)); // 失敗したものは覚えない（次に作り直す）
            this.cache.set(key, job);
            while (this.cache.size > CACHE_MAX) {
                this.cache.delete(this.cache.keys().next().value);
            }
        }
        return this.cache.get(key);
    }
}

async function fetchOk(url, init) {
    const res = await fetch(url, init);
    if (!res.ok) {
        throw new Error(`VOICEVOX が HTTP ${res.status} を返しました`);
    }
    return res;
}
