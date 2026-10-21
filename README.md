# Castline

名前は「詠唱（cast）で同期して進む時間軸（line）」から（2026-10-20 に ocr-timeline から改名）。

FF14 のゲーム画面に表示された文字（コンテンツ名・カウントダウン・ボスの HP と詠唱）を読み取り、
ボスのタイムラインを流す Web ツール。ゲームのクライアント・メモリ・通信には触れず、
ブラウザの画面共有（`getDisplayMedia`）で取り込んだ画面だけを使う。

- サーバー処理なしの静的なアプリ。取り込み・文字認識・再生はすべてブラウザ内で行い、画像はどこにも送らない
- 配信: `https://vel.works/ff14tools/castline/`（nginx は `vel.works/_nginx/vel.works.locations.conf`）
- 開発: `https://192.168.11.100:8011/ff14tools/castline/`
- **画面の取り込みと最前面の小窓（Document Picture-in-Picture）は https か localhost でしか動かない。**
  http の :8010 では画像ファイルを読むところまでしか使えないので、開発中は https の :8011 で開く
  （PC 側の準備は `dev-server-php8/README.md` のポート表の 8011）

## 現状

| ページ | 内容 |
|---|---|
| `setup.html` | 初期設定。読む範囲を、手順に沿ってゲーム画面から自動で見つけて保存する（下の「読む範囲」） |
| `player.html` | 再生画面。ゲーム画面を読み取り、タイムラインを流して読み上げる（下の「再生画面」） |
| `generator.html` | FFLogs の公開レポートからタイムラインの XML を作る（下の「FFLogs からの生成」） |
| `lab.html` | OCR 試験ページ。画像（または取り込んだ画面）の上で読む範囲を選び、読み取りと解釈の結果を表に出す |

## セットアップ

```bash
tools/fetch-models.sh   # 文字認識・検出のモデル（合わせて 21MB）と辞書を public/models/ に取ってくる（リポジトリには含めない）
```

## 構成

| ファイル | 役割 |
|---|---|
| `public/js/ocr.js` | 文字認識（`TextRecognizer`）と文字検出（`TextDetector`）。認識は PP-OCRv5 mobile の rec で 1 行を読み、候補文字列ごとの確からしさ（CTC の対数尤度）も出す。検出は det で範囲の中の文字の行を探す |
| `public/js/readers.js` | 読んだ文字の解釈。コンテンツ名・技名の決定（`pickCandidate`）、カウントダウン（`readCountdown`）、HP%。再生画面と試験ページで共用する |
| `public/js/capture.js` | 画面の取り込み（`FrameSource`）。MediaStreamTrackProcessor で届いたフレームの最新 1 枚を持ち、届いた時刻と一緒に渡す。**ゲームを前面にするとページは非表示とみなされ、タイマーは 1 秒 1 回に間引かれ、`<video>` 要素の映像は遅れる**（実測で 16 秒のカウントダウンが 9 秒に縮んで記録された）ため、タイマーも `<video>` も使わずフレームの到着で処理を進める |
| `public/js/lab.js` | 試験ページの画面。連続読み取り（0.5 秒ごとに読み、変化だけを時刻付きで記録してコピーできる）もここ |
| `public/data/contents.json` | コンテンツ名の候補（`territory` は場所の番号で、FFLogs の gameZone.id から名前を引くのに使う。`en` は英語の正式名、`file` はタイムラインのファイル名）。`tools/build-contents.py` が XIVAPI v2 の ContentFinderCondition（日本語名）から、討伐・討滅戦／レイド／絶／滅アライアンスだけを抜いて作る（手で書き換えない。パッチで増えたら実行し直す） |

## 文字認識の選定（2026-10-20）

配信録画の静止画 3 枚（2560x1080）で比べた。数字は正解との編集距離（文字数）。

| 項目 | Tesseract.js 7（全設定から最良） | PP-OCRv5 mobile（設定固定） |
|---|---|---|
| コンテンツ名 | 4〜6 | 1〜3 |
| カウントダウン | 1〜2 | 0〜2 |
| HP% | 0〜1 | 0〜1 |

- Tesseract.js は「零式」を誤読し、通常版と区別できなかったので不採用
- PP-OCRv5 は server 版（84MB）より mobile 版（16MB）のほうが良かった
- **コンテンツ名は、読んだ文字列を照合せず、候補ごとの確からしさを比べて決める**（`pickContent`）。
  1 位と 2 位の差が 5 未満、または読んだ文字列と 1 位が大きく違うときは決めず、利用者に選んでもらう。
  ブラウザでの実測では 3 枚とも零式に決まり、差は 5.4〜7.7（1 枚目は基準ぎりぎり）。**通常版の画像での誤判定は未確認**
