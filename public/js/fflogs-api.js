// FFLogs API v2 をブラウザから直接使う（サーバーを通さない）。キーは利用者が FFLogs で作ったクライアントの ID と secret
// （client credentials。公開のレポートだけ読める）。トークンと API は vel.works からの通信を許可している（2026-10-20 に確認）。
// クエリの作りは partyscope（旧 logs2timeline。FFLogsService.php）と同じ: 地域は ja.fflogs.com、events は translate: true で日本語名、
// 敵の詠唱は hostilityType: Enemies（Casts では filterExpression の source.disposition が効かないため）。

const TOKEN_URL = 'https://ja.fflogs.com/oauth/token';
const API_URL = 'https://ja.fflogs.com/api/v2/client';
const MAX_PAGES = 30; // events のページ送りの上限（1 戦闘の敵の詠唱なら数ページで終わる）

export class FFLogsClient {
    constructor(clientId, clientSecret) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.token = null;
    }

    async getToken() {
        if (this.token) {
            return this.token;
        }
        const res = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                Authorization: `Basic ${btoa(`${this.clientId}:${this.clientSecret}`)}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: 'grant_type=client_credentials',
        });
        if (res.status === 401 || res.status === 400) {
            throw new Error('FFLogs のキー（クライアント ID と secret）が正しくありません');
        }
        if (!res.ok) {
            throw new Error(`FFLogs のトークンを取れませんでした（HTTP ${res.status}）`);
        }
        this.token = (await res.json()).access_token;
        return this.token;
    }

    async query(query, variables) {
        const res = await fetch(API_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${await this.getToken()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, variables }),
        });
        if (res.status === 429) {
            throw new Error('FFLogs の利用回数の上限に達しました（1 時間ほど待ってください）');
        }
        if (!res.ok) {
            throw new Error(`FFLogs に問い合わせできませんでした（HTTP ${res.status}）`);
        }
        const out = await res.json();
        if (out.errors?.length) {
            throw new Error(`FFLogs: ${out.errors.map((e) => e.message).join(' / ')}`);
        }
        return out.data;
    }
}

/** レポートの URL（またはコード）から { code, fight } を取り出す。fight は URL に無ければ null、"last" なら 'last' */
export function parseReportUrl(text) {
    const s = text.trim();
    const m = s.match(/reports\/([A-Za-z0-9]{16})/) ?? s.match(/^([A-Za-z0-9]{16})$/);
    if (!m) {
        return null;
    }
    const f = s.match(/[?#&]fight=(\d+|last)/);
    return { code: m[1], fight: f ? (f[1] === 'last' ? 'last' : Number(f[1])) : null };
}

/** レポートの戦闘の一覧（ボス戦だけ）、フェーズ名、敵と技の名前 */
export async function loadReport(client, code) {
    const data = await client.query(`query($code: String!) {
        reportData { report(code: $code) {
            title
            fights(killType: Encounters) {
                id name encounterID kill startTime endTime fightPercentage
                gameZone { id name }
                phaseTransitions { id startTime }
            }
            phases { encounterID phases { id name } }
            masterData(translate: true) { actors(type: "NPC") { id gameID name } abilities { gameID name } }
        } }
    }`, { code });
    const report = data.reportData.report;
    if (!report) {
        throw new Error('レポートが見つかりません（非公開のレポートは読めません）');
    }
    return report;
}

/** 1 戦闘の敵の詠唱（begincast と cast）。ページを送ってすべて取る */
export async function loadEnemyCasts(client, code, fight) {
    const events = [];
    let start = fight.startTime;
    for (let page = 0; start !== null && start !== undefined && page < MAX_PAGES; page++) {
        const data = await client.query(`query($code: String!, $fight: [Int], $start: Float, $end: Float) {
            reportData { report(code: $code) {
                events(fightIDs: $fight, startTime: $start, endTime: $end, dataType: Casts, hostilityType: Enemies, translate: true) {
                    data nextPageTimestamp
                }
            } }
        }`, { code, fight: [fight.id], start, end: fight.endTime });
        const page_ = data.reportData.report.events;
        events.push(...page_.data);
        start = page_.nextPageTimestamp;
    }
    return events;
}
