import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Speech } from '../public/js/speech.js';
test('退出で取り消した後にVOICEVOXの合成が完了しても音を再生しない', async () => {
    const speech = new Speech(() => ({ engine: 'voicevox', voicevoxSpeaker: 1 }));
    let done;
    speech.synthesize = () => new Promise((resolve) => { done = resolve; });
    let cancelled = 0;
    const pending = speech.speak('前のコンテンツの予定', { speechSynthesis: { cancel() { cancelled++; } } });
    speech.cancel();
    done(new Blob([]));
    await pending; // Audio未定義のNodeでも、再生処理に到達しない
    assert.equal(speech.audio, null);
    assert.equal(cancelled, 1);
});