- 実画面（劣化なし、煉獄編4 零式）ではコンテンツ名の差は 12.0、HP は正解
- **技名は部分一致で照合する**（`ctc.js` の `spottingPenalty`、`readers.js` の `pickCast`）。詠唱バーの範囲には
  ボス名やバーの模様も入り、「ーーラムラ創世の真炎」のように前に余計な文字が付くため、全体の一致（コンテンツ名の方式）では
  決まらなかった。読んだ文字のどこか一部分に候補を当て、当てた時刻だけを「その時刻に最も確からしい文字」と比べて減点する
  （0 = そのまま含まれている）。減点 6 以内を当てはまるとし、複数当てはまれば長い候補を優先、同じ長さで差 3 未満なら決めない。
  候補は再生画面ではタイムラインファイルの技名（その時点の前後の技に絞る）
- **技名は文字検出で行を分けてから 1 行ずつ照合する**（`readCast`）。詠唱バーの範囲にボス名の行が入ると、2 行が混ざって
  「ア人A熾炎创火」のように崩れたため。技名は詠唱バーのほかに**敵対リスト**（敵の名前の横）にも出るので、両方から読む。
  詠唱バーはカメラの角度でボスの頭上の表示（名前・技名・CAST）と重なるが、敵対リストは位置が固定で重なりにくい。
  **敵対リストは長い技名を「テトラフレア・コ…」と途中で切って出す**ので、頭の部分（4 文字以上、減点 3 以内）でも照合する。
  頭が同じ候補が複数あれば決めない。実画面（2026-10-20）では詠唱バーで 3 技とも決まり、取り違えはなかった
- 敵対リストは戦闘の後に 0.5 秒ほど出たり消えたりすることがあるので、1 秒以上続けて出たときだけ「出た」とみなす（開始時刻は出始めにさかのぼる）
- 連続読み取りの実測（2026-10-20、ページは非表示のまま）: カウントダウン 16・10・5 秒の 3 回とも開始予想 19:08:26.1〜26.2、
  実際の戦闘開始の検出 19:08:26.2
- **カウントダウンは文字検出（det）で行を探してから読む**（`readCountdown`）。吹き出しは「（名前）」の行が付くと
  2 行になって縦の位置が変わり、文言で幅も倍ほど変わるため、範囲は広めに取ってもらう。明るさの投影で行を分ける方式は、
  背景のエフェクトやキャラクター名を行と取り違えて失敗した。det は拡大なし・BGR・後処理は DB 公式（0.3 / 0.6 / unclip 1.5、
  軸に沿った箱）で、録画 3 枚とも正しく読めた（「！」は落ちることがあるので判定は「(数字)秒」で行う）。det 1 回は wasm で約 15ms
- チャット欄にも「戦闘開始まで16秒！」などが残る（途中の秒数も出る）。カウントダウンの予備の読み取り元にする（未実装）
- モデルは Apache-2.0 の変換版（huggingface `ilaylow/PP_OCRv5_mobile_onnx`）と PaddleOCR 公式の辞書。
  onnxruntime-web 1.30.0 は jsDelivr から読む（自前配信は今後）

## タイムラインファイル（XML、形式 `castline/1`）

XML 1 つが 1 コンテンツ。読み込みは `public/js/timeline-xml.js`（`parseTimelineXml` が下の形をエンジンの形に直し、誤りを日本語で返す）、
進め方は `public/js/timeline-engine.js`。テストは `tests/*.test.mjs` をファイルごとに
`docker run --rm -u 1000:1000 -v "$PWD":/w -w /w node:24-alpine node --test tests/timeline-engine.test.mjs`
（`tests/readers.test.mjs` も同様。ディレクトリを渡すと失敗する）。XML の読み込みはブラウザの DOMParser を使うので node のテストは無く、
再生画面の確認（取り込みを模したブラウザ試験）で見ている。

```xml
<?xml version="1.0" encoding="utf-8"?>
<timeline>
  <!-- 先頭の情報は 1 行ずつの子要素。content は画面の表記どおり（contents.json の名前） -->
  <format>castline/1</format>
  <content>万魔殿パンデモニウム零式：煉獄編4</content>
  <title>表示名</title>
  <author>作者</author>  <!-- タイムラインの作者。省略可。再生画面に出す -->
  <license>CC BY-SA</license>  <!-- タイムラインのライセンス。省略可。再生画面に出す -->
  <sync-window>10 10</sync-window>  <!-- 既定の同期の窓（予定の何秒前 何秒後）。省略可 -->
  <note>出典など</note>
  <phase id="p1" name="前半">
    <!-- t は「詠唱が始まる」秒（フェーズ開始から）。画面の詠唱バーに技名が出る瞬間＝同期の基準。
         発動（ダメージ）は t + duration。詠唱の無い技は duration 0（省略可） -->
    <!-- entry の属性は t・text・castname・duration・sync・tts・window・gimmick_icon・skills_icon の順に書く。t と duration は必ず小数点以下 1 桁（6.0・5.0）（生成画面と道具はこの形で出す） -->
    <entry t="6.0" text="全体攻撃" castname="創世の真炎" duration="5.0"/>
    <!-- sync="false" で同期に使わない。window で窓を個別に指定。text は表示だけの文言。tts で読み上げる文を指定（読み上げるのは tts に文がある予定だけ。tts が無い・tts="" は読まない） -->
    <entry t="30.0" castname="詠唱の無い技" sync="false" tts="散開"/>
    <!-- gimmick_icon はギミックのアイコン 1 つ、skills_icon はスキルのアイコン（カンマ区切り）。書き方は下の「表示とアイコン」 -->
    <entry t="36.0" text="タンク強" castname="ハードコア" duration="2.7" gimmick_icon="tankbuster.png" skills_icon="rampart.png,rampart2.png"/>
    <!-- 毎回どれかが出る技は castname を「|」で区切る（どれが読めても同期する。表示は「／」区切り） -->
    <entry t="40.0" text="頭割りorロール" castname="アグリゲートソニック|スプレッドソニック" duration="4.0"/>
    <!-- 上から順に見て、最初に満たしたものに移る。at は移った瞬間の、移り先での秒（既定 0） -->
    <next to="p2" cast="移行技"/>
    <next to="p2" hp="50"/>        <!-- HP が 50% 以下 -->
    <next to="p2" time="180"/>     <!-- フェーズ内 180 秒（時間切れ） -->
    <next to="p2" hp-lost="3"/>    <!-- HP が 3 秒以上読めない（ボスが消えた。このフェーズに入ってから数える） -->
  </phase>
  <phase id="p2" name="後半">…</phase>
</timeline>
```

