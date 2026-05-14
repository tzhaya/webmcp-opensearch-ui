// CiNii Research OpenSearch v2 アダプタ（JSON-LD セマンティック整備版）
// 仕様: https://support.nii.ac.jp/ja/cir/r_opensearch
//
// 既存の sources/cinii.js が表示用のフラット構造を返すのに対し、
// 本モジュールは AI 向けに JSON-LD 風キーを意味的に保持した構造を返す:
//   - dc:identifier の @type を保ったまま identifiers[] に格納（DOI/URI 区別）
//   - dc:subject を { label, uri } の配列に
//   - dc:type を resourceType として保持
//   - prism:* 系の刊行物メタを publication オブジェクトにまとめる
//   - link / @id / rdfs:seeAlso を URI として保持

const ENDPOINT_BASE = 'https://cir.nii.ac.jp/opensearch/v2';

const RESOURCE_TYPES = [
  'all', 'articles', 'books', 'data', 'dissertations',
  'projects', 'researchers', 'projectsAndProducts'
];

const SUPPORTED_PARAMS = [
  'q', 'title', 'publicationTitle', 'name', 'affiliation', 'description',
  'productYearFrom', 'productYearUntil', 'hasLinkToFullText',
  'languageType',
  // category は books 検索専用。NDC8/9/10/NDLC のコード文字列を半角スペース区切りで OR 検索。
  // 例: "613 615 DH435"。CiNii 側は scheme を区別せずコード文字列でマッチする。
  'category',
  'sortorder', 'count', 'start'
];

// AI 戻り値に付加する JSON-LD prefix マッピング（必要最小限）
export const JSONLD_CONTEXT = {
  dc: 'http://purl.org/dc/elements/1.1/',
  dcterms: 'http://purl.org/dc/terms/',
  prism: 'http://prismstandard.org/namespaces/basic/2.0/',
  foaf: 'http://xmlns.com/foaf/0.1/',
  cir: 'https://cir.nii.ac.jp/schema/1.0/',
  opensearch: 'http://a9.com/-/spec/opensearch/1.1/',
  rdfs: 'http://www.w3.org/2000/01/rdf-schema#',
};

function getAppId() {
  try {
    return localStorage.getItem('cinii.appid') || '';
  } catch {
    return '';
  }
}

function buildURL(params) {
  const resourceType = RESOURCE_TYPES.includes(params.resourceType)
    ? params.resourceType
    : 'all';
  const url = new URL(`${ENDPOINT_BASE}/${resourceType}`);
  url.searchParams.set('format', 'json');

  for (const key of SUPPORTED_PARAMS) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    const s = String(value).trim();
    if (s === '') continue;
    url.searchParams.set(key, s);
  }

  const appid = getAppId();
  if (appid) url.searchParams.set('appid', appid);

  return url.toString();
}

// ---------- 値抽出ヘルパ ----------

function asArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function pickString(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'string' && v.trim() !== '') return v;
    if (Array.isArray(v) && v.length > 0) {
      const first = v[0];
      if (typeof first === 'string') return first;
      if (first && typeof first['@value'] === 'string') return first['@value'];
      if (first && typeof first.name === 'string') return first.name;
    }
    if (v && typeof v === 'object') {
      if (typeof v['@value'] === 'string') return v['@value'];
      if (typeof v.name === 'string') return v.name;
    }
  }
  return '';
}

function pickURI(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return pickURI(value[0]);
  if (typeof value === 'object') {
    return value['@id'] || value.url || value.href || null;
  }
  return null;
}

function pickInt(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return 0;
}

// ---------- セマンティック抽出 ----------

// dc:creator は実レスポンスでは文字列の配列が中心だが、
// 将来 foaf:maker や {@id, foaf:name} 形式が混在しうるので両対応。
function extractCreators(item) {
  const out = [];
  const list = [
    ...asArray(item['dc:creator']),
    ...asArray(item['foaf:maker']),
    ...asArray(item.creator),
  ];
  for (const c of list) {
    if (typeof c === 'string') {
      if (c.trim() !== '') out.push({ name: c, uri: null });
    } else if (c && typeof c === 'object') {
      const name = c['foaf:name'] || c.name || c['@value'] || '';
      const uri = c['@id'] || pickURI(c['foaf:maker']) || null;
      if (name || uri) out.push({ name: String(name || ''), uri: uri || null });
    }
  }
  return out;
}

// dc:subject は文字列配列 / object 配列 / URI 配列のいずれもありうる
function extractSubjects(item) {
  const out = [];
  const list = [
    ...asArray(item['dc:subject']),
    ...asArray(item['dcterms:subject']),
  ];
  for (const s of list) {
    if (typeof s === 'string') {
      if (s.trim() !== '') out.push({ label: s, uri: null });
    } else if (s && typeof s === 'object') {
      const label = s['@value'] || s.name || s.label || '';
      const uri = s['@id'] || null;
      if (label || uri) out.push({ label: String(label || ''), uri: uri || null });
    }
  }
  return out;
}

