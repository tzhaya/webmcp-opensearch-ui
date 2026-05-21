// 農林水産関係試験研究機関総合目録（ALIS WebOPAC）アダプタ
// 仕様: https://opac.cc.affrc.go.jp/OpenSearch
//
// 設計判断:
//   - format=dcndl 固定。dcndl は rdf 形式と比べて
//       * NDC 分類記号 URI (http://id.ndl.go.jp/class/ndc9/...) がネイティブ
//       * 著者典拠 URI (foaf:Agent rdf:about=...AU.../) がある
//       * 読み (dcndl:transcription) がタイトル・著者・出版者すべてに付く
//       * シリーズ・発行精密日付・形態が取れる
//     という書誌セマンティクス上の優位がある（issue #3 で詳細比較）。
//   - rdfs:seeAlso に CiNii NCID へのリンクが入るため、AI による自動クロスリンクが可能。
//
// 重要な実装上の制約（2026-05-15 確認）:
//   - **CORS は許可されていない**。GitHub Pages や localhost からのブラウザ fetch は
//     通信開始前に CORS preflight で弾かれる（TypeError: Failed to fetch 等）。
//     **回避策として CORS プロキシ経由を推奨**。本アダプタは
//     `localStorage['affrc.proxyUrl']` が設定されていればプロキシ URL に
//     `?repo=https://library.affrc.go.jp&...` の形でラップして送る。
//     プロキシ実装は jc-opensearch-client の Cloudflare Worker を拡張したものを想定:
//     https://github.com/tzhaya/jc-opensearch-client
//   - **`cls` パラメータは単一値のみ**（半角スペース区切り OR 不可）。
//     suggestClassificationCodes の suggestedCalls はこれに従い単一コードを渡す。
//   - エンドポイントは https://library.affrc.go.jp/api/opnsrhb.do（302 で webopac/opnsrhb.do へ）。
//     プロキシ経由の場合は redirect: 'manual' で 302 が弾かれるため、
//     Worker 側で /webopac/opnsrhb.do を直接叩く設計になっている前提。
//   - Referer ヘッダが必須だが、ブラウザ fetch では Referrer-Policy 既定で自動付与されるため
//     呼び出し側で意識する必要はない。

import { parseClassUri } from './ndla-sparql.js';

// 直接アクセスエンドポイント。CORS NG なのでブラウザからは到達不能だが、
// プロキシを明示的に無効化したい場合（ローカルで CORS を切って検証する等）の
// フォールバック / デバッグ表示用に保持する。
const DIRECT_ENDPOINT = 'https://library.affrc.go.jp/api/opnsrhb.do';
// プロキシ経由時の `repo` 引数値（Worker のホストホワイトリストと一致）
const PROXY_REPO_HOST = 'https://library.affrc.go.jp';
const PROXY_URL_KEY = 'affrc.proxyUrl';
// 既定プロキシ URL（jc-opensearch-client の Worker を ALIS WebOPAC 対応に拡張したもの）。
// localStorage に明示設定があればそちらを優先、空文字が設定されていれば直接アクセス、
// 未設定（null）なら既定値を使う。
// 注意: 上流 AFFRC 側の CloudFront が国内向けに制限されており、海外からは 403 になりうる。
const DEFAULT_PROXY_URL = 'https://jc-proxy.takanori-h.workers.dev';

// AFFRC OpenSearch がサポートする検索パラメータ。
// `keywd` は仕様頁の「フリーワード」相当。CiNii の `q` と異なり名前が独自である点に注意。
const SUPPORTED_PARAMS = [
  'keywd', 'title', 'auth', 'pub', 'year', 'isbnsn', 'ncid',
  'cls', 'sh', 'cntry', 'lang',
  'sortkey', 'listcnt', 'startpos',
];

// プロキシ URL を解決する。
//   - localStorage 未設定（null）  → DEFAULT_PROXY_URL（既定で動く）
//   - localStorage に空文字を保存   → ''（直接アクセス。CORS 検証用の明示的無効化）
//   - localStorage に URL を保存     → その URL
function getProxyUrl() {
  try {
    const v = localStorage.getItem(PROXY_URL_KEY);
    if (v === null) return DEFAULT_PROXY_URL;
    return v.trim();
  } catch {
    return DEFAULT_PROXY_URL;
  }
}

