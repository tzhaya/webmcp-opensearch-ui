# WebMCP による文献検索デモンストレーション

[WebMCP](https://github.com/webmachinelearning/webmcp) に対応したブラウザでは AI エージェントから同じ検索フォームを `searchPaper` ツールとして利用できます。
この機能を利用して、AI エージェントを介してCiNii Research を自然言語により検索するデモンストレーションを作成しました。

## 動作環境

- Google Chrome (Windows) バージョン 148.0.7778.97（公式ビルド） （64 ビット）
  - WebMCP の有効化が必要です。これは開発中の機能です。設定変更は自己責任でお願いします。
- Claude for Chrome

## 実行方法

### Chrome での WebMCP の有効化

以下の手順で WebMCP を有効化してください。

1. Chrome **146.0.7672.0 以降** を用意します。
2. アドレスバーに `chrome://flags/#enable-webmcp-testing` を入力します（フラグ名: **WebMCP for testing**）。
3. `Enabled` に変更し、`Relaunch` ボタンで **必ず Chrome を再起動してください**。

### 実行

- 宣言的APIのテスト（フォーム属性でツール登録）
  - https://tzhaya.github.io/webmcp-opensearch-ui/index.html
- 命令的APIのテスト（registerTool() のみ・JSON-LD でAI戻り値を整備）
  - https://tzhaya.github.io/webmcp-opensearch-ui/imperative.html
  - 検索結果中の情報を利用して結果の絞り込みができます。
    - 例：「DOIがある論文を抜き出してください」「件名に コムギ がある論文は何件？」
  - 統制語彙による検索語の自動展開 (`suggestSearchTerms` ツール) も提供しています。
    - 例：「イネの病害虫に関する論文を探して」と依頼すると、ヒット数が少ない場合に AI が
      NDLSH / AGROVOC で「飼料イネ」「稲」「rice」「Oryza sativa」「벼」等、自動的に関連するキーワードを加えて再検索します。
- 統制語彙サジェストの検証ページ（SPARQL の素の挙動確認）
  - https://tzhaya.github.io/webmcp-opensearch-ui/vocab.html
- NDLSH 件名標目から NDC/NDLC 分類記号を取り出し、CiNii Books の `category` パラメータで OR 検索 (`suggestClassificationCodes` ツール)
  - 例：「水稲の病害に関する図書を分類で探して」と依頼すると、AI が件名「イネ」「病害虫」等から
    NDC9 616.2 / NDC10 616.21 / NDLC RB123 等を抽出し、`category="616.2 616.21 RB123"` で書籍検索を実行
- 農林水産関係試験研究機関総合目録（ALIS WebOPAC）を `format=dcndl` で検索 (`searchAffrcOpac` ツール)
  - 例：「稲の病害に関する試験報告を ALIS WebOPAC でも探して」と依頼すると、AI が `keywd` / `cls` 等を組んで
    ALIS WebOPAC を検索。著者典拠 URI・読み・NDC 分類記号 URI・CiNii NCID への `rdfs:seeAlso` を保持した
    JSON-LD で結果を返します。

## ローカル環境での実行

1. Web サーバをご用意ください。ES Modules を使用しているため、`file://` ではなく HTTP サーバ経由で開く必要があります。

   ```sh
   # Python が入っていれば
   python -m http.server 8000

   # あるいは
   npx serve .
   ```

2. `http://localhost:8000/` を Chrome で開いてください。
3. 右上に「**WebMCP: このブラウザで利用可能**」と表示されることを確認してください。
4. Claude for Chrome を起動して、このデモンストレーションページを参照できるようにしてください。
5. Claude で「CiNii で熱帯農業に関する図書を検索してください」のように自然言語で質問してください。フォームに適切なキーワードを入力して検索を実行し、結果を返します。

## 機能

- CiNii Research OpenSearch v2 を直接呼び出して検索
- 検索条件: タイトル / 刊行物名 / 出版年（範囲）/ フリーワード / 人物名 / 本文有無 / 所属機関 / 注記・抄録 / 言語種別（ISO-639-1、複数 OR）
- CiNii の検索種別（all / articles / books / data / dissertations / projects / researchers / projectsAndProducts）切替
- 結果のページネーション・ソート
- WebMCP 宣言的 API（フォーム属性）と命令的 API（`navigator.modelContext.registerTool`、旧仕様の `provideContext` にもフォールバック対応）の両方に対応
- JAIRO Cloud 用のアダプタ枠を用意（メンテナンス復旧後に有効化予定）

### 命令的API + JSON-LD セマンティック整備版デモ（`imperative.html`）

通常版（`https://tzhaya.github.io/webmcp-opensearch-ui/index.html`）と並行して、もう一つのデモページを用意しています。

- **URL**: `https://tzhaya.github.io/webmcp-opensearch-ui/imperative.html`（通常版フッタからもリンク）
- **特徴**:
  - フォーム要素に WebMCP の宣言的属性（`toolname` / `toolparamdescription`）を **一切付けず**、
    命令的 API `navigator.modelContext.registerTool()` 一本で `searchPaper` を登録
  - CiNii の `format=json` レスポンスを JSON-LD として解釈し、AI への戻り値に
    `@context` / 著者 / 件名 / 同定子（DOI/URI）/ 刊行物メタ等の **セマンティック情報を保持**
  - ページ上部に「最後に AI から呼ばれた `searchPaper` の args と戻り値先頭」を表示する
    デバッグペインを内蔵
- **使用ファイル**: `imperative.html` / `imperative.js` / `sources/cinii-jsonld.js`
- **AI 戻り値の構造例**（抜粋）:

  ```jsonc
  {
    "@context": { "dc": "...", "prism": "...", "cir": "...", /* ... */ },
    "source": "cinii",
    "resourceType": "all",
    "query": { "q": "都市計画", "count": "20" },
    "total": 110265,
    "items": [
      {
        "id": "https://cir.nii.ac.jp/crid/...",
        "resourceType": "Article",         // dc:type
        "title": "...",
        "creators": [{ "name": "...", "uri": null }],
        "publication": { "name": "...", "volume": "...", "date": "1985-03" },
        "subjects": [{ "label": "都市計画図", "uri": null }],
        "identifiers": [
          { "type": "DOI", "value": "10.24484/..." },
          { "type": "URI", "value": "https://..." }
        ],
        "hasFullText": false,
        "link": "https://cir.nii.ac.jp/crid/..."
      }
    ]
  }
  ```

  AI は `creators[].uri` / `subjects` / `identifiers` を直接判別でき、続く対話で
  「同じ著者の他論文」「この件名で絞り込み」「DOI から直接参照」等の判断に使えます。

### 統制語彙による検索語の自動展開（`suggestSearchTerms` ツール）

農業・生命科学などの分野では「稲 / イネ / 水稲 / rice / *Oryza sativa*」のように同じ
概念に複数の表記が存在し、ユーザーが入力した語でそのまま検索しても、うまくヒットしないことがあります。命令的API版では、これを 統制語彙で吸収するための `suggestSearchTerms` ツールを備えています。

- **参照する統制語彙 **
  - [Web NDL Authorities](https://id.ndl.go.jp/information/sparql-11/)（NDLSH 件名標目）
    - エンドポイント: `https://id.ndl.go.jp/auth/ndla/sparql`
    - 件名の別名 (`skos-xl:altLabel`)・上下位語 (`skos:broader/narrower`)・関連語 (`skos:related`) に強い
  - [AGROVOC](https://agrovoc.fao.org/browse/agrovoc/en/)（FAO の多言語農業シソーラス）
    - エンドポイント: `https://agrovoc.fao.org/sparql`
    - 多言語ラベル（ja / en / la / ko / zh ...）・学名・NAL Thesaurus への `skos:exactMatch` に強い

- **動作原理 — AIエージェントが要否を判断して統制語彙を使用 **
  - `searchPaper` の戻り値に、ヒット数が少ない場合のみ `expansionHint` を埋め込みます。
  - 自動的に語彙を増やして `searchPaper` を実行しません。AI が自然言語の文脈から「これは表記ゆれだ」
    と判断したときに `suggestSearchTerms` を呼び、展開後の検索語で再度 `searchPaper` で検索を実行します。
  - `AIエージェントによる司書的な検索支援` を意図しています。

- **統制語彙が使われる条件**

  1. **AI に「展開すべき」とヒントが出る条件**（`searchPaper` の戻り値）

     [imperative.js](imperative.js) の `buildExpansionHint` で判定:
     - **件数しきい値**: `total < EXPANSION_HINT_THRESHOLD`（既定 **10 件未満**）
     - **代表語の存在**: `q` / `title` / `description` / `publicationTitle` のいずれかにユーザー入力がある
       （`name` / `affiliation` の人名・機関名は対象外）
     - **`result.ok === true`** で `total` が数値であること（エラー時は出さない）

     上記すべて満たすと、AI 戻り値に `expansionHint: { suggested: true, reason: 'low-result-count', ... }` が
     埋め込まれます。

  2. **実際に `suggestSearchTerms` が呼ばれる条件**

     - **AI 主導**: 自動チェーンしない設計。`expansionHint` を見た AI が判断して呼びます
     - **必須引数**: `term`（空文字は弾く）
     - **語彙選択の優先順位**:
       1. 引数 `vocabularies: ["ndla"|"agrovoc"]` で明示指定 → それを使う
       2. 未指定 → フッタ UI の `localStorage` 設定（既定はどちらも有効）
     - **両方無効化**されている場合: エラー応答を返し、UI 案内文を `hint` に添えます

  3. **語彙別の使い分け**（AI が判定するためのキュー）

     - **`ndla`** → NDLSH。日本語件名標目・別名・上下位語に強い。和書中心の検索向き
     - **`agrovoc`** → FAO 多言語シソーラス。多言語ラベル・学名（*Oryza sativa* など）・
       NAL Thesaurus への `skos:exactMatch` を持つ。農学・国際文献向き

  なお、以下の場合は統制語彙は使われません:
  - 既定で 10 件以上ヒットしたとき（ヒント不出力 → AI は通常そのまま結果を返す）
  - 人名 / 機関名のみで検索したとき（候補語抽出対象外）
  - `searchPaper` がエラーで返ったとき（展開以前にエラーを返す）

- **AI 戻り値の例**（`term: "イネ"` 呼び出し時、抜粋）

  ```jsonc
  {
    "@context": { "skos": "...", "skosxl": "...", "ndla": "...", "agrovoc": "..." },
    "source": "vocab-suggest",
    "inputTerm": "イネ",
    "vocabularies": ["ndla", "agrovoc"],
    "expandedTerms": [
      "イネ科", "禾本科", "稲科", "Grasses",
      "飼料イネ", "飼料用イネ",
      "Oryza sativa", "벼", "稻", "Oryza indica", "Oryza japonica"
      /* ... 計 ~50 件 */
    ],
    "byVocabulary": {
      "ndla":    { "ok": true, "total": 10, "concepts": [/* prefLabel/altLabel/broader/narrower/related */] },
      "agrovoc": { "ok": true, "total": 1,  "concepts": [/* 多言語 prefLabel + 学名 + exactMatch */] }
    }
  }
  ```

- **既定の参照語彙の切り替え**
  - フッタの「**統制語彙（NDLSH / AGROVOC）の既定参照先を設定する**」から個別に有効/無効を切替
  - `localStorage` キー: `vocab.ndla.enabled` / `vocab.agrovoc.enabled`（どちらも既定 `true`）
  - AI 側で個別に指定したい場合は `suggestSearchTerms({ term, vocabularies: ['ndla'] })` のように明示

- **動作確認用ページ**（WebMCP 非対応でも動作）
  - [vocab.html](vocab.html) を開いて任意の語で SPARQL を直接実行・結果と SPARQL クエリ本体を確認できます。
    NDLSH 概念には `relatedMatch (分類記号)` 行で NDC/NDLC コードも表示されます。

### 分類記号による書籍検索（`suggestClassificationCodes` ツール）

NDLSH 件名標目には `skos:relatedMatch` で NDC（日本十進分類法 8/9/10 版）と NDLC（国立国会図書館分類）の
分類記号がリンクしています。`suggestClassificationCodes` ツールはこの関係を辿って分類記号を抽出し、
CiNii Research の書籍検索 (`category` パラメータ) に渡せる形式で返します。

- **使い分け**:
  - `suggestSearchTerms`: **語**の表記ゆれを吸収（別名・上下位語・多言語ラベル）
  - `suggestClassificationCodes`: **書誌分類体系**から関連資料を網羅（同分類の図書を一括 OR 検索）
- **CiNii の `category` パラメータ仕様**（実機検証済み）:
  - 半角スペース区切りで複数指定 → OR 検索（カンマ区切りは無効）
  - NDC8/9/10/NDLC は scheme 区別なくコード文字列でマッチ
  - 書籍 (`resourceType=books`) でのみ有効
- **AI 戻り値の例**（`term: "イネ"` 呼び出し時、抜粋）

  ```jsonc
  {
    "@context": { "skos": "...", "ndla": "...", "ndc": "..." },
    "source": "classification-suggest",
    "inputTerm": "イネ",
    "sourceConcepts": [
      { "uri": "http://id.ndl.go.jp/auth/ndlsh/00564288", "prefLabel": "イネ", "codes": ["616.2", ...] }
    ],
    "codesByScheme": {
      "ndc9":  [{ "code": "616.2", "sourceConcept": "イネ", "sourceUri": "..." }],
      "ndc10": [{ "code": "616.21", "sourceConcept": "イネ", "sourceUri": "..." }],
      "ndlc":  [{ "code": "RB123", "sourceConcept": "イネ", "sourceUri": "..." }]
    },
    "totalCodes": 8,
    "usedCodes": ["616.2", "616.21", "RB123"],
    "suggestedCategoryParam": "616.2 616.21 RB123",
    "suggestedCall": {                                 // 後方互換（CiNii のみ）
      "tool": "searchPaper",
      "args": { "resourceType": "books", "category": "616.2 616.21 RB123" }
    },
    "suggestedCalls": [                                // 推奨: 複数経路を提示
      {
        "tool": "searchPaper",
        "args": { "resourceType": "books", "category": "616.2 616.21 RB123" },
        "note": "CiNii Books は category への半角スペース区切り OR を受け付ける（実機確認済）。"
      },
      {
        "tool": "searchAffrcOpac",
        "args": { "cls": "616.2" },
        "note": "ALIS WebOPAC の cls は単一値のみ。複数コードを試す場合は usedCodes の各値で順次呼び直す。usedCodes 全体: [\"616.2\", \"616.21\", \"RB123\"]"
      }
    ]
  }
  ```

- **フッタ設定**: 「分類記号（NDC/NDLC）レコメンドの有効/無効」で `searchPaper` 戻り値ヒントへの含め方を切替
  （`localStorage` キー: `vocab.classification.enabled`、既定 `true`）。ツール自体は常に登録される。

### ALIS WebOPAC 検索（`searchAffrcOpac` ツール、dcndl 経由）

[農林水産関係試験研究機関総合目録（ALIS WebOPAC）](https://opac.cc.affrc.go.jp/OpenSearch) は農林水産研究情報総合センターが提供する、農林水産省が所管する試験研究機関・国立研究開発法人図書館の蔵書統合目録です。農業・林業・水産分野の灰色文献や試験報告書を多く含みます。
命令的API版は `format=dcndl` で本目録を呼び出す `searchAffrcOpac` ツールを提供します（ツール識別子は API 提供元ドメイン `library.affrc.go.jp` に由来）。

- **dcndl 採用の理由**（`format=rdf` との比較）
  - **NDC 分類記号 URI** が `dcterms:subject rdf:resource="http://id.ndl.go.jp/class/ndc9/..."`
    の形でネイティブに含まれる。これは `suggestClassificationCodes` が NDLSH `skos:relatedMatch` から
    取り出す URI と完全同型で、件名標目→分類記号→ALIS WebOPAC 検索の双方向ナビゲーションが成立
  - **著者典拠 URI** (`foaf:Agent rdf:about="...AU..."`)・**読み** (`dcndl:transcription`)・
    **出版地** (`dcndl:publicationPlace`)・**シリーズ名** (`dcndl:seriesTitle`)・
    **W3CDTF 精密日付** (`dcterms:issued`) など、書誌セマンティクスが格段に豊富
  - `rdfs:seeAlso` に CiNii NCID へのクロスリンクが入るため、ALIS WebOPAC の結果から CiNii Books
    を AI が辿れる
- **API 仕様の注意点**（2026-05-15 確認・API 仕様策定者からのフィードバック反映）
  - エンドポイントは `https://library.affrc.go.jp/api/opnsrhb.do`（302 で `webopac/opnsrhb.do` へリダイレクト、HTTPS 直接アクセス可）
  - **CORS は許可されていません**。GitHub Pages や `localhost` からブラウザ fetch で直接呼び出すと preflight でブロックされます。
    本デモは現状ブラウザ実環境では動作しません（後述「現在の動作上の制約」を参照）
  - **フリーワードは `q` ではなく `keywd`**。`q` を使うと `bad argument` で拒否される
  - **`cls` パラメータは単一値のみ**。半角スペース区切り OR は不可。複数コードを試す場合は AI 側で順次呼び直す
  - **Referer ヘッダ必須**。ブラウザ fetch では `Referrer-Policy` 既定で自動付与されるため呼び出し側では意識不要
  - **レートリミット**: IP 単位で短時間に多数叩くと `bad argument` が返り、数分〜十数分復旧しない
- **AI 戻り値の構造例**（抜粋）

  ```jsonc
  {
    "@context": { "dc": "...", "dcterms": "...", "dcndl": "...", "foaf": "...", "opensearch": "..." },
    "source": "affrc",
    "query": { "keywd": "イネ育種" },
    "total": 42,
    "items": [
      {
        "id": "https://library.affrc.go.jp/.../QQ12345",
        "title": "...",
        "titleTranscription": "...",
        "creators": [
          { "name": "...", "transcription": "...", "uri": "https://library.affrc.go.jp/.../AU00011900" }
        ],
        "publisher": { "name": "...", "transcription": "...", "location": "東京" },
        "publicationPlace": "東京",
        "issued": "2022-02",
        "seriesTitle": "...",
        "extent": "234p",
        "identifiers": [{ "type": "ISBN", "value": "9784..." }],
        "subjects": [{ "label": "イネ", "transcription": "イネ", "uri": null }],
        "classification": [
          { "scheme": "ndc9", "code": "611.05", "uri": "http://id.ndl.go.jp/class/ndc9/611.05" }
        ],
        "seeAlso": ["http://ci.nii.ac.jp/ncid/BA12345678"]
      }
    ]
  }
  ```

- **CORS 回避: プロキシ経由**
  - ALIS WebOPAC は **CORS を許可していない**ため、ブラウザから直接 `searchAffrcOpac` を呼び出すと
    preflight でブロックされます。そのため **Cloudflare Workers ベースの薄いプロキシ経由**で叩く設計です。
  - `searchAffrcOpac` は `https://<worker>?repo=https://library.affrc.go.jp&keywd=...&format=dcndl&...`
    の形でラップして送信します。**既定のプロキシ URL があらかじめ組み込まれている**ため、通常は設定不要です。
  - 別のプロキシを使う場合のみ、フッタの「**ALIS WebOPAC プロキシ URL を設定する**」で上書きできます
    （`localStorage` キー: `affrc.proxyUrl`。「既定に戻す」で上書きを解除）。
  - プロキシ実装は [tzhaya/jc-opensearch-client](https://github.com/tzhaya/jc-opensearch-client)
    の Worker をベースに以下の拡張をしたものです:
    - 許可ホストに `library.affrc.go.jp` を追加
    - `format=dcndl` および ALIS WebOPAC のパラメータ群（`keywd` / `auth` / `pub` / `cls` 等）を許可リストに追加
    - `library.affrc.go.jp` 宛の場合、上流パスを `/webopac/opnsrhb.do` に直接切り替える
      （元の `/api/opnsrhb.do` は 302 を返すが Worker の SSRF 対策で 3xx は弾かれるため）
  - **国外からは利用できません。** 上流の AFFRC 側（CloudFront）が国内向けに制限されており、
    国外からのリクエスト（プロキシの egress 含む）は `403` で弾かれます。
    動作確認は日本国内のネットワークからブラウザで行ってください。

## ディレクトリ構成

```
webmcp-opensearch-ui/
├── index.html            # 通常版: フォーム + 結果領域 (WebMCP 宣言的属性付き)
├── app.js                # 通常版: フォーム制御、ディスパッチ、レンダリング、WebMCP 命令的 API 登録
├── imperative.html       # 命令的API + JSON-LD 整備版: フォーム + デバッグペイン
├── imperative.js         # 命令的API + JSON-LD 整備版: registerTool 一本、AI 戻り値を JSON-LD で整備
├── vocab.html            # 統制語彙サジェスト検証ページ（SPARQL の直接実行）
├── vocab.js              # vocab.html のロジック（NDLSH / AGROVOC アダプタを呼び出すだけ）
├── sources/
│   ├── cinii.js          # CiNii Research アダプタ（表示用フラット構造を返す）
│   ├── cinii-jsonld.js   # CiNii Research アダプタ（AI 向け JSON-LD セマンティック整備版）
│   ├── affrc-opac.js     # 農林水産関係試験研究機関総合目録 (ALIS WebOPAC) dcndl アダプタ
│   ├── jairo.js          # JAIRO Cloud アダプタ（スタブ、available: false）
│   ├── sparql-utils.js   # SPARQL 共通ユーティリティ（fetch / bindings 整形 / 多言語ラベル選択）
│   ├── ndla-sparql.js    # Web NDL Authorities (NDLSH) SPARQL アダプタ（SKOS-XL 対応）
│   └── agrovoc-sparql.js # AGROVOC (FAO 多言語農業シソーラス) SPARQL アダプタ
├── styles.css
├── .nojekyll             # GitHub Pages 用
└── README.md
```

## GitHub Pages へのデプロイする場合

1. このディレクトリを GitHub のリポジトリに push（`main` ブランチ）
2. リポジトリ Settings → Pages → Build and deployment
   - Source: **Deploy from a branch**
   - Branch: **main** / **(root)**
3. 数十秒待つと `https://<user>.github.io/webmcp-opensearch-ui/` で公開されます。

`.nojekyll` を含めているので Jekyll 処理は無効化されます（`sources/` 等のサブディレクトリも素直に配信されます）。

## CiNii APIキーの利用

CiNii Research OpenSearch v2 では、APIキーをパラメータ `appid` として指定することが必要です。
このデモンストレーションでは未指定でもリクエストが可能ですが、以下から「CiNiiウェブAPI 利用登録」を行いAPIキーを取得してご利用ください。

CiNii全般 - メタデータ・API - API利用登録：https://support.nii.ac.jp/ja/cinii/api/developer

このデモンストレーションでのappidの設定方法は以下の通りです。

- ページ下部の **「CiNii の appid を設定する」** を開いて入力 → 「保存」
- もしくはブラウザの DevTools コンソールで:
  ```js
  localStorage.setItem('cinii.appid', 'YOUR_APPID');
  ```

`appid` はブラウザの `localStorage` にのみ保存されます。CiNiiへの検索に使用する以外には、外部には送信されません。

## WebMCP の動作について

WebMCP は 2026 年 2 月時点で W3C Web ML CG により策定中の標準です。
今後、仕様等の変更により、このデモンストレーションが利用できないことがあります。
動作確認済みの環境および有効化手順については「[動作環境](#動作環境)」「[Chrome での WebMCP の有効化](#chrome-での-webmcp-の有効化)」を参照してください。

### うまく検出されない場合

DevTools コンソール（F12）で以下を実行して API の有効化を確認してください。

```js
console.log('modelContext:',        !!navigator.modelContext);
console.log('modelContextTesting:', !!navigator.modelContextTesting);
```

- どちらも `true` → フラグ有効です。ページの検出ロジックを再確認してください。
- どちらも `false` → フラグ未適用です。Chrome 完全終了 → 再起動を再度実施してください。
- バージョンが 146 未満 → Chrome を更新してください。

`navigator.modelContextTesting` はプレビュー期間中の検査用 API で、登録済みツールの一覧取得や手動実行ができます。

WebMCP 対応エージェント（Claude for Chrome 等）を使うと、本ページを開いた状態で「水管理に関する論文を CiNii から探して」等の自然言語でエージェントに検索を依頼できます。エージェントは `searchPaper` ツールを呼び出し、フォームに値が入って結果が表示されます。

未対応のブラウザでも通常のフォーム検索として完全に動作します。

## アダプタを追加する

別の OpenSearch エンドポイント（例: 機関リポジトリ独自の検索 API）を追加したい場合:

1. `sources/<id>.js` を作成し、以下を export してください。
   ```js
   export const myAdapter = {
     id: 'mySource',
     label: '表示名',
     available: true,
     supportedFields: [/* 共通パラメータのうち対応するもの */],
     buildURL(params) { /* URL を組む */ },
     async search(params, { signal }) { /* fetch + 正規化 */ },
     normalizeItem(rawItem) { /* 共通レコード形に変換 */ },
   };
   ```
2. `app.js` の `ADAPTERS` に登録
3. `index.html` の `<fieldset class="sources-fieldset">` にチェックボックスを追加

正規化された結果オブジェクトは
`{ source, id, title, creators[], publication, year, description, link, hasFullText, raw }`
の形を共通とします。

## 参考

- [CiNii Research OpenSearch 仕様](https://support.nii.ac.jp/ja/cir/r_opensearch)
- [WebMCP (W3C Web Machine Learning Community Group)](https://github.com/webmachinelearning/webmcp)
- [Model Context Protocol](https://modelcontextprotocol.io/)

## ライセンス

[CC0 1.0 Universal (Public Domain Dedication)](https://creativecommons.org/publicdomain/zero/1.0/deed.ja)

本リポジトリのコード・ドキュメントは作者によって著作権が放棄されており、商用・非商用を問わず、帰属表示なしに自由に複製・改変・配布できます。

## 注記

このデモンストレーションの作成は生成AIの支援を受けています。

## 作者
Takanori Hayashi
