// 共有の寿命はアプリ全体。各画面には停止しても共有自体を終了しない利用権を渡す。
export class CaptureSession {
    constructor(open, onChange = () => {}) {
        this.open = open;
        this.onChange = onChange;
        this.source = null;
        this.pending = null;
        this.leases = new Set();
        this.size = null;
        this.generation = 0;
    }

    async acquire(onEnded = () => {}) {
        if (!this.source) {
            if (!this.pending) {
                const generation = this.generation;
                this.pending = this.open(() => this.stop()).then((source) => {
                    if (generation !== this.generation) {
                        source.stop();
                        throw new Error('画面共有は停止されました');
                    }
                    this.source = source;
                    this.onChange();
                    return source;
                }).finally(() => { this.pending = null; });
            }
            await this.pending;
        }
        const source = this.source;
        if (!source || source.stopped) {
            throw new Error('画面共有は停止されました');
        }
        let cancel;
        const stopped = new Promise((resolve) => { cancel = resolve; });
        const lease = {
            method: source.method,
            stopped: false,
            grab: async (minAt = 0) => {
                if (lease.stopped) { return null; }
                const grabbing = source.grab(minAt);
                const frame = await Promise.race([grabbing, stopped]);
                if (!frame) {
                    grabbing.then((late) => late?.bitmap.close()).catch(() => {});
                    return null;
                }
                if (lease.stopped) { frame.bitmap.close(); return null; }
                const size = { width: frame.bitmap.width, height: frame.bitmap.height };
                if (this.size?.width !== size.width || this.size?.height !== size.height) {
                    this.size = size;
                    this.onChange();
                }
                return frame;
            },
            stop: () => {
                if (lease.stopped) { return; }
                lease.stopped = true;
                cancel(null);
                this.leases.delete(lease);
            },
            ended: () => { lease.stop(); onEnded(); },
        };
        this.leases.add(lease);
        return lease;
    }

    stop() {
        this.generation++;
        const source = this.source;
        this.source = null;
        this.size = null;
        source?.stop();
        for (const lease of [...this.leases]) { lease.ended(); }
        this.onChange();
    }
}
