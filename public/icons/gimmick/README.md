# ギミックのアイコン

Castline の再生画面と小窓で、予定の時刻の左に出すアイコンです。図案は Castline の独自のもので、ゲームの画像は使っていません。
24×24 の SVG で、暗い角丸の地に描いています。

## タイムラインでの書き方

entry の `gimmick_icon` にギミックを 1 つ書きます。下の表の id でも名前でも書けて、拡張子は見ません（`tower.png`・`tower`・`塔踏み` は同じ）。
「ボス中心円形範囲（チャリオット）」のような名前は、括弧の中（`チャリオット`）か外（`ボス中心円形範囲`）だけでも引けます。

```xml
<entry t="36.0" text="タンク強" castname="ハードコア" gimmick_icon="tankbuster.png" skills_icon="rampart.png,rampart2.png"/>
<entry t="52.0" castname="ダイナモの技" gimmick_icon="ダイナモ"/>
```

- `skills_icon` はスキルのアイコンで、カンマ区切りで複数書けます。スキルの画像は同梱していないので、自分で用意したファイルを書きます
- 自分の画像は、配信のタイムラインなら XML の場所からの相対パス、手元の XML なら URL（http・https・data）で書きます
- 用意したアイコンと同じ名前の自分の画像を使うときは `./tower.png` のように `./` を付けます
- 表に無い名前や読めないファイルは表示を飛ばし、タイムラインを読み込んだときに記録に出します

## 色の決まり

| 色 | 使いどころ |
|---|---|
| 橙 | 全体攻撃・床の範囲（チャリオット・ダイナモ・直線・扇・メテオ・エクサフレアなど） |
| 赤 | タンク・ボスの位置・禁止（視線見ない・足止め）・爆弾・磁石 |
| 黄 | 頭割り・距離減衰・移動の向き |
| 紫 | 散開・視線 |
| 青緑・水色 | 立ち位置（距離調整）・塔・ノックバック |
| 青・緑 | 線・鎖・回転 |
| 白 | 番号・人・矢印 |

## 一覧

「Castline での解釈」と書いたものは、呼び名の意味が決まっていないため Castline で決めた意味です。

