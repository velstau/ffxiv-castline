#!/usr/bin/env python3
"""配信のタイムライン（public/timelines/*.xml）の予定に、表示の文のキーワードからギミックのアイコン（gimmick_icon）を付ける。

予定の表示の文（text）を下の RULES の上から順に見て、最初に当たった規則のアイコンを付ける
（1 つの予定にアイコンは 1 つ。「全体ノックバック」はノックバック、「タンク頭割り」は頭割りより先にタンク頭割り）。
アイコンの意味は public/icons/gimmick/README.md。text の無い詠唱のある予定（表示はゲームの技名）は、名前で仕組みが決まる語だけを見る（CAST_RULES）。
詠唱の無い表示だけの予定は、castname に Hojoring の文言が入っているので RULES を当てる。
text でも技名にも出る語（「鎖」「フレア」など）は規則にしない（「魔鎖乱流」「ギガフレア」は鎖・フレアの処理ではない）。
すでに gimmick_icon がある予定は変えない（--replace で付け直す）。

配信の XML は変換の道具（build-timelines.sh・convert-hojoring-pc.sh）で作り直すとアイコンが消えるので、どちらも最後にこれを実行する。

    python3 tools/apply-gimmick-icons.py            # 付ける
    python3 tools/apply-gimmick-icons.py --dry-run  # 書き込まずに、アイコンごとに当たった表示の一覧を出す
"""
import argparse
import collections
import html
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parent.parent

# (アイコンの id, 表示に当てる正規表現)。上から順に見て最初に当たったもの
RULES = [
    ('tank-share', r'タンク頭割り|タンクシェア|T頭割り'),
    ('tankbuster', r'タンク強|T強攻撃|タンクバスター|単体強攻撃|タンク連続攻撃|前方強攻撃'),
    ('knockback', r'ノックバック|吹き飛ばし'),
    ('raidwide', r'全体'),
    ('tankbuster', r'^強攻撃$|^強攻撃[（(]'),
    ('stack', r'頭割り|シェア'),
    ('pair-spread', r'2[:：]2[:：]2[:：]2'),
    ('spread', r'散開'),
    ('tower', r'塔'),
    ('gaze-away', r'視線|背を向け'),
    ('proximity', r'距離減衰'),
    ('dynamo', r'ドーナツ|ダイナモ'),
    ('chariot', r'チャリオット|ボス中心'),
    ('exaflare', r'エクサフレア'),
    ('line', r'直線'),
    ('cone', r'扇'),
    ('half-room', r'半面'),
    ('meteor', r'隕石|メテオ(着弾|設置|処理)'),  # 「コスモメテオ」「ヴォイド・メテオ」など技名のメテオは隕石の処理とは限らない
    ('tether-take', r'線取り|線を取'),
    ('tether-stretch', r'線伸ばし|線を伸ば|線切り|線を切'),
    ('acceleration-bomb', r'加速度'),
    ('forced-march', r'移動命令|強制移動'),
    ('magnet', r'磁石|磁力'),
    ('bind', r'足止め|バインド'),
    ('divebomb', r'ダイブボム'),
    ('rotation', r'^回転|回転(AoE|開始|方向)'),  # 「回転鎖刃」は技名
    ('dice', r'サイコロ'),
]
# text の無い詠唱のある予定（表示はゲームの技名）に当てる規則。技名は「コスモメテオ」（全体攻撃）・「魔鎖乱流」のように語と仕組みが合わないことが多いので、
# 名前で仕組みが決まるものだけ
CAST_RULES = [
    ('dynamo', r'ダイナモ'),
    ('chariot', r'チャリオット'),
    ('exaflare', r'エクサフレア'),
]
COMPILED = [(icon, re.compile(pattern)) for icon, pattern in RULES]
CAST_COMPILED = [(icon, re.compile(pattern)) for icon, pattern in CAST_RULES]
ENTRY = re.compile(r'<entry\b[^>]*/>')


def attr(entry, name):
    m = re.search(rf'\s{name}="([^"]*)"', entry)
    return html.unescape(m.group(1)) if m else None


def icon_for(text, castname, cast):
    """表示の文（text）があれば RULES。無ければ、詠唱のある予定（cast。castname はゲームの技名）は CAST_RULES、
    詠唱の無い表示だけの予定（castname に Hojoring の文言「ノックバック」「塔踏み1回目」などが入る）は RULES"""
    rules = CAST_COMPILED if cast and not text else COMPILED
    for icon, pattern in rules:
        if pattern.search(text or castname):
            return icon
    return None


def with_icon(entry, icon):
    """属性の順（t・text・castname・duration・sync・tts・window・gimmick_icon・skills_icon。timeline-xml.js の toTimelineXml）を守って入れる。
    値は「tower.png」の形（2026-10-21 のユーザーの指定。gimmick-icons.js は拡張子を見ない）"""
    entry = re.sub(r'\sgimmick_icon="[^"]*"', '', entry)
    if ' skills_icon="' in entry:
        return entry.replace(' skills_icon="', f' gimmick_icon="{icon}.png" skills_icon="', 1)
    return entry[:-2] + f' gimmick_icon="{icon}.png"/>'


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--replace', action='store_true', help='すでにある gimmick_icon も付け直す')
    args = ap.parse_args()
    hits = collections.defaultdict(collections.Counter)
    changed_files = 0
    total = 0
    for path in sorted((ROOT / 'public/timelines').glob('*.xml')):
        if path.name == 'index.xml':
            continue
        text = path.read_text(encoding='utf-8')

        def replace(m):
            nonlocal total
            entry = m.group(0)
            if attr(entry, 'gimmick_icon') and not args.replace:
                return entry
            text, castname = attr(entry, 'text'), attr(entry, 'castname') or ''
            cast = float(attr(entry, 'duration') or 0) > 0
            icon = icon_for(text, castname, cast)
            if not icon:
                return entry
            hits[icon][text or (f'〔技名〕{castname}' if cast else castname)] += 1
            total += 1
            return with_icon(entry, icon)

        new = ENTRY.sub(replace, text)
        if new != text:
            changed_files += 1
            if not args.dry_run:
                path.write_text(new, encoding='utf-8')
    if args.dry_run:
        for icon, _ in RULES + CAST_RULES:
            if icon in hits:
                labels = hits.pop(icon)
                print(f'{icon}（{sum(labels.values())}）: ' + '・'.join(f'{k}×{n}' if n > 1 else k for k, n in labels.most_common()))
    print(f'{"付ける" if args.dry_run else "付けた"}予定 {total}・ファイル {changed_files}')


if __name__ == '__main__':
    main()