### 表示とアイコン

- 予定の表示は、text があれば text だけ、無ければ castname
- 同じ表示・同じアイコンの予定が続き、発動の間が 10 秒以内なら 1 行にまとめて「x4」のように出す（public/js/timeline-view.js の GROUP_GAP_S）。読み上げは今までどおり 1 つずつ
- アイコンは再生画面と小窓の時刻の左に出す。ギミック 1 つ（gimmick_icon）→ スキル（skills_icon。カンマ区切り）の順
- 書いた名前（フォルダなし）が下の一覧の id か名前なら、用意したアイコンを使う。拡張子は見ない（「tower.png」「tower」「塔踏み」「チャリオット」は同じ）。
  それ以外は画像のファイル。用意したアイコンと同じ名前の自分の画像を使うときは「./tower.png」と書く
- ギミックのアイコンは Castline の独自の図案（public/icons/gimmick/。ゲームの画像は使っていない）。各アイコンの意味・図案・色の決まりは [public/icons/gimmick/README.md](public/icons/gimmick/README.md)
- スキルのアイコンは同梱しない。各自が用意した画像のファイルを書く。
  配信のタイムラインではファイルは XML の場所からの相対パス、手元の XML では URL（http・https・data）だけ使える
- 見つからないアイコンは表示を飛ばし、タイムラインを読み込んだときに記録に出す
- 配信の XML は変換の道具（build-timelines.sh・convert-hojoring-pc.sh）で作り直すので、gimmick_icon・skills_icon を手で書き足しても作り直すと消える

| アイコン | id | 名前 |
|---|---|---|
| <img src="public/icons/gimmick/raidwide.svg" width="24" alt=""> | `raidwide` | 全体攻撃 |
| <img src="public/icons/gimmick/tankbuster.svg" width="24" alt=""> | `tankbuster` | タンク強攻撃 |
| <img src="public/icons/gimmick/tank-share.svg" width="24" alt=""> | `tank-share` | タンク頭割り |
| <img src="public/icons/gimmick/stack.svg" width="24" alt=""> | `stack` | 頭割り |
| <img src="public/icons/gimmick/spread.svg" width="24" alt=""> | `spread` | 散開 |
| <img src="public/icons/gimmick/tower.svg" width="24" alt=""> | `tower` | 塔踏み |
| <img src="public/icons/gimmick/dice.svg" width="24" alt=""> | `dice` | サイコロ |
| <img src="public/icons/gimmick/half-room.svg" width="24" alt=""> | `half-room` | 半面攻撃 |
| <img src="public/icons/gimmick/target-marker.svg" width="24" alt=""> | `target-marker` | 単体マーカー |
| <img src="public/icons/gimmick/aoe-marker.svg" width="24" alt=""> | `aoe-marker` | AoEマーカー |
| <img src="public/icons/gimmick/gaze-look.svg" width="24" alt=""> | `gaze-look` | 視線見る |
| <img src="public/icons/gimmick/gaze-away.svg" width="24" alt=""> | `gaze-away` | 視線見ない |
| <img src="public/icons/gimmick/proximity.svg" width="24" alt=""> | `proximity` | 距離減衰 |
| <img src="public/icons/gimmick/knockback.svg" width="24" alt=""> | `knockback` | ノックバック |
| <img src="public/icons/gimmick/tether-stretch.svg" width="24" alt=""> | `tether-stretch` | 線伸ばす |
| <img src="public/icons/gimmick/tether-take.svg" width="24" alt=""> | `tether-take` | 線取る |
| <img src="public/icons/gimmick/chain.svg" width="24" alt=""> | `chain` | 鎖 |
| <img src="public/icons/gimmick/divebomb.svg" width="24" alt=""> | `divebomb` | ダイブボム |
| <img src="public/icons/gimmick/range-near.svg" width="24" alt=""> | `range-near` | 距離調整ニア |
| <img src="public/icons/gimmick/range-middle.svg" width="24" alt=""> | `range-middle` | 距離調整ミドル |
| <img src="public/icons/gimmick/range-far.svg" width="24" alt=""> | `range-far` | 距離調整ファー |
| <img src="public/icons/gimmick/bind.svg" width="24" alt=""> | `bind` | 足止め |
| <img src="public/icons/gimmick/chariot.svg" width="24" alt=""> | `chariot` | ボス中心円形範囲（チャリオット） |
| <img src="public/icons/gimmick/dynamo.svg" width="24" alt=""> | `dynamo` | ボス中心ドーナツ型範囲（ダイナモ） |
| <img src="public/icons/gimmick/line.svg" width="24" alt=""> | `line` | 直線範囲 |
| <img src="public/icons/gimmick/cone.svg" width="24" alt=""> | `cone` | 扇範囲 |
| <img src="public/icons/gimmick/aoe.svg" width="24" alt=""> | `aoe` | AoE範囲 |
| <img src="public/icons/gimmick/meteor.svg" width="24" alt=""> | `meteor` | メテオ |
| <img src="public/icons/gimmick/flare.svg" width="24" alt=""> | `flare` | フレア |
| <img src="public/icons/gimmick/exaflare.svg" width="24" alt=""> | `exaflare` | エクサフレア |
| <img src="public/icons/gimmick/magnet.svg" width="24" alt=""> | `magnet` | 磁石 |
| <img src="public/icons/gimmick/acceleration-bomb.svg" width="24" alt=""> | `acceleration-bomb` | 加速度爆弾 |
| <img src="public/icons/gimmick/rotation.svg" width="24" alt=""> | `rotation` | 回転 |
| <img src="public/icons/gimmick/forced-march.svg" width="24" alt=""> | `forced-march` | 移動命令 |


