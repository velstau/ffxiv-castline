// 配信のタイムラインの gimmick_icon が、用意したアイコン（gimmick-icons.js）に当たるか（tools/apply-gimmick-icons.py の規則の誤りの検出）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { gimmickIcon } from '../public/js/gimmick-icons.js';

test('配信のタイムラインの gimmick_icon は全部、用意したアイコン', () => {
    const dir = new URL('../public/timelines/', import.meta.url);
    const unknown = new Set();
    let count = 0;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.xml') && f !== 'index.xml')) {
        for (const [, icon] of readFileSync(new URL(file, dir), 'utf8').matchAll(/\sgimmick_icon="([^"]*)"/g)) {
            count++;
            if (!gimmickIcon(icon)) {
                unknown.add(`${file}: ${icon}`);
            }
        }
    }
    assert.ok(count > 0);
    assert.deepEqual([...unknown], []);
});