// AI 戻り値に付加する JSON-LD prefix マッピング。
// dcndl 名前空間を中心に、書誌セマンティクスを保持できる最小セット。
export const JSONLD_CONTEXT_AFFRC = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  dcndl: 'http://ndl.go.jp/dcndl/terms/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  opensearch: 'http://a9.com/-/spec/opensearch/1.1/',
};

// 名前空間 URI（dcndl レスポンスで使われる prefix を定数化）
const NS = {
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  dcndl: 'http://ndl.go.jp/dcndl/terms/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  opensearch: 'http://a9.com/-/spec/opensearch/1.1/',
};

// プロキシ経由 URL を組み立てる。
// 形式: `${proxyUrl}?repo=https://library.affrc.go.jp&format=dcndl&<その他>`
// jc-opensearch-client の Worker は repo 引数からホストを取り出して許可リストと照合し、
// AFFRC ホストの場合は upstream を /webopac/opnsrhb.do に切り替える。
function buildProxyURL(proxyUrl, params) {
  const url = new URL(proxyUrl);
  url.searchParams.set('repo', PROXY_REPO_HOST);
  url.searchParams.set('format', 'dcndl');
  for (const key of SUPPORTED_PARAMS) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    const s = String(value).trim();
    if (s === '') continue;
    url.searchParams.set(key, s);
  }
  return url.toString();
}

function buildDirectURL(params) {
  const url = new URL(DIRECT_ENDPOINT);
  url.searchParams.set('format', 'dcndl');
  for (const key of SUPPORTED_PARAMS) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    const s = String(value).trim();
    if (s === '') continue;
    url.searchParams.set(key, s);
  }
  return url.toString();
}

export function buildURL(params) {
  const proxyUrl = getProxyUrl();
  return proxyUrl ? buildProxyURL(proxyUrl, params) : buildDirectURL(params);
}

// ---------- XML パースヘルパ ----------

function getChildrenNS(parent, ns, localName) {
  if (!parent) return [];
  const list = parent.getElementsByTagNameNS(ns, localName);
  // 直下の子のみ採用（孫要素は対象外、Description ネスト処理は呼び出し側）
  const out = [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].parentNode === parent) out.push(list[i]);
  }
  return out;
}

function getAttrNS(el, ns, localName) {
  if (!el) return '';
  return el.getAttributeNS(ns, localName) || '';
}

function textOf(el) {
  return el ? (el.textContent || '').trim() : '';
}

// dcndl では同一プロパティが「テキスト直書き」または
//   <dcterms:title>
//     <rdf:Description>
//       <rdf:value>正式名</rdf:value>
//       <dcndl:transcription>ヨミ</dcndl:transcription>
//     </rdf:Description>
//   </dcterms:title>
// のようなネスト Description のいずれでも書ける。
// ネストがあれば値とトランスクリプションを取り出す。
function extractValueAndTranscription(propEl) {
  if (!propEl) return { value: '', transcription: '' };
  // ネスト Description を探す
  const descs = propEl.getElementsByTagNameNS(NS.rdf, 'Description');
  for (let i = 0; i < descs.length; i++) {
    if (descs[i].parentNode === propEl) {
      const valueEl = descs[i].getElementsByTagNameNS(NS.rdf, 'value')[0];
      const trEl = descs[i].getElementsByTagNameNS(NS.dcndl, 'transcription')[0];
      const value = textOf(valueEl) || textOf(descs[i]);
      const transcription = textOf(trEl);
      return { value, transcription };
    }
  }
  return { value: textOf(propEl), transcription: '' };
}

// ---------- 抽出関数（item 単位） ----------

function extractTitle(itemEl) {
  // dcterms:title または dc:title
  const cands = [
    ...getChildrenNS(itemEl, NS.dcterms, 'title'),
    ...getChildrenNS(itemEl, NS.dc, 'title'),
  ];
  for (const el of cands) {
    const { value, transcription } = extractValueAndTranscription(el);
    if (value) return { title: value, titleTranscription: transcription };
  }
  return { title: '', titleTranscription: '' };
}

