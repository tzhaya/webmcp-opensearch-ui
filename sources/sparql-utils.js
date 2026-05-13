// SPARQL クエリ共通ユーティリティ
//
// NDL Authorities / AGROVOC など複数の SKOS エンドポイントに対して
// GET / `application/sparql-results+json` で問い合わせる共通関数と、
// 結果を `[{ vocabulary, uri, prefLabel, altLabel, broader, narrower, related, ... }]`
// という統一スキーマに整形するためのヘルパを提供する。
//
// 共通返却スキーマ（VocabConcept）:
//   {
//     vocabulary: 'ndla' | 'agrovoc',
//     uri:        string,                          // 概念の URI
//     prefLabel:  { [lang]: string },              // 言語タグ → 優先ラベル
//     altLabel:   { [lang]: string[] },            // 言語タグ → 別名ラベル群
//     broader:    [{ uri, label, lang? }],         // 上位概念
//     narrower:   [{ uri, label, lang? }],         // 下位概念
//     related:    [{ uri, label, lang? }],         // 関連概念
//     exactMatch: string[],                        // 他語彙との同一性リンク URI
//   }
// 言語タグなし（NDLA のように `lang: ""` で返ってくる）の場合は
// 便宜上 `''` キーに格納する。表示時は ja > '' > en の順で fallback すれば良い。

export async function runSparql(endpoint, query, { signal, method = 'GET' } = {}) {
  const headers = { Accept: 'application/sparql-results+json' };
  let url = endpoint;
  let init = { signal, headers };
  if (method === 'POST') {
    init = {
      ...init,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: new URLSearchParams({ query }),
    };
  } else {
    const u = new URL(endpoint);
    u.searchParams.set('query', query);
    url = u.toString();
  }
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.text()).slice(0, 240); } catch { /* ignore */ }
    throw new Error(`SPARQL ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
  }
  const ct = res.headers.get('content-type') || '';
  const text = await res.text();
  if (!ct.includes('json')) {
    // 一部のエンドポイントは format パラメータが必要。HTML が返ってきたら検出して説明。
    throw new Error(`SPARQL endpoint returned non-JSON (Content-Type: ${ct}). 先頭: ${text.slice(0, 120)}`);
  }
  let json;
  try { json = JSON.parse(text); }
  catch (e) { throw new Error(`SPARQL JSON parse failed: ${e.message}`); }
  if (json?.head?.status === 'error') {
    throw new Error(`SPARQL endpoint error: ${json.head.msg || 'unknown'}`);
  }
  return json;
}

// SPARQL JSON results の bindings を素朴な配列に展開する。
// row[var] = { value, lang } のシンプルな形に揃える。
export function flattenBindings(json) {
  const rows = json?.results?.bindings || [];
  return rows.map((b) => {
    const row = {};
    for (const [k, v] of Object.entries(b)) {
      row[k] = {
        value: v?.value ?? '',
        lang: v?.['xml:lang'] ?? '',
        type: v?.type ?? '',
      };
    }
    return row;
  });
}

// 複数 row を ?concept でグループ化して VocabConcept 形式に集約する。
// labelExtractors は各列名 → (row) => ({lang, value}) などのカスタム整形関数。
// シンプル用途のため、本ファイル内では使わず ndla-sparql.js / agrovoc-sparql.js で実装する。

// 言語優先順を考慮して prefLabel/altLabel を選び出す表示用ヘルパ。
// 戻り値: { primary: string, secondary: string[] }
export function pickDisplayLabels(concept, preferredLangs = ['ja', '', 'en']) {
  const primary = pickByLang(concept.prefLabel || {}, preferredLangs) || '';
  const secondary = [];
  for (const lang of preferredLangs) {
    const arr = concept.altLabel?.[lang];
    if (Array.isArray(arr)) for (const v of arr) if (v && !secondary.includes(v)) secondary.push(v);
  }
  // preferredLangs 外も全部 secondary に拾う
  for (const [lang, arr] of Object.entries(concept.altLabel || {})) {
    if (preferredLangs.includes(lang)) continue;
    if (Array.isArray(arr)) for (const v of arr) if (v && !secondary.includes(v)) secondary.push(v);
  }
  return { primary, secondary };
}

function pickByLang(map, preferredLangs) {
  if (!map) return '';
  for (const lang of preferredLangs) {
    if (map[lang]) return map[lang];
  }
  // どれも無ければ最初の値
  const first = Object.values(map).find(Boolean);
  return first || '';
}

// AI 戻り値・キャッシュ用に「重複した検索語候補」を平坦化する。
// 入力: VocabConcept[] / 出力: { terms: string[], byLang: {lang: string[]} }
export function collectAllTerms(concepts, { langs = null } = {}) {
  const terms = new Set();
  const byLang = {};
  const add = (v, lang) => {
    if (!v) return;
    if (langs && langs.length > 0 && !langs.includes(lang)) return;
    terms.add(v);
    const key = lang || '';
    (byLang[key] ||= []).push(v);
  };
  for (const c of concepts) {
    for (const [lang, v] of Object.entries(c.prefLabel || {})) add(v, lang);
    for (const [lang, arr] of Object.entries(c.altLabel || {})) {
      for (const v of arr) add(v, lang);
    }
  }
  // byLang 内も重複除去
  for (const k of Object.keys(byLang)) {
    byLang[k] = Array.from(new Set(byLang[k]));
  }
  return { terms: Array.from(terms), byLang };
}

// クエリのうちユーザー文字列を埋め込む箇所に対して、SPARQL 文字列リテラル用にエスケープする。
// バックスラッシュ・ダブルクオート・改行のみエスケープ。日本語等のマルチバイト文字はそのまま。
export function escapeSparqlString(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, '\\n');
}
