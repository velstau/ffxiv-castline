// FFLogs の 1 戦闘の敵の詠唱から、タイムライン（エンジンの形）を組み立てる。DOM も通信も使わない（node でテストする）。
//
// 予定の t は詠唱開始（begincast）の時刻、duration は begincast に入っている詠唱時間。画面の詠唱バーに技名が出る瞬間が
// 詠唱開始なので、これがそのまま同期の基準になる。
// - 同じ名前の見えない補助の敵が、別の技 ID・別の詠唱時間で同時に詠唱する（2026-10-20、ヘビー級1 で確認。
//   本体の「ハードコア」2.7 秒に対し補助 2 体が 4.7 秒）。画面の詠唱バーに出るのは本体なので、sourceInstance の無い
//   （1 体目の）敵だけを使う
// - 詠唱の無い技（begincast の無い cast）は、表示だけの予定（sync: false、duration 0）にする
// - 同じ技を 1 秒以内に重ねて使ったものは 1 つにまとめる

const INSTANT_LOOKBACK_MS = 12000; // cast の前この時間内に同じ敵・同じ技の begincast があれば、詠唱のある技の発動とみなす
const MERGE_MS = 1000;
const AUTO_ATTACK_IDS = new Set([1, 7]);

const round1 = (v) => Math.round(v * 10) / 10;
const usableName = (name) => typeof name === 'string' && name !== '' && !/^unknown_/i.test(name);

/**
 * 敵ごとの詠唱の数（画面で選んでもらうため）。本体（1 体目）の begincast と、詠唱の無い技を数える。
 * @returns {{id:number, name:string, casts:number, instants:number}[]} casts の多い順
 */
export function summarizeEnemies({ actors, abilities, events }) {
    const names = new Map(actors.map((a) => [a.id, a.name]));
    const abilityNames = new Map(abilities.map((a) => [a.gameID, a.name]));
    const counts = new Map();
    for (const item of collectCasts(events, abilityNames)) {
        const c = counts.get(item.sourceID) ?? { id: item.sourceID, name: names.get(item.sourceID) ?? `敵 ${item.sourceID}`, casts: 0, instants: 0 };
        c[item.instant ? 'instants' : 'casts']++;
        counts.set(item.sourceID, c);
    }
    return [...counts.values()].sort((a, b) => b.casts - a.casts || b.instants - a.instants);
}

// 本体（1 体目）の詠唱と、詠唱の無い技を時刻順に並べる
function collectCasts(events, abilityNames) {
    const lastBegin = new Map(); // "敵:体:技" → begincast の時刻
    const out = [];
    for (const e of [...events].sort((a, b) => a.timestamp - b.timestamp)) {
        if (e.type !== 'begincast' && e.type !== 'cast') {
            continue;
        }
        const key = `${e.sourceID}:${e.sourceInstance ?? 0}:${e.abilityGameID}`;
        if (e.type === 'begincast') {
            lastBegin.set(key, e.timestamp);
        }
        const name = abilityNames.get(e.abilityGameID);
        if (e.sourceInstance !== undefined || AUTO_ATTACK_IDS.has(e.abilityGameID) || !usableName(name)) {
            continue;
        }
        if (e.type === 'begincast') {
            out.push({ sourceID: e.sourceID, timestamp: e.timestamp, name, duration: (e.duration ?? 0) / 1000, instant: false });
        } else {
            const begun = lastBegin.get(key);
            if (begun === undefined || e.timestamp - begun > INSTANT_LOOKBACK_MS) {
                out.push({ sourceID: e.sourceID, timestamp: e.timestamp, name, duration: 0, instant: true });
            }
        }
    }
    return out;
}

/**
 * @param {object} p
 * @param {{id:number, startTime:number, endTime:number, kill?:boolean, phaseTransitions?:{id:number,startTime:number}[]|null}} p.fight
 * @param {{id:number, name:string}[]} p.actors masterData.actors（NPC）
 * @param {{gameID:number, name:string}[]} p.abilities masterData.abilities（translate: true で日本語）
 * @param {object[]} p.events Casts の events（hostilityType: Enemies）
 * @param {Set<number>} p.sourceIDs 予定に入れる敵
 * @param {string} p.content コンテンツ名（画面の表記）
 * @param {{id:number, name:string}[]} [p.phaseNames] report.phases のこの戦闘の分
 * @param {boolean} [p.includeInstant] 詠唱の無い技も表示だけの予定として入れるか
 * @param {string} p.title
 * @param {string} p.note
 */
