import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureSession } from '../public/js/capture-session.js';

function mockSource() {
    return {
        method: 'test', stopped: false, closes: 0,
        async grab() { return { at: 42, bitmap: { width: 1920, height: 1080, close() {} } }; },
        stop() { this.stopped = true; this.closes++; },
    };
}

test('設定→再生→記録の利用権を切り替えても共有の選択は1回。全体停止だけが共有を止める', async () => {
    let opens = 0;
    const source = mockSource();
    const session = new CaptureSession(async () => { opens++; return source; });
    for (let i = 0; i < 3; i++) {
        const lease = await session.acquire();
        assert.equal((await lease.grab()).at, 42);
        lease.stop();
        assert.equal(source.stopped, false);
        assert.equal(await lease.grab(), null);
    }
    assert.equal(opens, 1);
    assert.deepEqual(session.size, { width: 1920, height: 1080 });
    session.stop();
    assert.equal(source.closes, 1);
    assert.equal(session.size, null);
});

test('同時に開始しても共有選択を重複させず、ブラウザ停止を各利用者へ1回通知する', async () => {
    let resolve;
    let ended;
    let opens = 0;
    let notifications = 0;
    const session = new CaptureSession((onEnded) => {
        opens++; ended = onEnded;
        return new Promise((r) => { resolve = r; });
    });
    const first = session.acquire(() => notifications++);
    const second = session.acquire(() => notifications++);
    resolve(mockSource());
    const leases = await Promise.all([first, second]);
    assert.equal(opens, 1);
    ended(); ended();
    assert.equal(notifications, 2);
    assert.ok(leases.every((l) => l.stopped));
    assert.equal(session.leases.size, 0);
});

test('フレーム待機中の個別停止は待機を解き、後から届いた画像を解放する', async () => {
    let resolve;
    let closed = 0;
    const source = mockSource();
    source.grab = () => new Promise((r) => { resolve = r; });
    const session = new CaptureSession(async () => source);
    const lease = await session.acquire();
    const grabbing = lease.grab();
    lease.stop();
    assert.equal(await grabbing, null);
    resolve({ bitmap: { close() { closed++; } } });
    await Promise.resolve(); await Promise.resolve();
    assert.equal(closed, 1);
    assert.equal(source.stopped, false);
});

test('共有選択中に全体停止したら、遅れて届く共有を閉じ、停止後に再開できる', async () => {
    let resolve;
    const session = new CaptureSession(() => new Promise((r) => { resolve = r; }));
    const pending = session.acquire();
    session.stop();
    const first = mockSource();
    resolve(first);
    await assert.rejects(pending, /停止/);
    assert.equal(first.stopped, true);
    const retry = session.acquire();
    resolve(mockSource());
    assert.equal((await retry).stopped, false);
});

test('共有選択をキャンセルした後でも、次の操作で共有できる', async () => {
    let attempts = 0;
    const session = new CaptureSession(async () => {
        if (++attempts === 1) { throw new Error('cancelled'); }
        return mockSource();
    });
    await assert.rejects(session.acquire(), /cancelled/);
    assert.ok(await session.acquire());
    assert.equal(attempts, 2);
});
