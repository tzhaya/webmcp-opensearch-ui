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
概念に複数の表記が存在し、ユーザーが入力した語でそのまま検索しても、うまくヒットしないことがあります。命令的API版では、これを 統制語彙で吸収するための `suggestSearchTerms` ツール備えています。

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
