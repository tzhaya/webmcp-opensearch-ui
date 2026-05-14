// Web NDL Authorities (NDLSH 件名標目) SPARQL アダプタ
//
// エンドポイント: https://id.ndl.go.jp/auth/ndla/sparql
//   ※ issue #2 記載の `/auth/sparql` は 404。正しいパスは `/auth/ndla/sparql`。
//
// 重要な実装ノート（Phase 1 検証で判明）:
//  - NDLA は SKOS-XL (skos-xl:prefLabel → skos-xl:literalForm) を採用。
//    ただし `rdfs:label` も同時に張られていて、こちらは「prefLabel 相当の最終文字列」を返す。
//    altLabel は SKOS-XL 経由 (skos-xl:altLabel → skos-xl:literalForm) でないと拾えない。
//  - ラベル文字列に `xml:lang` タグは付かない（lang = ""）。
//  - 同じ NDLA 配下に「個人名 (ndlna)」「件名標目 (ndlsh)」が同居しているため、
//    検索用途では `STRSTARTS(STR(?concept), ".../auth/ndlsh/")` で件名標目に限定する。
//  - GET の URL 長制限が長めなので、Web ブラウザからは URL.searchParams で送れば十分。
//  - CORS: `Access-Control-Allow-Origin: *` が返るため、ブラウザから直接呼び出し可能。

import { runSparql, flattenBindings, escapeSparqlString } from './sparql-utils.js';

export const NDLA_ENDPOINT = 'https://id.ndl.go.jp/auth/ndla/sparql';
export const NDLSH_URI_PREFIX = 'http://id.ndl.go.jp/auth/ndlsh/';

// NDLA の skos:relatedMatch URI から「分類スキーム」と「分類記号」を抽出する。
// 観測した形式:
//   http://id.ndl.go.jp/class/ndc8/...   NDC 8版
//   http://id.ndl.go.jp/class/ndc9/...   NDC 9版
//   http://id.ndl.go.jp/class/ndc10/...  NDC 10版
//   http://id.ndl.go.jp/class/ndlc/...   NDLC（国立国会図書館分類表）
// CiNii Research books の category パラメータは scheme を区別せずコード文字列で受けるため、
// scheme は AI 判断材料として保持しつつ code は素のまま渡す。
const CLASS_URI_RE = /^https?:\/\/id\.ndl\.go\.jp\/class\/([a-z0-9]+)\/(.+)$/i;
export function parseClassUri(uri) {
  if (!uri) return null;
  const m = String(uri).match(CLASS_URI_RE);
  if (!m) return { uri, scheme: null, code: null };
  return { uri, scheme: m[1].toLowerCase(), code: decodeURIComponent(m[2]) };
}

// 件名標目検索クエリを組み立てる。
//   term: ユーザー入力の検索語（部分一致）
//   limit: SPARQL の上位件数。NDLA は 1 クエリ最大 1000 件。
//
// 一回のクエリで prefLabel / altLabel / broader / narrower / related / exactMatch を
// すべて引くと OPTIONAL の組合せが爆発するため、ここでは「概念候補の列挙」と
// 「概念ごとの詳細」の 2 段階に分ける。
export function buildSearchQuery(term, { limit = 20 } = {}) {
  const t = escapeSparqlString(term);
  return `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX skosxl: <http://www.w3.org/2008/05/skos-xl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT DISTINCT ?concept ?prefLabel WHERE {
  {
    ?concept rdfs:label ?prefLabel .
    FILTER(CONTAINS(STR(?prefLabel), "${t}"))
  } UNION {
    ?concept skosxl:altLabel/skosxl:literalForm ?altLabel .
    FILTER(CONTAINS(STR(?altLabel), "${t}"))
    ?concept rdfs:label ?prefLabel .
  }
  FILTER(STRSTARTS(STR(?concept), "${NDLSH_URI_PREFIX}"))
}
ORDER BY STRLEN(STR(?prefLabel))
LIMIT ${Math.max(1, Math.min(100, limit | 0))}`;
}

// 概念 URI から、altLabel / broader / narrower / related / exactMatch をまとめて引く。
// 1 URI ずつ問い合わせると遅いので、最大 ~10 件を VALUES でまとめて投げる。
export function buildDetailsQuery(conceptUris) {
  const values = conceptUris.map((u) => `<${u}>`).join(' ');
  return `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
PREFIX skosxl: <http://www.w3.org/2008/05/skos-xl#>
PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
SELECT ?concept ?prefLabel ?altLabel
       ?broader ?broaderLabel
       ?narrower ?narrowerLabel
       ?related ?relatedLabel
       ?exactMatch
       ?relatedMatch
WHERE {
  VALUES ?concept { ${values} }
  OPTIONAL { ?concept rdfs:label ?prefLabel }
  OPTIONAL { ?concept skosxl:altLabel/skosxl:literalForm ?altLabel }
  OPTIONAL { ?concept skos:broader ?broader . OPTIONAL { ?broader rdfs:label ?broaderLabel } }
  OPTIONAL { ?concept skos:narrower ?narrower . OPTIONAL { ?narrower rdfs:label ?narrowerLabel } }
  OPTIONAL { ?concept skos:related ?related . OPTIONAL { ?related rdfs:label ?relatedLabel } }
  OPTIONAL { ?concept skos:exactMatch ?exactMatch }
  OPTIONAL { ?concept skos:relatedMatch ?relatedMatch }
}
LIMIT 1000`;
}