export function buildTimeline({ fight, actors, abilities, events, sourceIDs, content, phaseNames = [], includeInstant = true, title, note }) {
    const abilityNames = new Map(abilities.map((a) => [a.gameID, a.name]));
    const casts = collectCasts(events, abilityNames)
        .filter((c) => sourceIDs.has(c.sourceID) && (includeInstant || !c.instant))
        .filter((c) => c.timestamp >= fight.startTime && c.timestamp <= fight.endTime);
    const merged = [];
    for (const c of casts) {
        if (!merged.some((m) => m.name === c.name && c.timestamp - m.timestamp < MERGE_MS)) {
            merged.push(c);
        }
    }

    // フェーズ: FFLogs の phaseTransitions が 2 つ以上あるときだけ分ける
    const transitions = (fight.phaseTransitions ?? []).length >= 2
        ? [...fight.phaseTransitions].sort((a, b) => a.startTime - b.startTime)
        : [{ id: 1, startTime: fight.startTime }];
    transitions[0] = { ...transitions[0], startTime: fight.startTime };
    const phases = transitions.map((tr, i) => {
        const end = transitions[i + 1]?.startTime ?? Infinity;
        const name = phaseNames.find((p) => p.id === tr.id)?.name;
        return {
            id: `p${i + 1}`,
            ...(name ? { name } : {}),
            start: tr.startTime,
            entries: merged
                .filter((c) => c.timestamp >= tr.startTime && c.timestamp < end)
                .map((c) => ({
                    t: round1((c.timestamp - tr.startTime) / 1000),
                    duration: round1(c.duration),
                    name: c.name,
                    ...(c.instant ? { sync: false } : {}),
                })),
        };
    });
    // 次のフェーズへの移り方: 次のフェーズの最初の詠唱が、いまのフェーズに出てこない技ならその詠唱で移る（HP で早まっても合う）。
    // 出てくる技なら、このログでの経過時間で移る
    phases.forEach((phase, i) => {
        const next = phases[i + 1];
        if (!next) {
            return;
        }
        const first = next.entries.find((e) => e.sync !== false);
        const usedHere = first && phase.entries.some((e) => e.name === first.name);
        phase.next = first && !usedHere
            ? [{ to: next.id, at: first.t, when: { cast: first.name } }]
            : [{ to: next.id, when: { time: round1((next.start - phase.start) / 1000) } }];
    });
    return {
        format: 'castline/1',
        content,
        title,
        note,
        phases: phases.map(({ start, ...p }) => p),
    };
}

/**
 * 予定に入れる敵の既定。戦闘名と同じ名前の敵（ボス本体）。戦闘名が英語のまま等で見つからなければ、
 * 最も詠唱の多い敵と、その 3 割以上詠唱する敵（2 体で戦うボス。ヘビー級2 のレッドホットとディープブルーは 41 件ずつ）
 */
export function defaultEnemyIds(enemies, fightName) {
    const named = enemies.filter((e) => e.name === fightName);
    if (named.length > 0) {
        return new Set(named.map((e) => e.id));
    }
    const most = Math.max(0, ...enemies.map((e) => e.casts));
    return new Set(enemies.filter((e) => most > 0 && e.casts >= most * 0.3).map((e) => e.id));
}

const BRANCH_CASTS = 2; // 各パートの最初の何個の詠唱で、どのパートかを判定するか（1 つ目を読み逃しても 2 つ目で入れる）

/**
 * 前半・後半のように別の戦闘に分かれたコンテンツ（ヘビー級4 など）を 1 つのタイムラインにまとめる。
 * 先頭に予定の無い「開始待ち」フェーズを置き、各パートの最初の詠唱で、そのパートの最初のフェーズへ移る。
 * @param {{label:string, timeline:object}[]} parts
 * @returns {{timeline:object|null, error:string|null}}
 */
export function mergeParts(parts, { content, title, note }) {
    const firsts = parts.map((part) => part.timeline.phases[0].entries.filter((e) => e.sync !== false).slice(0, BRANCH_CASTS));
    const count = new Map();
    for (const name of firsts.flatMap((list) => [...new Set(list.map((e) => e.name))])) {
        count.set(name, (count.get(name) ?? 0) + 1);
    }
    const start = { id: 'start', name: '開始待ち', entries: [], next: [] };
    const phases = [start];
    for (const [i, part] of parts.entries()) {
        const prefix = `${String.fromCharCode(97 + i)}-`; // a-, b-, …
        // ほかのパートの最初にも出てくる技では判定できない
        const rules = firsts[i].filter((e) => count.get(e.name) === 1)
            .map((e) => ({ to: `${prefix}${part.timeline.phases[0].id}`, at: e.t, when: { cast: e.name } }));
        if (rules.length === 0) {
            return { timeline: null, error: `「${part.label}」の最初の詠唱がほかのパートと同じなので、どちらのパートか判定できません` };
        }
        start.next.push(...rules);
        for (const phase of part.timeline.phases) {
            phases.push({
                ...phase,
                id: `${prefix}${phase.id}`,
                name: phase.name ? `${part.label} ${phase.name}` : part.label,
                ...(phase.next ? { next: phase.next.map((r) => ({ ...r, to: `${prefix}${r.to}` })) } : {}),
            });
        }
    }
    return { timeline: { format: 'castline/1', content, title, note, phases }, error: null };
}