- 詠唱バーで照合する候補は、全技ではなく「同期の窓に入っている予定」と「移り方の技名」だけに絞る（`castCandidates`）
- 同じ予定では 1 度しか同期しない（詠唱バーが出ている間、何度読めても合わせ直さない）
- 開始: カウントダウンの各秒数を最初に見た時刻から開始を予想し（ほかの予想と 1.5 秒以内で合う予想のうち最も早いもの。
  合う予想が無ければ秒数のいちばん大きいもの。「10」を「1」と読むような桁落ちで早まらないように）、
  「戦闘開始！」で確定（「まで」「秒」のある行は、数字が読めなくても戦闘開始とみなさない）。読み逃しても予想時刻で開始。敵対リストを読む場合は、1 秒以上続けて出たときだけ「出た」とみなし、
  予想より 1 秒以上早く出たら早い開始、予想の 5 秒後までに出なければ取り消し。カウントダウンなしで敵対リストが出たら、その時刻で開始
- 終了（2026-10-21 に変更）: 全滅すると画面が暗転し HUD も消える（「全滅」の表示は出ない。ユーザーの確認）ので、
  **画面全体の暗転が 2 秒続いたら全滅**（`blackout.js`。縮小した画面の 99.5% 以上が真っ黒。暗い戦場でも HUD は明るいので区別できる）。
  フェーズの移り変わりで敵対リスト・HP・詠唱バーが消えるコンテンツ（絶もうひとつの未来）があるので、**敵が消えただけでは終わらない**。
  討伐は、最後のフェーズ（移り方の無いフェーズ）で HP 3% 以下を読んだ後に敵対リストが 3 秒消えたとき。敵対リストが 90 秒消えたままでも終了。
  戦闘中でも、敵対リストが消えている間にカウントダウンが出たら、次の戦闘として数え直す（暗転を読み逃したとき）。
  「タイムラインを止める」で手で止めることもできる（止めた後は、次のカウントダウンか、敵対リストが一度消えてから出たときに始まる）
- 制約: HP は 1 体分しか読まない（複数の敵がいるときは、読んでいる範囲の敵の HP）
- **時刻の基準**: 同期は「技名が読めた時刻」を予定の t に合わせる。読めるのは詠唱バーが出てから 0.3〜0.7 秒ほど後なので、
  ログの begincast など本当の詠唱開始で t を作ると、表示がその分遅れる（読み取りの遅れを引く処理は未着手）。
  `timelines/abyssos-the-eighth-circle-savage.xml`（煉獄編4 零式のテスト用）は読めた時刻で作ってあるので、この遅れは打ち消し合う

### 配信と手元のファイル