// dc:identifier は実レスポンスで {@type: "cir:DOI"|"cir:URI", @value: "..."} 形式
// @type の "cir:" プレフィックスを剥がして DOI / URI / NCID / ISSN / ISBN 等を分類
function extractIdentifiers(item) {
  const out = [];
  const list = [
    ...asArray(item['dc:identifier']),
    ...asArray(item['dcterms:identifier']),
  ];
  for (const id of list) {
    if (typeof id === 'string') {
      out.push({ type: 'unknown', value: id });
    } else if (id && typeof id === 'object') {
      const rawType = id['@type'] || id.type || 'unknown';
      const type = String(rawType).replace(/^cir:/, '').replace(/^.*[#/]/, '');
      const value = id['@value'] || id.value || id['@id'] || '';
      if (value) out.push({ type, value: String(value) });
    }
  }
  return out;
}

// dc:source は {@id: URI} の配列
function extractSources(item) {
  const out = [];
  for (const s of asArray(item['dc:source'])) {
    const uri = pickURI(s);
    if (uri) out.push(uri);
  }
  return out;
}

// cir:hasLinkToFullText: 実体の格納形式は環境依存。boolean / URI / URI配列 / object のどれも処理可能にする
function extractFullText(item) {
  const v = item['cir:hasLinkToFullText'] ?? item.hasLinkToFullText;
  if (v === undefined || v === null || v === '' || v === false) {
    return { hasFullText: false, uris: [] };
  }
  if (v === true) return { hasFullText: true, uris: [] };
  const list = asArray(v);
  const uris = list.map((x) => pickURI(x)).filter(Boolean);
  return { hasFullText: uris.length > 0 || list.length > 0, uris };
}

function extractYear(item) {
  const date = pickString(item, 'prism:publicationDate', 'dc:date', 'dcterms:issued', 'date');
  const m = date && date.match(/(\d{4})/);
  return m ? m[1] : '';
}

function normalizeItem(item) {
  const id = pickURI(item['@id']) || pickURI(item.link) || '';
  const link = pickURI(item.link) || id;
  const detailJsonURL = pickURI(item['rdfs:seeAlso']) || null;

  // @type は items では "item" 固定だが、配列で返るケースに備えて配列に揃える
  const types = asArray(item['@type']).filter((t) => typeof t === 'string');

  // 実際のリソース型は dc:type に入る（"Article", "Dataset", "Book" 等）
  const resourceType = pickString(item, 'dc:type', 'dcterms:type');

  const title = pickString(item, 'title', 'dc:title');
  const description = pickString(item, 'description', 'dc:description');
  const language = pickString(item, 'dc:language', 'dcterms:language');

  const creators = extractCreators(item);
  const subjects = extractSubjects(item);
  const identifiers = extractIdentifiers(item);
  const sources = extractSources(item);
  const { hasFullText, uris: fullTextURIs } = extractFullText(item);

  const publication = {
    name: pickString(item, 'prism:publicationName', 'publicationName'),
    volume: pickString(item, 'prism:volume'),
    number: pickString(item, 'prism:number'),
    startingPage: pickString(item, 'prism:startingPage'),
    endingPage: pickString(item, 'prism:endingPage'),
    date: pickString(item, 'prism:publicationDate'),
  };
  const publisher = {
    name: pickString(item, 'dc:publisher', 'publisher'),
  };

  return {
    source: 'cinii',
    id,
    types,
    resourceType,
    title,
    creators,
    publication,
    publisher,
    year: extractYear(item),
    language,
    subjects,
    description,
    identifiers,
    sources,
    hasFullText,
    fullTextURIs,
    link,
    detailJsonURL,
    raw: item,
  };
}

async function search(params, { signal } = {}) {
  const url = buildURL(params);
  let res;
  try {
    res = await fetch(url, { signal });
  } catch (e) {
    return {
      ok: false,
      source: 'cinii',
      url,
      error: `ネットワークエラー: ${e.message}`,
    };
  }

  if (!res.ok) {
    let hint = '';
    if (res.status === 401 || res.status === 403) {
      hint = ' （appid が必要な可能性があります。フッタの「appid を設定する」から登録してください）';
    }
    return {
      ok: false,
      source: 'cinii',
      url,
      status: res.status,
      error: `HTTP ${res.status} ${res.statusText}${hint}`,
    };
  }

  let json;
  try {
    json = await res.json();
  } catch (e) {
    return {
      ok: false,
      source: 'cinii',
      url,
      error: `JSON パースに失敗: ${e.message}`,
    };
  }

  const rawItems = asArray(json.items);
  const items = rawItems.map(normalizeItem);
  const total = pickInt(json, 'opensearch:totalResults', 'totalResults');
  const startIdx = pickInt(json, 'opensearch:startIndex', 'startIndex');
  const perPage = pickInt(json, 'opensearch:itemsPerPage', 'itemsPerPage');

  return {
    ok: true,
    source: 'cinii',
    url,
    total,
    start: startIdx || Number(params.start) || 1,
    perPage: perPage || items.length,
    items,
    channelContext: json['@context'] || null,
    channelId: pickURI(json['@id']) || url,
    raw: json,
  };
}

export const ciniiJsonldAdapter = {
  id: 'cinii',
  label: 'CiNii Research (JSON-LD)',
  available: true,
  resourceTypes: RESOURCE_TYPES,
  supportedFields: [
    'q', 'title', 'publicationTitle', 'name', 'affiliation', 'description',
    'productYearFrom', 'productYearUntil', 'hasLinkToFullText',
    'languageType', 'category',
    'sortorder', 'resourceType', 'count', 'start',
  ],
  buildURL,
  search,
  normalizeItem,
};