// SPARQL 結果（flattenBindings 済み）を VocabConcept[] に集約する。
function aggregateRows(rows) {
  const byUri = new Map();
  for (const row of rows) {
    const uri = row.concept?.value;
    if (!uri) continue;
    let c = byUri.get(uri);
    if (!c) {
      c = {
        vocabulary: 'ndla',
        uri,
        prefLabel: {},
        altLabel: {},
        broader: [],
        narrower: [],
        related: [],
        exactMatch: [],
        relatedMatch: [],
      };
      byUri.set(uri, c);
    }
    const setPref = (lang, v) => { if (v && !c.prefLabel[lang]) c.prefLabel[lang] = v; };
    const addAlt = (lang, v) => {
      if (!v) return;
      const arr = (c.altLabel[lang] ||= []);
      if (!arr.includes(v)) arr.push(v);
    };
    const addRel = (key, uriCell, labelCell) => {
      if (!uriCell?.value) return;
      const item = { uri: uriCell.value, label: labelCell?.value || '', lang: labelCell?.lang || '' };
      if (!c[key].some((x) => x.uri === item.uri)) c[key].push(item);
    };

    setPref(row.prefLabel?.lang || '', row.prefLabel?.value);
    addAlt(row.altLabel?.lang || '', row.altLabel?.value);
    addRel('broader', row.broader, row.broaderLabel);
    addRel('narrower', row.narrower, row.narrowerLabel);
    addRel('related', row.related, row.relatedLabel);
    if (row.exactMatch?.value && !c.exactMatch.includes(row.exactMatch.value)) {
      c.exactMatch.push(row.exactMatch.value);
    }
    if (row.relatedMatch?.value) {
      const parsed = parseClassUri(row.relatedMatch.value);
      if (parsed && !c.relatedMatch.some((x) => x.uri === parsed.uri)) {
        c.relatedMatch.push(parsed);
      }
    }
  }
  return Array.from(byUri.values());
}

// 公開 API: 検索語からマッチする件名標目の概念群を返す。
//   options:
//     limit       SPARQL 候補上位件数（既定 10）
//     signal      AbortSignal
//     fetchDetail 詳細クエリ（broader/narrower/related）も実行するか（既定 true）
export async function searchTerms(term, { limit = 10, signal, fetchDetail = true } = {}) {
  if (!term || !String(term).trim()) {
    return { ok: true, vocabulary: 'ndla', concepts: [], total: 0 };
  }
  const t = String(term).trim();
  const searchQuery = buildSearchQuery(t, { limit });
  let searchJson;
  try {
    searchJson = await runSparql(NDLA_ENDPOINT, searchQuery, { signal });
  } catch (e) {
    return { ok: false, vocabulary: 'ndla', error: e?.message || String(e), query: searchQuery };
  }
  const candidateRows = flattenBindings(searchJson);
  const uris = [];
  for (const r of candidateRows) {
    const u = r.concept?.value;
    if (u && !uris.includes(u)) uris.push(u);
  }

  if (!fetchDetail || uris.length === 0) {
    const seeded = aggregateRows(candidateRows);
    return { ok: true, vocabulary: 'ndla', concepts: seeded, total: seeded.length, queries: [searchQuery] };
  }

  const detailQuery = buildDetailsQuery(uris);
  let detailJson;
  try {
    detailJson = await runSparql(NDLA_ENDPOINT, detailQuery, { signal });
  } catch (e) {
    // 詳細が取れなくても候補だけで返す（部分失敗）
    const seeded = aggregateRows(candidateRows);
    return {
      ok: true,
      vocabulary: 'ndla',
      concepts: seeded,
      total: seeded.length,
      queries: [searchQuery, detailQuery],
      warning: `詳細クエリ失敗: ${e?.message || e}`,
    };
  }
  const detailRows = flattenBindings(detailJson);
  const concepts = aggregateRows(detailRows);
  // 候補で出た順序を尊重
  concepts.sort((a, b) => uris.indexOf(a.uri) - uris.indexOf(b.uri));
  return {
    ok: true,
    vocabulary: 'ndla',
    concepts,
    total: concepts.length,
    queries: [searchQuery, detailQuery],
  };
}

export const ndlaAdapter = { vocabulary: 'ndla', endpoint: NDLA_ENDPOINT, searchTerms };