function extractCreators(itemEl) {
  const out = [];
  const cands = [
    ...getChildrenNS(itemEl, NS.dcterms, 'creator'),
    ...getChildrenNS(itemEl, NS.dc, 'creator'),
  ];
  for (const el of cands) {
    // <dcterms:creator><foaf:Agent rdf:about="...AU..."><foaf:name>...</foaf:name>
    //   <dcndl:transcription>...</dcndl:transcription></foaf:Agent></dcterms:creator>
    const agentEls = el.getElementsByTagNameNS(NS.foaf, 'Agent');
    if (agentEls.length > 0) {
      for (let i = 0; i < agentEls.length; i++) {
        const a = agentEls[i];
        const uri = getAttrNS(a, NS.rdf, 'about') || '';
        const nameEl = a.getElementsByTagNameNS(NS.foaf, 'name')[0];
        const trEl = a.getElementsByTagNameNS(NS.dcndl, 'transcription')[0];
        const name = textOf(nameEl);
        const transcription = textOf(trEl);
        if (name || uri) out.push({ name, transcription, uri: uri || null });
      }
      continue;
    }
    // フォールバック: テキスト直書き
    const { value, transcription } = extractValueAndTranscription(el);
    if (value) out.push({ name: value, transcription, uri: null });
  }
  return out;
}

function extractPublisher(itemEl) {
  const cands = [
    ...getChildrenNS(itemEl, NS.dcterms, 'publisher'),
    ...getChildrenNS(itemEl, NS.dc, 'publisher'),
  ];
  for (const el of cands) {
    const agentEls = el.getElementsByTagNameNS(NS.foaf, 'Agent');
    if (agentEls.length > 0) {
      const a = agentEls[0];
      const nameEl = a.getElementsByTagNameNS(NS.foaf, 'name')[0];
      const trEl = a.getElementsByTagNameNS(NS.dcndl, 'transcription')[0];
      const locEl = a.getElementsByTagNameNS(NS.dcndl, 'location')[0];
      return {
        name: textOf(nameEl),
        transcription: textOf(trEl),
        location: textOf(locEl),
      };
    }
    const { value, transcription } = extractValueAndTranscription(el);
    if (value) return { name: value, transcription, location: '' };
  }
  return { name: '', transcription: '', location: '' };
}

