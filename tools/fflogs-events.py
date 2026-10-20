#!/usr/bin/env python3
"""FFLogs の 1 戦闘から、敵の技の時刻と名前だけを抜き出す（hojoring-overlay.py の照合用）。運営者が手元で使う。

補助の敵（見えない分身）の技も含める。Hojoring は補助の敵の技でも合わせているため。
出力にレポートの番号は書かない（2026-10-20 の方針）。

    # FFLogs から取る（キーは環境変数 FFLOGS_CLIENT_ID / FFLOGS_CLIENT_SECRET。画面にもファイルにも出さない）
    python3 tools/fflogs-events.py 'https://ja.fflogs.com/reports/XXXX?fight=2' tools/skeletons/heavy1.events.json
    # 取得済みの JSON（fight・master・events）から作る
    python3 tools/fflogs-events.py --from-json dump.json tools/skeletons/heavy1.events.json

出力: {"fight": 戦闘名, "kill": 討伐か, "length": 秒, "events": [[秒, "b"|"c", 技名], ...]}
（b は詠唱開始、c は技の発動。秒は戦闘開始から）
"""
import argparse
import base64
import json
import os
import re
import sys
import urllib.parse
import urllib.request

API = 'https://ja.fflogs.com/api/v2/client'
TOKEN = 'https://ja.fflogs.com/oauth/token'
SKIP_ABILITIES = {1, 7}  # 通常攻撃


def fetch(url):
    cid, secret = os.environ.get('FFLOGS_CLIENT_ID'), os.environ.get('FFLOGS_CLIENT_SECRET')
    if not cid or not secret:
        sys.exit('環境変数 FFLOGS_CLIENT_ID と FFLOGS_CLIENT_SECRET を設定してください')
    m = re.search(r'reports/([A-Za-z0-9]+)', url)
    fight_id = int((urllib.parse.parse_qs(urllib.parse.urlparse(url).query).get('fight') or ['0'])[0])
    if not m or not fight_id:
        sys.exit('レポートの URL（?fight= つき）を指定してください')
    code = m.group(1)
    req = urllib.request.Request(TOKEN, data=b'grant_type=client_credentials', headers={
        'Authorization': 'Basic ' + base64.b64encode(f'{cid}:{secret}'.encode()).decode(),
        'Content-Type': 'application/x-www-form-urlencoded'})
    token = json.load(urllib.request.urlopen(req))['access_token']

    def gql(query, variables):
        r = urllib.request.Request(API, data=json.dumps({'query': query, 'variables': variables}).encode(),
                                   headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        out = json.load(urllib.request.urlopen(r))
        if 'errors' in out:
            sys.exit(f'FFLogs のエラー: {out["errors"]}')
        return out['data']['reportData']['report']

    rep = gql('''query($c:String!,$f:[Int]){reportData{report(code:$c){
      fights(fightIDs:$f){id name kill startTime endTime}
      masterData(translate:true){abilities{gameID name}}}}}''', {'c': code, 'f': [fight_id]})
    fight = rep['fights'][0]
    events, start = [], fight['startTime']
    for _ in range(30):
        page = gql('''query($c:String!,$f:[Int],$s:Float,$e:Float){reportData{report(code:$c){
          events(fightIDs:$f,startTime:$s,endTime:$e,dataType:Casts,hostilityType:Enemies,translate:true){data nextPageTimestamp}}}}''',
                   {'c': code, 'f': [fight_id], 's': start, 'e': fight['endTime']})['events']
        events += page['data']
        start = page['nextPageTimestamp']
        if start is None:
            break
    return {'fight': fight, 'master': rep['masterData'], 'events': events}


def extract(dump):
    fight = dump['fight']
    names = {a['gameID']: a['name'] for a in dump['master']['abilities']}
    seen, out = set(), []
    for e in dump['events']:
        if e.get('type') not in ('begincast', 'cast') or e.get('abilityGameID') in SKIP_ABILITIES:
            continue
        name = names.get(e.get('abilityGameID'), '')
        if not name or name.lower().startswith('unknown'):
            continue
        row = (round((e['timestamp'] - fight['startTime']) / 1000, 1), 'b' if e['type'] == 'begincast' else 'c', name)
        if row not in seen:  # 分身が同時に使う同じ技は 1 つにまとめる
            seen.add(row)
            out.append(list(row))
    out.sort(key=lambda r: r[0])
    return {'fight': fight['name'], 'kill': bool(fight.get('kill')),
            'length': round((fight['endTime'] - fight['startTime']) / 1000, 1), 'events': out}


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('source', nargs='?', help='レポートの URL（?fight= つき）')
    ap.add_argument('out')
    ap.add_argument('--from-json', metavar='PATH')
    args = ap.parse_args()
    if args.from_json:
        with open(args.from_json, encoding='utf-8') as f:
            dump = json.load(f)
    elif args.source:
        dump = fetch(args.source)
    else:
        ap.error('URL か --from-json を指定してください')
    data = extract(dump)
    with open(args.out, 'w', encoding='utf-8') as f:
        f.write('{\n  "fight": ' + json.dumps(data['fight'], ensure_ascii=False)
                + f',\n  "kill": {json.dumps(data["kill"])},\n  "length": {data["length"]},\n  "events": [\n'
                + ',\n'.join('    ' + json.dumps(r, ensure_ascii=False) for r in data['events']) + '\n  ]\n}\n')
    print(f'{args.out}: {data["fight"]}（{"討伐" if data["kill"] else "ワイプ"} {data["length"]} 秒）技 {len(data["events"])} 件')


if __name__ == '__main__':
    main()
