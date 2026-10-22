// 技名の一覧（public/data/castnames.json）が、配信のタイムラインと合っているか（作り直し忘れの検出）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

test('castnames.json はタイムラインの詠唱のある技名と同じ（違えば python3 tools/build-castnames.py）', () => {
    const dir = new URL('../public/timelines/', import.meta.url);
    const names = new Set();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.xml') && f !== 'index.xml')) {
        for (const [entry] of readFileSync(new URL(file, dir), 'utf8').matchAll(/<entry\b[^>]*>/g)) {
            const attr = (name) => entry.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
            if (Number(attr('duration') ?? 0) > 0) {
                const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
                unescape(attr('castname') ?? '').split('|').map((n) => n.trim()).filter(Boolean).forEach((n) => names.add(n));
            }
        }
    }
    const built = JSON.parse(readFileSync(new URL('../public/data/castnames.json', import.meta.url), 'utf8')).names;
    assert.deepEqual([...built].sort(), [...names].sort());
});