- 配信: `public/timelines/` の `index.xml` に一覧を書き、同じフォルダに XML を置く。
- **ファイル名は英語の正式名＋難易度**（`contents.json` の `file`。例: `aac-heavyweight-m1-savage.xml`・`futures-rewritten-ultimate.xml`・`worqor-lar-dor-extreme.xml`）。
  英語名の難易度の括弧を外して小文字・ハイフンにし、難易度を後ろに付ける。難易度は normal / savage / ultimate / extreme / chaotic（英語名どおり hard・unreal もある）。
  極の一部は英語名が「The Minstrel's Ballad: 名前」なので extreme とする。8.0 の新しい難易度（中間層）は英語名が分かったら同じ規則で付く（2026-10-20 のユーザーの指定）。
  生成画面の保存名も同じ
  再生画面は GitHub（`velstau/ffxiv-castline` の main）の raw から読むので、タイムラインの更新は push だけで届く（サイトの反映は要らない。raw は最大 5 分キャッシュされる）。
  GitHub を読めないときはサイトに同梱した写しを使う。`player.html?timelines=site` でサイトの写しだけを読む（push 前の確認用）
- 手元のファイル: 再生画面で XML を読み込むと、このブラウザに保存する（`castline.player.local-timelines`）。
  同じコンテンツなら手元のファイルを配信より優先する
- タイムラインの作り方（cactbot・Hojoring の変換）は運営者が手元で使う道具とし、サイトの機能にはしない（2026-10-20 の方針）

一覧の各タイムラインも、タイムラインの先頭の情報と同じく 1 行ずつの子要素で書く（2026-10-21 のユーザーの指定。以前の属性の形も読める）:

```xml
<timelines>
  <format>castline-index/1</format>
  <timeline>
    <file>abyssos-the-eighth-circle-savage.xml</file>
    <content>万魔殿パンデモニウム零式：煉獄編4</content>
    <title>煉獄編4 零式（テスト用・冒頭のみ）</title>
  </timeline>
</timelines>
```

## 再生画面（`player.html`）

取り込み → コンテンツ名を戦闘外だけ 5 秒ごとに読み、タイムラインを自動で選ぶ（一覧から手で選ぶこともできる）→
カウントダウン・敵対リストで開始 → 戦闘中は詠唱バーと敵対リストの技名で同期 → これから来る技と発動までの秒を表示し、
発動の N 秒前（既定 5）に読み上げる。表示はページと小窓（Document Picture-in-Picture）の両方に出す。

画面の左は「次にすること」（2026-10-21 のユーザーの指定で、次に何をするかを順番に案内する形にした）。初期設定の手順と同じ `.steps` の形で、
範囲を決める → タイムラインを選ぶ → 読み上げを試す（任意）→ 取り込みを始める → 小窓で開く（任意）→ ゲームに戻って戦闘を始める、の 6 つ。
「いまの手順」は飛ばせない手順のうち最初の済んでいないもので、説明はその手順にだけ出す。取り込み・小窓・タイムラインを止めるのボタンは手順の中にある。
状態の判定は `public/js/player-guide.js`（DOM を触らない。テストは `tests/player-guide.test.mjs`）、描画は player.js の `renderGuide`（変わったときだけ書き換える）。
右の列は、流れているタイムライン・使うタイムライン・読み上げ・記録。

### 読む範囲

初期設定の画面（`setup.html`・`setup.js`）で指定する（試験ページと共通。`castline.regions` に取り込んだ画面の大きさ "幅x高さ" ごとに保存）。
見つけた範囲は「見つけた範囲」の欄に、**見つけた瞬間の画面**の切り抜きと枠で出す（カウントダウン・詠唱バーはすぐ消えるため。画面はページを開いている間だけメモリに持ち、保存しない）。
そこから拡大図（`region-editor.js`）をその画面のまま開いて直せる。
再生画面には指定の状態を 1 行出すだけ（2026-10-21、再生画面に設定を並べると分かりにくいという指摘で分けた）。

- 初期設定は手順を上から順に出す: 1 取り込み → 2 コンテンツに入る → 3 カウントダウン → 4 ボスを殴る（フォーカスターゲットは味方でもよい） → 5 完了。
  各手順は、その範囲が保存されたら済みになる（順不同で済んでもよい）。詠唱バーは、コンテンツのタイムラインがあるときだけ探す
  （技名で見つけるため。初期設定の画面も読み取ったコンテンツ名からタイムラインを読む。`timeline-source.js`）
- 手で直す（拡大図）・全部消してやり直す・ファイルの書き出しと読み込みは、初期設定の画面の「うまくいかないとき」に畳んである。
  拡大図に使う画面は「いまのゲーム画面を使う」（取り込み中のフレーム）か、スクリーンショット。取り込みのフレームと
  スクリーンショットは大きさが違うことがあり、範囲は大きさごとに持つので、取り込み中の画面で指定するのが確実
