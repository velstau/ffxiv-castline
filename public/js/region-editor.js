// 範囲の設定画面の部品。画面の全体図で大まかに囲み、拡大図で細かく直す（ドラッグで囲み直す・矢印キー・数値）。
// 直すたびにその範囲を試し読みして結果を出す（指定の大きさの目安になる）。保存は regions.js（画面の大きさごと）。
import { REGION_KINDS, regionsFor, setRegion, screenKey } from './regions.js';

const ZOOM_MAX = 4; // 拡大図の最大倍率
const ZOOM_MAX_HEIGHT = 520; // 拡大図の高さの上限（CSS px。敵対リストのような縦長の範囲で大きくなりすぎないように）
const CHECK_DELAY_MS = 300; // 直し終わってから試し読みするまで

export class RegionEditor {
    /**
     * @param {HTMLElement} root 中身はこの部品が作る
     * @param {{check: (id:string, rect:object, frame:ImageBitmap) => Promise<{ok:boolean|null, text:string}>,
     *          onChange?: (id:string) => void}} options
     */
    constructor(root, { check, onChange = () => {} }) {
        this.root = root;
        this.check = check;
        this.onChange = onChange;
        this.frame = null;
        this.regions = {};
        this.active = REGION_KINDS[0].id;
        this.view = null; // 拡大図に映している元画像の範囲
        this.results = {}; // 種類 → 試し読みの結果
        this.checkTimer = 0;
        this.build();
        this.render();
    }

    build() {
        this.root.innerHTML = `
            <div class="regions re-kinds" role="radiogroup" aria-label="範囲の種類"></div>
            <p class="re-rule"></p>
            <div class="row re-numbers">
                <label>x <input type="number" data-k="x" min="0" step="1"></label>
                <label>y <input type="number" data-k="y" min="0" step="1"></label>
                <label>幅 <input type="number" data-k="w" min="1" step="1"></label>
                <label>高さ <input type="number" data-k="h" min="1" step="1"></label>
                <button type="button" class="re-clear">この範囲を消す</button>
            </div>
            <p class="read-status re-check" role="status"></p>
            <p class="read-status re-empty"></p>
            <h3 class="re-h">拡大図</h3>
            <p class="read-status re-help">中をドラッグして囲み直す・矢印キーで 1px 動かす（Shift で 10px）・Alt＋矢印で右下の端を動かして大きさを変える</p>
            <canvas class="re-zoom" tabindex="0" aria-label="選んでいる範囲の拡大図"></canvas>
            <h3 class="re-h">画面の全体</h3>
            <p class="read-status re-help">ドラッグで大まかに囲む。囲んである範囲をクリックすると、その範囲を選ぶ</p>
            <div class="stage"><canvas class="re-overview" aria-label="取り込んだ画面"></canvas></div>`;
        const q = (sel) => this.root.querySelector(sel);
        this.el = {
            kinds: q('.re-kinds'), rule: q('.re-rule'), numbers: q('.re-numbers'), clear: q('.re-clear'),
            check: q('.re-check'), empty: q('.re-empty'), zoom: q('.re-zoom'), overview: q('.re-overview'),
        };
        for (const kind of REGION_KINDS) {
            const label = document.createElement('label');
            label.innerHTML = `<input type="radio" name="re-kind" value="${kind.id}"><span class="swatch" style="background:${kind.color}"></span>`
                + `${kind.label}<span class="re-size"></span>`;
            label.querySelector('input').addEventListener('change', () => this.select(kind.id));
            this.el.kinds.append(label);
        }
        this.el.numbers.querySelectorAll('input').forEach((input) => input.addEventListener('change', () => {
            const rect = this.regions[this.active];
            const value = Number(input.value);
            if (rect && Number.isFinite(value)) {
                this.setRect(this.active, { ...rect, [input.dataset.k]: value });
            }
        }));
        this.el.clear.addEventListener('click', () => this.setRect(this.active, null));
        this.setupOverview();
        this.setupZoom();
    }

    /** 範囲を指定する画面（ImageBitmap）を替える。前の画面は閉じる */
    setFrame(frame) {
        this.frame?.close?.();
        this.frame = frame;
        this.results = {};
        this.view = null;
        this.refresh();
        this.scheduleCheck(this.active);
    }

    /** 保存から読み直して描き直す（ファイルの読み込み・自動判定の後） */
    refresh() {
        this.regions = this.frame ? regionsFor(this.frame.width, this.frame.height) : {};
        this.render();
    }

    select(id) {
        this.active = id;
        this.view = null;
        this.render();
        if (!this.results[id]) {
            this.scheduleCheck(id);
        }
    }

