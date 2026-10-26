// 再生画面の「次にすること」。画面の状態から、手順ごとの状態（済み・いま・まだ・問題あり）と文を決める。
// DOM を触らない（テストのため）。描画は player.js の renderGuide

/** 手順の順番。optional は飛ばしてよい手順（「いまの手順」にはならず、ボタンはいつでも押せる） */
export const GUIDE_STEPS = [
    { id: 'setup', title: '読み取る範囲を決める（初期設定）' },
    { id: 'timeline', title: '使うタイムラインを選ぶ' },
    { id: 'tts', title: '読み上げを試す', optional: true },
    { id: 'capture', title: 'ゲーム画面の取り込みを始める' },
    { id: 'pip', title: '小窓で開く' }, // 小窓で使うのが前提（2026-10-21 のユーザーの指摘）。使えないブラウザでは飛ばす
    { id: 'play', title: 'ゲームに戻って戦闘を始める' },
];

/**
 * @param {object} c 画面の状態
 * @param {string[]} c.savedScreens 初期設定が済んだ画面の大きさ（「1920×1080」。コンテンツ名と戦闘の開始の範囲がある）
 * @param {{key:string, missing:{id:string,label:string}[]}|null} c.frame 取り込み中の画面の大きさと、指定していない範囲
 * @param {boolean} c.autoRegions 取り込み中に範囲を自動で探すか
 * @param {string} c.choice タイムラインの選択（'auto' | 'cloud:…' | 'local:…'）
 * @param {string} c.timelineLabel 使うタイムライン（決まっていなければ空）
 * @param {string|null} c.detectedContent 読み取ったコンテンツ名
 * @param {string} c.timelineError タイムラインを読めなかったときの文
 * @param {boolean} c.tts 読み上げが入っているか
 * @param {'ok'|'ng'|null} c.ttsTested 試験の結果（このページを開いてから）
 * @param {'loading'|'ready'|'error'} c.ocr 文字認識の準備
 * @param {number|null} c.ocrProgress ダウンロードの進み（0〜1）
 * @param {boolean} c.running 取り込み中か
 * @param {boolean} [c.shared] 画面を共有しているか（共有すると自動で取り込みを始める。省略は共有済みとして扱う）
 * @param {boolean} c.pipSupported 小窓が使えるブラウザか
 * @param {boolean} c.pipOpen 小窓が開いているか
 * @param {'idle'|'countdown'|'combat'|'ended'|null} c.engineState タイムラインの状態（タイムラインが無ければ null）
 * @returns {{steps:{id,title,optional,current:boolean,kind:'done'|'todo'|'ng',text:string}[], current:string|null}}
 *   current は、飛ばせない手順のうち最初の済んでいないもの（全部済めば null）
 */
export function guideSteps(c) {
    const s = {};
    // 読み取る範囲: 取り込み中はその画面の大きさで、取り込む前は保存した範囲で見る
    if (c.frame) {
        const missing = c.frame.missing;
        const noStart = missing.some((m) => m.id === 'start');
        s.setup = missing.length === 0
            ? { done: true, text: `画面 ${c.frame.key} の範囲はすべて決めてあります。` }
            : {
                done: !noStart,
                ng: noStart && !c.autoRegions,
                text: `画面 ${c.frame.key} で未指定: ${missing.map((m) => m.label).join('、')}。`
                    + (c.autoRegions ? 'ゲームの画面に出れば自動で探します。' : '初期設定で決めてください。'),
            };
    } else if (c.savedScreens.length > 0) {
        s.setup = { done: true, text: `済み（画面 ${c.savedScreens.join('・')}）。取り込みを始めると、その画面の大きさで確かめます。` };
    } else {
        s.setup = { done: false, text: 'まだ決めていません。' };
    }

    if (c.timelineError) {
        s.timeline = { done: false, ng: true, text: c.timelineError };
    } else if (c.timelineLabel) {
        s.timeline = { done: true, text: `「${c.timelineLabel}」を使います。` };
    } else if (c.choice === 'auto' && c.detectedContent) {
        s.timeline = { done: false, ng: true, text: `「${c.detectedContent}」のタイムラインがありません。一覧から選ぶか、手元の XML を読み込んでください。` };
    } else if (c.choice === 'auto') {
        s.timeline = { done: true, text: '自動で選びます（取り込みを始めて、コンテンツ名を読み取ったら決まります）。' };
    } else {
        s.timeline = { done: false, text: '選んだタイムラインを読み込んでいます…' };
    }

    s.tts = !c.tts
        ? { done: true, text: '読み上げは切ってあります。' }
        : c.ttsTested === 'ok' ? { done: true, text: '声が出ることを確かめました。' }
            : c.ttsTested === 'ng' ? { done: false, ng: true, text: '読み上げられませんでした。下の「記録」に理由が出ています。' }
                : { done: false, text: 'まだ試していません。' };

    s.capture = c.running
        ? { done: true, text: '読み取り中です。' }
        : c.shared === false ? { done: false, text: 'まだ画面を共有していません。「画面を共有」でゲームのウィンドウを選ぶと、自動で読み取りを始めます。' }
        : c.ocr === 'error' ? { done: false, ng: true, text: '文字認識のモデルを読み込めませんでした。ページを読み込み直してください。' }
            : c.ocr === 'loading' ? { done: false, text: `文字認識の準備をしています…${c.ocrProgress ? `（${Math.round(c.ocrProgress * 100)}%）` : ''}` }
                : { done: false, text: '準備ができました。「読み取りを始める」を押してください。' };

    s.pip = !c.pipSupported
        ? { done: true, ng: true, text: 'このブラウザでは使えません（Chrome か Edge の新しい版で使えます）。この画面の「タイムライン」で見てください。' }
        : c.pipOpen ? { done: true, text: '小窓を開いています。' } : { done: false, text: '開いていません。' };

    const PLAY_TEXT = {
        idle: 'カウントダウンか、戦闘の開始（敵対リスト）を待っています。',
        countdown: 'カウントダウン中です。',
        combat: '戦闘中です。タイムラインが流れています。',
        ended: '戦闘が終わりました。次のカウントダウンか戦闘を待っています。',
    };
    s.play = !c.running
        ? { done: false, text: '取り込みを始めてから、ゲームに戻ります。' }
        : !c.engineState ? { done: false, text: 'タイムラインが決まると流れます。' }
            : { done: c.engineState === 'combat', text: PLAY_TEXT[c.engineState] };

    const current = GUIDE_STEPS.find((g) => !g.optional && !s[g.id].done)?.id ?? null;
    return {
        current,
        steps: GUIDE_STEPS.map((g) => ({
            id: g.id,
            title: g.title,
            optional: Boolean(g.optional),
            current: g.id === current,
            kind: s[g.id].ng ? 'ng' : s[g.id].done ? 'done' : 'todo',
            text: s[g.id].text,
        })),
    };
}