- 再生画面も、取り込み中に足りない範囲があれば同じ方法で探す（初期設定の画面のチェックで切れる）
- **足りない範囲は、取り込み中に画面に出たときに自動で探して保存する**（`region-auto.js` の `RegionAutoFinder`。
  初期設定の画面と再生画面で共用）。読み取りとは別のフレームを 1 秒ごとに取り、文字認識は区画ごとに順番待ちする。
  判定は `region-finder.js`（DOM を使わない。`tests/region-finder.test.mjs` は実際の画面を読んだ行で確かめる）
  - コンテンツ名（`findContent`）: 5 秒ごと。画面を 960px の区画に分け、右上から順に行を検出して `contents.json` の名前と照合し、
    決まった区画で止める。見つけた行を最も長い名前（21 文字）が入る幅まで左に広げ、右に 1 文字・上下に 1 割の余裕を足す
  - カウントダウン: 最優先で、画面中央の区画で（戦闘中と判定していても 3 秒ごとに探す。ずれた範囲で誤って戦闘中になっていることがある。
    見つけた回とカウントダウン中は、ほかを探さず読み取りに空ける）「開始」か「まで」を含む告知の行（「戦闘開始まで16秒！」）を探す。
    告知は画面中央に中央揃えで出るので、中心のまま 11 文字分に広げ、2 行の告知（下に名前）でも入るよう上下に余裕を取る。
    上は控えめ（残り 5 秒からは大きな数字がすぐ上に出て、入ると告知の行とつながって読み違える）
  - HP・敵対リスト・詠唱バーは**戦闘中だけ**探す（戦闘開始と判定している、または HP が 100% 未満の行が見えてから 30 秒）。
    戦闘外に読んだ画面は「戦闘前から文字がある場所」として覚え、そこに重なる行は敵対リストの候補から外す（詠唱バーは外さない。ターゲットの名前・HP の行のすぐ近くに出て、戦闘前にボスを選んでいると重なるため。代わりに保存済みの敵対リストの範囲を外す）。
    敵対リストはかぎ括弧・句読点のある行（チャットの「〜は「技」の構え。」）も外す。HP は 2 回続けて同じ場所に見えたときだけ保存する
    （2026-10-21: 戦闘前から出ている文字を敵対リストとして見つけ、取り込みの直後に戦闘開始になって小窓が動き出した）
  - HP・敵対リスト・詠唱バー: 画面全体を読み（1 回 5〜6 秒。戦闘中は 6 秒ごと、戦闘外は 15 秒ごと、カウントダウン中は読まない）、
    HP は頭が「99.0%」の行（満タンのうちは % が出ないので、殴ったあと）。ターゲットとフォーカスの両方にあれば、
    **ボスの欄**を採る（フォーカスは人によって味方に付けるので、フォーカスかどうかでは決めない。2026-10-21）。
    ボスの欄の印は、すぐ近くにタイムラインの技名の詠唱バーが出ていること・名前が敵対リストにも出ていること。両方ボスならフォーカス、
    どちらにも印が無ければ殴っている相手のターゲットの欄。% の後ろが敵の名前で、
    その名前だけの行（数字・「Lv」の無い行）を敵対リストとする（範囲は 3 行ほど。広げすぎると戦闘の終わりが分からなくなる）。
    詠唱バーはタイムラインの技名（詠唱のある技）だけの行で、HP の行にいちばん近いもの。HP が決まったあとは、HP の周りを 2 秒ごとに読む
  - 詠唱バーの判定は 2026-10-21 にゲーム内で確認（熾炎創火）。ただしボスの欄の印での選び方は、フォーカスを味方にした画面で確かめていない
- 範囲の指定は拡大図（最大 4 倍・画素のまま）で行う。ドラッグで囲み直す・矢印キーで 1px（Shift で 10px）・Alt＋矢印で大きさ。
  種類ごとに目安と指定中の大きさを出し、指定するとその場で試し読みする（`checkRegion`）
- 指定していない範囲と、そのためにできないことを出す（`regions.js` の `missingRegions`）
- ファイル（`castline-regions.json`、`format: castline-regions/1`。範囲 1 つを 1 行）に書き出し・読み込みできる。
  読み込みは同じ画面の大きさの同じ種類だけ置き換える
- 再生画面の文字認識は別スレッド（`ocr-worker.js`、呼ぶ側は `ocr-client.js`）で、届いた順に 1 つずつ行う。ページのスレッドで行うと、
  画面全体を読む間（数秒）スクロールや描画が止まった（2026-10-21）。範囲を読む依頼は範囲だけを切り出して渡す。試験ページは従来どおりページのスレッド

| ファイル | 役割 |
|---|---|
| `public/js/player.js` | 再生画面 |
| `public/js/player-guide.js` | 再生画面の「次にすること」の手順ごとの状態 |
| `public/js/screen-reader.js` | 1 フレームを範囲ごとに読んで観測にまとめる（`readFrame`）。読み方は試験ページの連続読み取りと同じ（試験ページはまだ自前の実装のまま） |
| `public/js/pip.js` | 小窓と読み上げ。試験ページで動作を確かめた作りをそのまま使う |
| `public/js/timeline-xml.js` | タイムラインと一覧の XML の読み込み |
| `public/js/regions.js` | 範囲の保存・書き出し・読み込み・未指定の影響（DOM を使わない。`tests/regions.test.mjs`） |
| `public/js/region-editor.js` | 範囲の指定画面（拡大図・全体図・数値・試し読み） |
| `public/js/ocr-worker.js`・`ocr-client.js` | 再生画面の文字認識を別スレッドで行う |
| `public/js/region-finder.js` | 画面で読んだ行から、カウントダウン・HP・敵対リスト・詠唱バーの範囲を決める（自動の範囲指定） |