    setRect(id, rect) {
        if (!this.frame) {
            return;
        }
        let saved = null;
        if (rect) {
            const x = clamp(Math.round(rect.x), 0, this.frame.width - 1);
            const y = clamp(Math.round(rect.y), 0, this.frame.height - 1);
            saved = {
                x, y,
                w: clamp(Math.round(rect.w), 1, this.frame.width - x),
                h: clamp(Math.round(rect.h), 1, this.frame.height - y),
            };
        }
        setRegion(this.frame.width, this.frame.height, id, saved);
        this.regions = regionsFor(this.frame.width, this.frame.height);
        delete this.results[id];
        this.render();
        this.onChange(id);
        this.scheduleCheck(id);
    }

    scheduleCheck(id) {
        clearTimeout(this.checkTimer);
        const rect = this.regions[id];
        if (!this.frame || !rect) {
            return;
        }
        this.checkTimer = setTimeout(async () => {
            this.results[id] = { ok: null, text: '試し読み中…' };
            this.renderCheck();
            let result;
            try {
                result = await this.check(id, rect, this.frame);
            } catch (e) {
                result = { ok: false, text: `試し読みできませんでした（${e.message}）` };
            }
            if (this.regions[id] === rect) { // 読んでいる間に直されていなければ出す
                this.results[id] = result;
                this.renderCheck();
            }
        }, CHECK_DELAY_MS);
    }

    // ── 描画 ──

    render() {
        const kind = REGION_KINDS.find((k) => k.id === this.active);
        const rect = this.regions[this.active];
        for (const label of this.el.kinds.children) {
            const input = label.querySelector('input');
            const r = this.regions[input.value];
            input.checked = input.value === this.active;
            label.querySelector('.re-size').textContent = r ? `（${r.w}×${r.h}）` : '（未指定）';
        }
        this.el.rule.textContent = `目安: ${kind.rule}`;
        this.el.numbers.querySelectorAll('input').forEach((input) => {
            input.value = rect ? rect[input.dataset.k] : '';
            input.disabled = !rect;
        });
        this.el.clear.disabled = !rect;
        this.el.empty.textContent = !this.frame
            ? '画面がありません。ゲーム画面の取り込みを始めるか、スクリーンショットを読み込んでください。'
            : `画面 ${screenKey(this.frame.width, this.frame.height)} の範囲です。${rect ? '' : '全体の図でドラッグして囲んでください。'}`;
        this.renderCheck();
        this.drawOverview();
        this.drawZoom();
    }

    renderCheck() {
        const result = this.results[this.active];
        this.el.check.textContent = this.regions[this.active] ? (result?.text ?? '') : '';
        this.el.check.className = `read-status re-check ${result?.ok === true ? 'ok' : result?.ok === false ? 'ng' : ''}`.trim();
    }

    drawOverview() {
        const canvas = this.el.overview;
        if (!this.frame) {
            canvas.width = 0;
            canvas.height = 0;
            return;
        }
        canvas.width = this.frame.width;
        canvas.height = this.frame.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(this.frame, 0, 0);
        const unit = Math.max(2, Math.round(this.frame.width / 800)); // 縮めて見せるので太めに
        const fontSize = Math.max(16, Math.round(this.frame.width / 55));
        ctx.font = `${fontSize}px sans-serif`;
        for (const kind of REGION_KINDS) {
            const r = kind.id === this.active && this.dragRect ? this.dragRect : this.regions[kind.id];
            if (!r) {
                continue;
            }
            ctx.lineWidth = kind.id === this.active ? unit * 2 : unit;
            ctx.strokeStyle = kind.color;
            ctx.strokeRect(r.x, r.y, r.w, r.h);
            ctx.fillStyle = kind.color;
            ctx.fillText(kind.label, r.x, Math.max(fontSize, r.y - unit * 2));
        }
    }

    // 拡大図に映す範囲: 選んでいる範囲の周りに余白を付けたもの。範囲が外に出たときだけ取り直す（ドラッグ中に動かないように）
    zoomView() {
        const rect = this.regions[this.active];
        if (!rect) {
            return null;
        }
        const inside = (v) => v && rect.x >= v.x && rect.y >= v.y && rect.x + rect.w <= v.x + v.w && rect.y + rect.h <= v.y + v.h;
        if (!inside(this.view)) {
            const pad = Math.max(24, Math.round(Math.max(rect.w, rect.h) * 0.5));
            const x = Math.max(0, rect.x - pad);
            const y = Math.max(0, rect.y - pad);
            this.view = {
                x, y,
                w: Math.min(this.frame.width, rect.x + rect.w + pad) - x,
                h: Math.min(this.frame.height, rect.y + rect.h + pad) - y,
            };
        }
        return this.view;
    }

