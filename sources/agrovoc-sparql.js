// AGROVOC (FAO 農業多言語シソーラス) SPARQL アダプタ
//
// エンドポイント: https://agrovoc.fao.org/sparql
//
// 実装ノート（Phase 1 検証で判明）:
//  - AGROVOC は SKOS と SKOS-XL の両方を併用。`skos:prefLabel` / `skos:altLabel` も
//    直接張られているため、SKOS-XL に降りる必要はない（NDLA との違い）。
//  - 多言語ラベルが `xml:lang` 付きで返ってくる。学名は `lang: "la"`。
//  - CORS: `Access-Control-Allow-Origin` は Origin をエコーバック方式。
//    任意のオリジンから呼び出し可能。
//  - 概念 URI 例: http://aims.fao.org/aos/agrovoc/c_5438 (= rice / イネ / Oryza sativa)
//  - 検索は STR(?label) = "..." の完全一致だと拾いこぼしが多いので、
//    部分一致は CONTAINS(LCASE(STR(?label)), LCASE("...")) のように case-insensitive 化。
//
// 共通スキーマ (sparql-utils.js の VocabConcept) に揃える。

import { runSparql, flattenBindings, escapeSparqlString } from './sparql-utils.js';

export const AGROVOC_ENDPOINT = 'https://agrovoc.fao.org/sparql';

// マッチする概念 URI を列挙するクエリ。完全一致 → 部分一致の順で拾う。
// 完全一致のみだと「イネ」と「稲」で別概念にヒットしないことがあるので両方を OR。
export function buildSearchQuery(term, { limit = 10, mode = 'exact-or-contains' } = {}) {
  const t = escapeSparqlString(term);
  const filter = mode === 'exact'
    ? `FILTER(STR(?anyLabel) = "${t}")`
    : `FILTER(STR(?anyLabel) = "${t}" || CONTAINS(LCASE(STR(?anyLabel)), LCASE("${t}")))`;
  return `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
SELECT DISTINCT ?concept WHERE {
  ?concept skos:prefLabel|skos:altLabel ?anyLabel .
  ${filter}
  FILTER(STRSTARTS(STR(?concept), "http://aims.fao.org/aos/agrovoc/"))
}
LIMIT ${Math.max(1, Math.min(100, limit | 0))}`;
}

// 候補 URI から prefLabel / altLabel / broader / narrower / related / exactMatch / closeMatch を取得。
export function buildDetailsQuery(conceptUris) {
  const values = conceptUris.map((u) => `<${u}>`).join(' ');
  return `PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
SELECT ?concept
       ?prefLabel ?altLabel
       ?broader ?broaderLabel
       ?narrower ?narrowerLabel
       ?related ?relatedLabel
       ?exactMatch ?closeMatch
WHERE {
  VALUES ?concept { ${values} }
  OPTIONAL { ?concept skos:prefLabel ?prefLabel }
  OPTIONAL { ?concept skos:altLabel ?altLabel }
  OPTIONAL { ?concept skos:broader ?broader . OPTIONAL { ?broader skos:prefLabel ?broaderLabel . FILTER(LANG(?broaderLabel) = "en" || LANG(?broaderLabel) = "ja") } }
  OPTIONAL { ?concept skos:narrower ?narrower . OPTIONAL { ?narrower skos:prefLabel ?narrowerLabel . FILTER(LANG(?narrowerLabel) = "en" || LANG(?narrowerLabel) = "ja") } }
  OPTIONAL { ?concept skos:related ?related . OPTIONAL { ?related skos:prefLabel ?relatedLabel . FILTER(LANG(?relatedLabel) = "en" || LANG(?relatedLabel) = "ja") } }
  OPTIONAL { ?concept skos:exactMatch ?exactMatch }
  OPTIONAL { ?concept skos:closeMatch ?closeMatch }
}
LIMIT 2000`;
}

function aggregateRows(rows) {
  const byUri = new Map();
  for (const row of rows) {
    const uri = row.concept?.value;
    if (!uri) continue;
    let c = byUri.get(uri);
    if (!c) {
      c = {
        vocabulary: 'agrovoc',
        uri,
        prefLabel: {},
        altLabel: {},
        broader: [],
        narrower: [],
        related: [],
        exactMatch: [],
        closeMatch: [],
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
      // 同 URI で複数言語の label が来た場合は label が後勝ち（en 優先）
      const existing = c[key].find((x) => x.uri === item.uri);
      if (existing) {
        if (!existing.label && item.label) {
          existing.label = item.label;
          existing.lang = item.lang;
        }
      } else {
        c[key].push(item);
      }
    };

    setPref(row.prefLabel?.lang || '', row.prefLabel?.value);
    addAlt(row.altLabel?.lang || '', row.altLabel?.value);
    addRel('broader', row.broader, row.broaderLabel);
    addRel('narrower', row.narrower, row.narrowerLabel);
    addRel('related', row.related, row.relatedLabel);
    if (row.exactMatch?.value && !c.exactMatch.includes(row.exactMatch.value)) {
      c.exactMatch.push(row.exactMatch.value);
    }
    if (row.closeMatch?.value && !c.closeMatch.includes(row.closeMatch.value)) {
      c.closeMatch.push(row.closeMatch.value);
    }
  }
  return Array.from(byUri.values());
}

// 公開 API: 検索語からマッチする AGROVOC 概念を返す。
export async function searchTerms(term, { limit = 10, signal, fetchDetail = true, mode = 'exact-or-contains' } = {}) {
  if (!term || !String(term).trim()) {
    return { ok: true, vocabulary: 'agrovoc', concepts: [], total: 0 };
  }
  const t = String(term).trim();
  const searchQuery = buildSearchQuery(t, { limit, mode });
  let searchJson;
  try {
    searchJson = await runSparql(AGROVOC_ENDPOINT, searchQuery, { signal });
  } catch (e) {
    return { ok: false, vocabulary: 'agrovoc', error: e?.message || String(e), query: searchQuery };
  }
  const rows = flattenBindings(searchJson);
  const uris = [];
  for (const r of rows) {
    const u = r.concept?.value;
    if (u && !uris.includes(u)) uris.push(u);
  }
  if (!fetchDetail || uris.length === 0) {
    return { ok: true, vocabulary: 'agrovoc', concepts: [], total: 0, queries: [searchQuery] };
  }
  const detailQuery = buildDetailsQuery(uris);
  let detailJson;
  try {
    detailJson = await runSparql(AGROVOC_ENDPOINT, detailQuery, { signal });
  } catch (e) {
    return { ok: false, vocabulary: 'agrovoc', error: e?.message || String(e), queries: [searchQuery, detailQuery] };
  }
  const concepts = aggregateRows(flattenBindings(detailJson));
  concepts.sort((a, b) => uris.indexOf(a.uri) - uris.indexOf(b.uri));
  return { ok: true, vocabulary: 'agrovoc', concepts, total: concepts.length, queries: [searchQuery, detailQuery] };
}

export const agrovocAdapter = { vocabulary: 'agrovoc', endpoint: AGROVOC_ENDPOINT, searchTerms };