## FFLogs からの生成（`generator.html`）

利用者が自分の FFLogs クライアントの ID と secret を入れ（client credentials。このブラウザの localStorage
`castline.fflogs-keys` にだけ保存）、レポートの URL と戦闘を選ぶと XML を作る。通信はブラウザから
`ja.fflogs.com` へ直接（トークンと API は vel.works・localhost からの通信を許可している。2026-10-20 確認）。
運営者のキーは使わない。クエリの作りは logs2timeline と同じ（`translate: true`、敵の詠唱は `hostilityType: Enemies`）。

| ファイル | 役割 |
|---|---|
| `public/js/fflogs-api.js` | トークン・GraphQL・レポートと敵の詠唱の読み込み |
| `public/js/fflogs-timeline.js` | 敵の詠唱からタイムラインを組み立てる（DOM なし、`tests/fflogs-timeline.test.mjs`） |
| `public/js/generator.js` | 生成画面 |

- **t は begincast の時刻、duration は begincast の `duration`（詠唱時間 ms）**。画面で読める詠唱開始と同じ基準なので、そのまま同期に使える
- **見えない補助の敵の詠唱は使わない**。ヘビー級1 では本体と同じ名前の補助が別の技 ID・別の詠唱時間で同時に詠唱する
  （「ハードコア」本体 2.7 秒・補助 4.7 秒）。補助は `sourceInstance` が付くので、付かない 1 体目だけを使う
- 詠唱の無い技（begincast の無い cast）は `sync="false"` の表示だけの予定。オートアタック（ID 1・7）と名前の無い技は除く。1 秒以内の同じ技はまとめる
- フェーズは FFLogs の `phaseTransitions` が 2 つ以上あるときだけ分け、次のフェーズの最初の詠唱がいまのフェーズに無ければその詠唱で、あれば経過時間で移る
- コンテンツ名は戦闘の `gameZone.id`（TerritoryType の番号）から `contents.json` の `territory` で引く
- 敵は既定で戦闘名と同じ名前の敵（ボス本体）だけ。ほかの敵（雑魚・分身）は画面で選べる
- 同じ場面で技が入れ替わる（アグリゲートソニック／スプレッドソニック）ものは、生成したログで出た方の名前になる
- 敵の既定は戦闘名と同じ名前の敵。戦闘名が英語のまま（ヘビー級2「Red Hot and Deep Blue」）で見つからなければ、最も詠唱の多い敵とその 3 割以上詠唱する敵
- **前後半に分かれたコンテンツ**（ヘビー級4。FFLogs では別の戦闘・別の encounter だが場所は同じ）は、片方を作って「保持」し、もう一方を作ると
  1 つにまとめる（`mergeParts`）。先頭に予定の無い「開始待ち」フェーズを置き、各パートの最初の 2 つの詠唱（ほかのパートにも出る技は除く）でそのパートへ移る
- ヘビー級1〜4 零式（`public/timelines/aac-heavyweight-m1〜m4-savage.xml`）の骨組みは 2026-10-20 にユーザーが選んだ討伐ログから生成した（`tools/skeletons/`）

## Hojoring 用タイムラインの文言を重ねる（運営者の手元の道具）

Hojoring の時刻は技が当たった時刻（「Xの「Y」」のログ）で、補助の敵の技や台詞・バフでも合わせているので、そのままでは
詠唱バーでの同期に使えない。そこで変換ではなく、**FFLogs から作った骨組みを正とし、Hojoring からは表示と読み上げの文言だけを重ねる**。

```sh
tools/build-timelines.sh   # ヘビー級1〜4 零式を作り直す（sources/ が要る）
```

| ファイル | 役割 |
|---|---|
| `tools/skeletons/<file>.xml` | 骨組み。生成画面で作ったものをそのまま置く（作り直すときは差し替える） |
| `tools/skeletons/<file>.events.json` | 同じ戦闘の敵の全部の技（補助の敵も含む）の時刻と名前。`tools/fflogs-events.py` で作る（キーは環境変数。レポートの番号は書かない） |
| `tools/hojoring-overlay.py` | 重ねる処理。区間ごとのずれ・合わせ直し・付けた行／足した行／見つからない行を報告する |
| `sources/` | Hojoring の元ファイル（第三者の作を含む。git の対象外で公開しない） |

- Hojoring 本体と同じく、FFLogs の技が Hojoring の窓（sync-s・sync-e）に入るたびにずれを合わせ直す（記録した戦闘ごとに
  フェーズの進み方が違い、ヘビー級1 の後半では 9 秒ずれる）。窓の外でも ±6 秒なら文言は付け、続く 3 行がよく合うほうのずれを採る