    drawZoom() {
        const canvas = this.el.zoom;
        const view = this.frame && this.zoomView();
        canvas.hidden = !view;
        if (!view) {
            return;
        }
        const maxWidth = Math.max(200, this.root.clientWidth || 800);
        const scale = Math.min(ZOOM_MAX, maxWidth / view.w, ZOOM_MAX_HEIGHT / view.h);
        this.zoomScale = scale;
        canvas.width = Math.round(view.w * scale);
        canvas.height = Math.round(view.h * scale);
        canvas.style.width = `${canvas.width}px`; // CSS で伸び縮みさせない（1 画素がそのまま scale 倍に見える）
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.frame, view.x, view.y, view.w, view.h, 0, 0, canvas.width, canvas.height);
        const kind = REGION_KINDS.find((k) => k.id === this.active);
        const r = this.zoomDrag ?? this.regions[this.active];
        ctx.lineWidth = 2;
        ctx.strokeStyle = kind.color;
        ctx.strokeRect((r.x - view.x) * scale, (r.y - view.y) * scale, r.w * scale, r.h * scale);
        ctx.font = '16px sans-serif';
        ctx.fillStyle = kind.color;
        ctx.fillText(`${r.w}×${r.h}（${Math.round(scale * 100)}%）`, 4, 18);
    }

    // ── 操作 ──

    setupOverview() {
        const canvas = this.el.overview;
        let start = null;
        const toFrame = (ev) => {
            const box = canvas.getBoundingClientRect();
            return { x: (ev.clientX - box.left) * canvas.width / box.width, y: (ev.clientY - box.top) * canvas.height / box.height };
        };
        canvas.addEventListener('pointerdown', (ev) => {
            if (!this.frame) {
                return;
            }
            start = toFrame(ev);
            canvas.setPointerCapture(ev.pointerId);
        });
        canvas.addEventListener('pointermove', (ev) => {
            if (start) {
                this.dragRect = rectBetween(start, toFrame(ev));
                this.drawOverview();
            }
        });
        canvas.addEventListener('pointerup', (ev) => {
            if (!start) {
                return;
            }
            const end = toFrame(ev);
            const rect = rectBetween(start, end);
            start = null;
            this.dragRect = null;
            if (rect.w >= 4 && rect.h >= 4) {
                this.view = null;
                this.setRect(this.active, rect);
                return;
            }
            // クリック: 囲んである範囲の上なら、その範囲を選ぶ
            const hit = REGION_KINDS.find((k) => {
                const r = this.regions[k.id];
                return r && end.x >= r.x && end.x <= r.x + r.w && end.y >= r.y && end.y <= r.y + r.h;
            });
            if (hit) {
                this.select(hit.id);
            } else {
                this.drawOverview();
            }
        });
    }

    setupZoom() {
        const canvas = this.el.zoom;
        let start = null;
        const toFrame = (ev) => {
            const box = canvas.getBoundingClientRect();
            return {
                x: this.view.x + (ev.clientX - box.left) * this.view.w / box.width,
                y: this.view.y + (ev.clientY - box.top) * this.view.h / box.height,
            };
        };
        canvas.addEventListener('pointerdown', (ev) => {
            if (!this.view) {
                return;
            }
            canvas.focus();
            start = toFrame(ev);
            canvas.setPointerCapture(ev.pointerId);
        });
        canvas.addEventListener('pointermove', (ev) => {
            if (start) {
                this.zoomDrag = roundRect(rectBetween(start, toFrame(ev)));
                this.drawZoom();
            }
        });
        canvas.addEventListener('pointerup', (ev) => {
            if (!start) {
                return;
            }
            const rect = rectBetween(start, toFrame(ev));
            start = null;
            this.zoomDrag = null;
            if (rect.w >= 2 && rect.h >= 2) {
                this.setRect(this.active, rect); // 拡大図の中で囲み直す（拡大図に映す範囲はそのまま）
            } else {
                this.drawZoom();
            }
        });
        canvas.addEventListener('keydown', (ev) => {
            const rect = this.regions[this.active];
            const step = ev.shiftKey ? 10 : 1;
            const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[ev.key];
            if (!rect || !d) {
                return;
            }
            ev.preventDefault();
            this.setRect(this.active, ev.altKey
                ? { ...rect, w: rect.w + d[0], h: rect.h + d[1] } // 右下の端を動かす
                : { ...rect, x: rect.x + d[0], y: rect.y + d[1] });
        });
    }
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const roundRect = (r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });

function rectBetween(a, b) {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}