function extractIdentifiers(itemEl) {
  const out = [];
  const cands = [
    ...getChildrenNS(itemEl, NS.dcterms, 'identifier'),
    ...getChildrenNS(itemEl, NS.dc, 'identifier'),
  ];
  for (const el of cands) {
    const datatype = getAttrNS(el, NS.rdf, 'datatype') || '';
    const value = textOf(el);
    if (!value) continue;
    // datatype URI の末尾セグメントを type 名にする (例: ".../ISBN" → "ISBN")
    const type = datatype ? datatype.replace(/^.*[#/]/, '') : 'unknown';
    out.push({ type, value });
  }
  return out;
}

// 件名標目（dcterms:subject）の抽出。
// rdf:resource (分類記号 URI) と rdf:datatype (分類記号コード値) は
// 分類記号として extractClassification 側で処理するため、ここでは件名標目のみ拾う。
function extractSubjects(itemEl) {
  const out = [];
  const cands = [
    ...getChildrenNS(itemEl, NS.dcterms, 'subject'),
    ...getChildrenNS(itemEl, NS.dc, 'subject'),
  ];
  for (const el of cands) {
    if (getAttrNS(el, NS.rdf, 'resource')) continue;
    if (getAttrNS(el, NS.rdf, 'datatype')) continue;
    const { value, transcription } = extractValueAndTranscription(el);
    if (value) out.push({ label: value, transcription, uri: null });
  }
  return out;
}

// 分類記号の抽出。
// dcndl の場合、以下の 2 系統がある:
//   a) <dcterms:subject rdf:resource="http://id.ndl.go.jp/class/ndc9/611.05" />
//      → URI から scheme と code を取得
//   b) <dc:subject rdf:datatype="http://ndl.go.jp/dcndl/terms/NDC">611.05</dc:subject>
//      → datatype から scheme（NDC）、テキストから code
// CiNii Books の category と AFFRC の cls はいずれも scheme を区別せずコード文字列で
// マッチするため、最終的に code 文字列の集合として扱えれば良いが、AI に scheme を
// 提示できるよう構造化して残す。
function extractClassification(itemEl) {
  const out = [];
  // (a) dcterms:subject の rdf:resource 形式
  const subjEls = [
    ...getChildrenNS(itemEl, NS.dcterms, 'subject'),
    ...getChildrenNS(itemEl, NS.dc, 'subject'),
  ];
  for (const el of subjEls) {
    const resource = getAttrNS(el, NS.rdf, 'resource');
    if (!resource) continue;
    const parsed = parseClassUri(resource);
    if (parsed && parsed.scheme && parsed.code) {
      out.push({ scheme: parsed.scheme, code: parsed.code, uri: parsed.uri });
    }
  }
  // (b) dc:subject の rdf:datatype 形式（コード値のみ、scheme は datatype から推定）
  for (const el of subjEls) {
    const datatype = getAttrNS(el, NS.rdf, 'datatype');
    if (!datatype) continue;
    const code = textOf(el);
    if (!code) continue;
    // datatype 末尾セグメントを scheme 名に変換 (NDC → ndc, NDLC → ndlc 等)
    const schemeRaw = datatype.replace(/^.*[#/]/, '').toLowerCase();
    // 既に (a) で同 code を拾っていたら scheme 詳細はそちらが優先
    if (out.some((c) => c.code === code)) continue;
    out.push({ scheme: schemeRaw, code, uri: null });
  }
  return out;
}

function extractSeeAlso(itemEl) {
  const out = [];
  const cands = getChildrenNS(itemEl, NS.rdfs, 'seeAlso');
  for (const el of cands) {
    const resource = getAttrNS(el, NS.rdf, 'resource');
    if (resource) out.push(resource);
  }
  return out;
}

function pickFirstText(itemEl, ns, localName) {
  const els = getChildrenNS(itemEl, ns, localName);
  for (const el of els) {
    const t = textOf(el);
    if (t) return t;
  }
  return '';
}

export function normalizeItem(itemEl) {
  // 個別書誌の URI（rdf:about）
  const id = getAttrNS(itemEl, NS.rdf, 'about') || '';

  const { title, titleTranscription } = extractTitle(itemEl);
  const creators = extractCreators(itemEl);
  const publisher = extractPublisher(itemEl);
  const identifiers = extractIdentifiers(itemEl);
  const subjects = extractSubjects(itemEl);
  const classification = extractClassification(itemEl);
  const seeAlso = extractSeeAlso(itemEl);

  const date = pickFirstText(itemEl, NS.dcterms, 'issued')
    || pickFirstText(itemEl, NS.dc, 'date');
  const issued = pickFirstText(itemEl, NS.dcterms, 'issued');
  const language = pickFirstText(itemEl, NS.dcterms, 'language')
    || pickFirstText(itemEl, NS.dc, 'language');
  const extent = pickFirstText(itemEl, NS.dcterms, 'extent');
  const seriesTitle = pickFirstText(itemEl, NS.dcndl, 'seriesTitle');
  const publicationPlace = pickFirstText(itemEl, NS.dcndl, 'publicationPlace');

  // 詳細書誌取得用 URL（通常 id と同一だが別フォーマットで叩ける）
  const link = id;

  return {
    source: 'affrc',
    id,
    link,
    title,
    titleTranscription,
    creators,
    publisher,
    publicationPlace,
    date,
    issued,
    language,
    extent,
    seriesTitle,
    identifiers,
    subjects,
    classification,
    seeAlso,
  };
}

// ---------- search 本体 ----------

// dcndl レスポンスは Atom 風のラッパ（feed > entry）の中に
// rdf:Description 形式で書誌が並ぶ。ラッパ要素名は実装依存があるため、
// 「rdf:about を持つ Description のうち、ルート直下の Description（feed）以外」を
// 書誌アイテムとして拾う方針が安全。
function extractItems(doc) {
  // ルート要素
  const root = doc.documentElement;
  if (!root) return [];

  // パターン1: <feed><entry>...<rdf:Description>...</rdf:Description></entry></feed>
  const entries = root.getElementsByTagName('entry');
  if (entries.length > 0) {
    const out = [];
    for (let i = 0; i < entries.length; i++) {
      const descs = entries[i].getElementsByTagNameNS(NS.rdf, 'Description');
      // entry ごとに最も親階層の Description を採用
      let chosen = null;
      for (let j = 0; j < descs.length; j++) {
        if (chosen === null) chosen = descs[j];
        else if (descs[j].parentNode === entries[i]) chosen = descs[j];
      }
      if (chosen) out.push(chosen);
    }
    if (out.length > 0) return out;
  }

  // パターン2: <rdf:RDF><rdf:Description rdf:about="...">...</rdf:Description>...</rdf:RDF>
  const allDescs = root.getElementsByTagNameNS(NS.rdf, 'Description');
  const out = [];
  for (let i = 0; i < allDescs.length; i++) {
    const d = allDescs[i];
    if (!getAttrNS(d, NS.rdf, 'about')) continue;
    out.push(d);
  }
  return out;
}

function extractOpenSearchInt(doc, localName) {
  const els = doc.getElementsByTagNameNS(NS.opensearch, localName);
  if (els.length === 0) return 0;
  const t = (els[0].textContent || '').trim();
  const n = Number(t);
  return Number.isFinite(n) ? n : 0;
}

// 「OP-1172-W bad argument」など WebOPAC のエラーメッセージ HTML が返ってきた場合の検出。
function detectBadArgument(text) {
  if (!text) return false;
  return /OP-\d+-[A-Z]/.test(text) || /bad argument/i.test(text);
}

export async function search(params, { signal } = {}) {
  const url = buildURL(params);
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    const proxyUrl = getProxyUrl();
    const hint = proxyUrl
      ? `プロキシ URL: ${proxyUrl} への到達に失敗しました。Worker が稼働中か、許可 Origin にこのページが含まれているかをご確認ください。`
      : 'ALIS WebOPAC は CORS 未許可のため、ブラウザからの直接 fetch は通信開始前にブロックされます。フッタの「ALIS WebOPAC プロキシ URL」を設定してください。';
    return {
      ok: false,
      source: 'affrc',
      url,
      error: `ネットワークエラー: ${e.message}（${hint}）`,
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      source: 'affrc',
      url,
      status: res.status,
      error: `HTTP ${res.status} ${res.statusText}`,
    };
  }

  const text = await res.text();

  // WebOPAC のエラー HTML が返ってきた場合（クエリ書式 / レート制限）
  if (detectBadArgument(text)) {
    return {
      ok: false,
      source: 'affrc',
      url,
      error: 'AFFRC OPAC が "bad argument" を返しました。クエリ書式（パラメータ名は q ではなく keywd）または短時間の連続呼び出しによるレート制限の可能性があります。数分〜十数分待ってから再試行してください。',
    };
  }

  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
    const parserError = doc.getElementsByTagName('parsererror')[0];
    if (parserError) {
      throw new Error(parserError.textContent || 'XML parse error');
    }
  } catch (e) {
    return {
      ok: false,
      source: 'affrc',
      url,
      error: `XML パースに失敗: ${e.message}`,
    };
  }

  const itemEls = extractItems(doc);
  const items = itemEls.map(normalizeItem);
  const total = extractOpenSearchInt(doc, 'totalResults');
  const startIdx = extractOpenSearchInt(doc, 'startIndex');
  const perPage = extractOpenSearchInt(doc, 'itemsPerPage');

  return {
    ok: true,
    source: 'affrc',
    url,
    total,
    start: startIdx || Number(params.startpos) || 1,
    perPage: perPage || items.length,
    items,
  };
}

// プロキシ URL の取得 / 設定 / クリア API（imperative.js のフッタ UI から呼ぶ）
export function getProxyUrlSetting() {
  return getProxyUrl();
}
export function setProxyUrlSetting(value) {
  try {
    const v = (value || '').trim();
    if (v === '') localStorage.removeItem(PROXY_URL_KEY);
    else localStorage.setItem(PROXY_URL_KEY, v);
    return true;
  } catch {
    return false;
  }
}

export const affrcOpacAdapter = {
  id: 'affrc',
  label: '農林水産関係試験研究機関総合目録 (ALIS WebOPAC, dcndl)',
  available: true,
  endpoint: DIRECT_ENDPOINT,
  supportedFields: SUPPORTED_PARAMS.slice(),
  buildURL,
  search,
  normalizeItem,
};