- 合った技が骨組みの予定（同名で、詠唱の終わりから 6 秒以内に当たったもの）なら text（Hojoring の text）と tts（notice）を付ける。
  **読み上げは Hojoring と同じく notice だけ**で、text は表示だけ。notice の無い予定は読まない（再生画面は tts に文がある予定だけ読む。2026-10-21 のユーザーの指定。以前は技名を読んでいた）。技名の無い行の `tts=""` はその名残
  骨組みに無い技（補助の敵の技）・台詞・同期なしの行は、その時刻に `sync="false"` の表示だけの予定として足す
- Hojoring で「(A|B)」と書いた技は、骨組みの技名を「A|B」に広げる（ログには片方しか残らない）
- 担当ごとの区間（ヘビー級2 の RED・BLUE）は `--role RED=赤` で表示に担当名を付け、担当の notice は読み上げない（両方の担当の文が同時に読まれるため）
- 使わないもの: `<t>` のトリガー（ログ ID・バフで動き、画面の文字では判定できない）、v-notice、icon、notice-o（Castline の読み上げの先読みで代える）
- 出力の note に元ファイルの名前は書かない（利用者は Hojoring のファイルを扱わないため。2026-10-20 のユーザーの決定）。
  タイムラインの作者とライセンスは `<author>` `<license>` に書き、再生画面に出す（2026-10-21 のユーザーの決定）。
  作者は `--author` で指定する（省略時は元ファイルの author）
- 2026-10-20 時点で目立つ元ファイルとのずれ: ヘビー級3 の「ウェポンジェネレート：バスター」（Hojoring は 8 秒遅い）、
  「ヘビーコメット」と「コメット」の名前の入れ替わり（FFLogs では 85 秒がコメット、112 秒がヘビーコメット）

## 未着手

試験ページの範囲の選択を region-editor.js に寄せる、cactbot のタイムラインの取り込み、
技ごとに読み上げを変える（アグリゲートソニックなら「頭割り」、スプレッドソニックなら「ロール」。Hojoring の `<t>` に当たる）、
チャット欄からのカウントダウン、複数の敵の HP、読み取りの遅れを引く処理、試験ページを screen-reader.js に寄せる

## 画面のデザインとビルド

デジタル庁デザインシステム（DADS）準拠で、vel.works の TOP（`vel.works/_build/README.md`）と同じ決まりに従う:
DADS 公式 Tailwind テーマのトークンだけを使う・文字は 16px 以上・役割の色（`vw-*`）・FF14 関連の差し色は lime・
アイコンは Material Symbols（Rounded 400）のインライン SVG・ライト（既定）／ダーク。

- **CSS は `_build/src/app.css` を直し、ビルドして `public/css/app.css` を作る**（`public/css/app.css` を手で直さない）。
  JS が状態をクラス名で切り替える要素（`.status.ok`、`.steps > li.done` など）は意味のクラスのまま app.css で見た目を決め、
  Tailwind のユーティリティは HTML に固定で書く外枠にだけ使う（JS の `className =` でユーティリティが消えないように）
- **アイコン**: HTML には `<svg data-ms="名前" class="icon"></svg>` とだけ書き、ビルドで中身を埋め込む。JS で組み立てる画面のアイコンは
  `_build/scripts/icons.mjs` の `JS_ICONS` に名前を足すと `public/js/icons.js`（生成ファイル）に入り、`icon(名前)` で使える
- **テーマ**: 選んだテーマは localStorage `vw-theme`（vel.works の TOP と同じ鍵。同じサイトなので TOP で選んだものが引き継がれる）。
  `<head>` の 1 行スクリプトで描画前に反映し、`public/js/theme.js`（vel.works/top/assets/theme.js の写し）がボタンで切り替える。
  **小窓はテーマに関係なくダーク**（ゲームに重ねるため。`pip.js` が小窓の html に `data-theme="dark"` を付ける）
- **フォント**: Noto Sans JP / Mono は、このリポジトリに入れず vel.works が配信している `/assets/fonts/` を使う（日本語の分割ファイルで 6MB あるため）。
  `@fontsource` の版を vel.works/_build と同じに固定してファイル名を揃えており、ビルドの最後（`scripts/fonts.mjs`）で有無を確かめる。
  vel.works 以外で配信したときはシステムのフォントで表示される

```bash
cd /var/docker/docker-shared/dev-server-php8/vel.works/ff14tools/castline
# 初回だけ npm install（同じ形で）。vel.works/top を読み取り専用で渡すのは、フォントの有無を確かめるため
docker run --rm -u 1000:1000 -e HOME=/tmp -v $PWD:/w -v $PWD/../../top:/top:ro -w /w/_build node:24-alpine npm run build
```

## 決まり（vel.works の FF14 関連）

- 画面には、非公式であること・外部ツールの利用を勧めないこと（公式記事「FFXIV外部ツールの是非について」へのリンク）・© SQUARE ENIX を入れる
- UI の文字は 1rem 以上
- 画面 OCR が規約上認められている、とは書かない（公式にそう述べた文書は無い）