| アイコン | id | 名前 | 意味（プレイヤーがすること） | 図案 |
|---|---|---|---|---|
| <img src="raidwide.svg" width="32" alt=""> | `raidwide` | 全体攻撃 | パーティ全員が受ける範囲攻撃。軽減を合わせる | 中心の円から 6 方向に広がる光 |
| <img src="tankbuster.svg" width="32" alt=""> | `tankbuster` | タンク強攻撃 | タンクへの強い単体攻撃。タンクは防御のアビリティを使う | 赤い盾と稲妻 |
| <img src="tank-share.svg" width="32" alt=""> | `tank-share` | タンク頭割り | タンク 2 人で受ける頭割りの強攻撃 | 黄色い頭割りの輪の中に赤い盾 |
| <img src="stack.svg" width="32" alt=""> | `stack` | 頭割り | 対象の周りに集まって、ダメージを分け合う | 中心の円に 4 方向から寄る黄色い矢印 |
| <img src="spread.svg" width="32" alt=""> | `spread` | 散開 | 範囲が重ならないよう、ばらけて受ける | 離れて並ぶ 4 つの紫の円 |
| <img src="tower.svg" width="32" alt=""> | `tower` | 塔踏み | 床の塔に決まった人数で入る。入らないと全体に被害 | 床の円と、そこから立つ光の柱。白い点は入る人数 |
| <img src="dice.svg" width="32" alt=""> | `dice` | サイコロ | 頭上の番号（1・2・3…）の順に処理する | 目のあるサイコロ |
| <img src="half-room.svg" width="32" alt=""> | `half-room` | 半面攻撃 | フィールドの半分を攻撃する。反対側へ逃げる | 半分だけ塗った円 |
| <img src="target-marker.svg" width="32" alt=""> | `target-marker` | 単体マーカー | 頭上のマーカーの人に攻撃が来る（単体） | 人の頭上に赤い三角のマーカー |
| <img src="aoe-marker.svg" width="32" alt=""> | `aoe-marker` | AoEマーカー | 頭上のマーカーの人を中心に範囲攻撃。他の人から離れる | 人を囲む橙の範囲 |
| <img src="gaze-look.svg" width="32" alt=""> | `gaze-look` | 視線見る | ボス・目の方を見る | 紫の目 |
| <img src="gaze-away.svg" width="32" alt=""> | `gaze-away` | 視線見ない | ボス・目の方を見ない（背を向ける） | 紫の目に赤い斜線 |
| <img src="proximity.svg" width="32" alt=""> | `proximity` | 距離減衰 | 着弾点から離れるほど被害が小さい | 中心から広がる同心円 |
| <img src="knockback.svg" width="32" alt=""> | `knockback` | ノックバック | 吹き飛ばし。向きと落下に気を付ける。堅実魔・アームズレングスで防げることがある | 赤い点（ボス）から押し出す矢印 |
| <img src="tether-stretch.svg" width="32" alt=""> | `tether-stretch` | 線伸ばす | 付いた線を、相手から離れて伸ばす（切る・色を変える） | 線でつながった 2 人と、外向きの矢印 |
| <img src="tether-take.svg" width="32" alt=""> | `tether-take` | 線取る | ボスと他の人の線の間に入って、線を取る | ボス（赤）から伸びる線を受ける緑の人 |
| <img src="chain.svg" width="32" alt=""> | `chain` | 鎖 | 2 人をつなぐ鎖。離れると切れる | つながった 2 つの輪 |
| <img src="divebomb.svg" width="32" alt=""> | `divebomb` | ダイブボム | ボスが飛び上がり、着地点を攻撃する（Castline での解釈） | 斜めに降りる矢印と着地点 |
| <img src="range-near.svg" width="32" alt=""> | `range-near` | 距離調整ニア | ボスの近くに立つ（Castline での解釈） | N と、ボス（赤い点）からの短い棒 |
| <img src="range-middle.svg" width="32" alt=""> | `range-middle` | 距離調整ミドル | ボスから中くらいの距離に立つ（Castline での解釈） | M と、ボスからの中くらいの棒 |
| <img src="range-far.svg" width="32" alt=""> | `range-far` | 距離調整ファー | ボスから遠くに立つ（Castline での解釈） | F と、ボスからの長い棒 |
| <img src="bind.svg" width="32" alt=""> | `bind` | 足止め | 動けなくなる（バインド。Castline での解釈） | 足元に赤い枷の付いた人 |
| <img src="chariot.svg" width="32" alt=""> | `chariot` | ボス中心円形範囲（チャリオット） | ボスの周りの円の範囲。外へ逃げる | ボスを中心に塗った円 |
| <img src="dynamo.svg" width="32" alt=""> | `dynamo` | ボス中心ドーナツ型範囲（ダイナモ） | ボスの周りのドーナツ型の範囲。内側（ボスの足元）へ入る | ボスを中心に穴の開いた円 |
| <img src="line.svg" width="32" alt=""> | `line` | 直線範囲 | 直線の範囲。横へ避ける | ボスから伸びる長方形 |
| <img src="cone.svg" width="32" alt=""> | `cone` | 扇範囲 | 扇形の範囲。扇の外へ避ける | ボスから広がる扇 |
| <img src="aoe.svg" width="32" alt=""> | `aoe` | AoE範囲 | 床に出る範囲。予兆の外へ出る | 橙の円 2 つ |
| <img src="meteor.svg" width="32" alt=""> | `meteor` | メテオ | 落ちてくる隕石。落とす場所を決める・塔のように受ける | 落ちてくる火の玉と、落下地点の円 |
| <img src="flare.svg" width="32" alt=""> | `flare` | フレア | 付いた人を中心にした距離減衰の大きな爆発。付いた人は端へ、他の人は離れる | 中心が明るい爆発の形 |
| <img src="exaflare.svg" width="32" alt=""> | `exaflare` | エクサフレア | 矢印の方向へ連続で進む円の範囲。通った後へ入る | 進む方向へ薄くなる 3 つの円と矢印 |
| <img src="magnet.svg" width="32" alt=""> | `magnet` | 磁石 | プラス・マイナスの磁力。同じ符号で弾かれ、違う符号で引き寄せられる | U 字の磁石 |
| <img src="acceleration-bomb.svg" width="32" alt=""> | `acceleration-bomb` | 加速度爆弾 | 効果が切れる瞬間に動いていると爆発する。そのときは止まる | 赤い爆弾に一時停止の記号 |
| <img src="rotation.svg" width="32" alt=""> | `rotation` | 回転 | 回転する攻撃・予兆。回る向きを見る | ボスの周りを回る青い矢印 |
| <img src="forced-march.svg" width="32" alt=""> | `forced-march` | 移動命令 | 決まった方向へ勝手に歩かされる（移動命令）。向きを合わせてから受ける | 人と、進む方向の矢印 |

## 追加・変更するとき

- アイコンの一覧は `public/js/gimmick-icons.js` の `GIMMICK_ICONS`（id と名前）。ファイルはこのフォルダの `<id>.svg`
- 24px で見分けられるよう、描く要素は 1〜2 個にする。色は上の決まりに合わせる
- 一覧を変えたら、このファイルとリポジトリの README.md の表も直す
