// 統制語彙サジェスト 検証ページ
//
// このページは、issue #2「農業分野の表記ゆれ対応」の Phase 1〜2 として
// NDL Authorities (NDLSH) と AGROVOC への直接 SPARQL 呼び出しを
// 実機の Web ブラウザで動作確認するためのものです。
// WebMCP には登録せず、ツール化（suggestSearchTerms）の前段検証に使います。

import { ndlaAdapter } from './sources/ndla-sparql.js';
import { agrovocAdapter } from './sources/agrovoc-sparql.js';
import { pickDisplayLabels, collectAllTerms } from './sources/sparql-utils.js';

const $ = (sel) => document.querySelector(sel);
const form = $('#vocabForm');
const termInput = $('#termInput');
const limitInput = $('#limitInput');
const statusEl = $('#status');
const resultsEl = $('#results');
const debugSparqlEl = $('#debugSparql');
const useNdlaEl = $('#useNdla');
const useAgrovocEl = $('#useAgrovoc');

let currentAbort = null;

function setStatus(msg, kind) {
  statusEl.textContent = msg || '';
  statusEl.dataset.kind = kind || '';
}

async function runSearch() {
  if (currentAbort) currentAbort.abort();
  currentAbort = new AbortController();
  const signal = currentAbort.signal;

  const term = termInput.value.trim();
  const limit = Math.max(1, Math.min(50, Number(limitInput.value) || 10));
  if (!term) {
    setStatus('検索語を入力してください。', 'warn');
    return;
  }

  resultsEl.replaceChildren();
  setStatus('検索中...', 'info');

  const adapters = [];
  if (useNdlaEl.checked) adapters.push(ndlaAdapter);
  if (useAgrovocEl.checked) adapters.push(agrovocAdapter);
  if (adapters.length === 0) {
    setStatus('少なくとも 1 つの語彙を選択してください。', 'warn');
    return;
  }

  const settled = await Promise.allSettled(
    adapters.map((a) => a.searchTerms(term, { limit, signal })),
  );

  const queries = [];
  const sections = [];
  for (let i = 0; i < adapters.length; i++) {
    const a = adapters[i];
    const s = settled[i];
    if (s.status !== 'fulfilled') {
      sections.push({ adapter: a, result: { ok: false, error: s.reason?.message || String(s.reason) } });
      continue;
    }
    const r = s.value;
    if (Array.isArray(r.queries)) queries.push(...r.queries.map((q) => `# ${a.vocabulary}\n${q}`));
    sections.push({ adapter: a, result: r });
  }

  renderSections(sections);
  debugSparqlEl.textContent = queries.join('\n\n— — — — —\n\n') || '(SPARQL は実行されませんでした)';

  const okCount = sections.filter((s) => s.result.ok).length;
  if (okCount === 0) {
    setStatus('すべての語彙で取得に失敗しました。', 'error');
  } else if (okCount < sections.length) {
    setStatus('一部の語彙で取得に失敗しました。', 'warn');
  } else {
    setStatus('', '');
  }
}

function renderSections(sections) {
  resultsEl.replaceChildren();
  for (const { adapter, result } of sections) {
    const section = document.createElement('section');
    section.className = 'source-section';
    section.dataset.source = adapter.vocabulary;

    const h = document.createElement('h2');
    h.className = 'source-title';
    h.textContent = adapter.vocabulary === 'ndla'
      ? `Web NDL Authorities (NDLSH) — ${result.ok ? `${result.total ?? 0} 概念` : 'エラー'}`
      : `AGROVOC — ${result.ok ? `${result.total ?? 0} 概念` : 'エラー'}`;
    section.appendChild(h);

    if (!result.ok) {
      const p = document.createElement('p');
      p.className = 'source-error';
      p.textContent = result.error || '取得に失敗しました。';
      section.appendChild(p);
      resultsEl.appendChild(section);
      continue;
    }

    if (result.warning) {
      const p = document.createElement('p');
      p.className = 'source-empty';
      p.textContent = `警告: ${result.warning}`;
      section.appendChild(p);
    }

    if (!result.concepts || result.concepts.length === 0) {
      const p = document.createElement('p');
      p.className = 'source-empty';
      p.textContent = '該当概念はありませんでした。';
      section.appendChild(p);
      resultsEl.appendChild(section);
      continue;
    }

    // 検索語候補のサマリ（OR 検索向けの語の総数）
    const { terms } = collectAllTerms(result.concepts);
    const summary = document.createElement('div');
    summary.className = 'results-header';
    summary.textContent = `展開後の検索語候補: ${terms.length} 件（重複排除後）`;
    section.appendChild(summary);

    const ul = document.createElement('ul');
    ul.className = 'result-list';
    for (const c of result.concepts) {
      ul.appendChild(renderConcept(c, adapter.vocabulary));
    }
    section.appendChild(ul);
    resultsEl.appendChild(section);
  }
}

function renderConcept(c, vocabulary) {
  const li = document.createElement('li');
  li.className = 'result-item';

  const titleRow = document.createElement('div');
  const titleEl = document.createElement('a');
  titleEl.className = 'result-title';
  titleEl.href = c.uri;
  titleEl.target = '_blank';
  titleEl.rel = 'noopener noreferrer';
  const labels = pickDisplayLabels(c, vocabulary === 'ndla' ? ['ja', '', 'en'] : ['ja', 'en', 'la', '']);
  titleEl.textContent = labels.primary || '(無名概念)';
  titleRow.appendChild(titleEl);

  const uriHint = document.createElement('span');
  uriHint.className = 'result-meta';
  uriHint.style.marginLeft = '8px';
  uriHint.textContent = c.uri;
  titleRow.appendChild(uriHint);

  li.appendChild(titleRow);

  // prefLabel 多言語
  const prefRow = renderLabelMap('prefLabel', c.prefLabel);
  if (prefRow) li.appendChild(prefRow);

  // altLabel 多言語
  const altRow = renderLabelMap('altLabel', flattenAltLabels(c.altLabel));
  if (altRow) li.appendChild(altRow);

  // broader / narrower / related
  for (const key of ['broader', 'narrower', 'related']) {
    if (Array.isArray(c[key]) && c[key].length > 0) {
      const row = document.createElement('div');
      row.className = 'result-subjects';
      const labelName = ({ broader: '上位語', narrower: '下位語', related: '関連語' })[key];
      const items = c[key].map((x) => x.label || x.uri).filter(Boolean);
      row.textContent = `${labelName}: ${items.slice(0, 12).join(' / ')}${items.length > 12 ? ` … +${items.length - 12}` : ''}`;
      li.appendChild(row);
    }
  }

  // exactMatch / closeMatch
  for (const key of ['exactMatch', 'closeMatch']) {
    const arr = c[key];
    if (Array.isArray(arr) && arr.length > 0) {
      const row = document.createElement('div');
      row.className = 'result-identifiers';
      row.textContent = `${key}: ${arr.slice(0, 8).join(' / ')}${arr.length > 8 ? ` … +${arr.length - 8}` : ''}`;
      li.appendChild(row);
    }
  }

  return li;
}

function flattenAltLabels(altLabel) {
  if (!altLabel) return null;
  const out = {};
  for (const [lang, arr] of Object.entries(altLabel)) {
    if (!Array.isArray(arr) || arr.length === 0) continue;
    out[lang] = arr.join(', ');
  }
  return out;
}

function renderLabelMap(labelName, map) {
  if (!map || Object.keys(map).length === 0) return null;
  const row = document.createElement('div');
  row.className = 'result-meta';
  const parts = [];
  // ja → en → la → others → '' の順で表示
  const orderedLangs = ['ja', 'en', 'la', 'fr', 'de', 'es', 'zh', 'ko'];
  const seen = new Set();
  const push = (lang) => {
    if (seen.has(lang)) return;
    if (map[lang] === undefined || map[lang] === '') return;
    seen.add(lang);
    parts.push(`${lang || '–'}: ${map[lang]}`);
  };
  for (const l of orderedLangs) push(l);
  for (const l of Object.keys(map)) push(l);
  push('');
  row.textContent = `${labelName}: ${parts.join(' | ')}`;
  return row;
}

function clearAll() {
  termInput.value = '';
  resultsEl.replaceChildren();
  setStatus('', '');
  debugSparqlEl.textContent = '（まだ検索していません）';
}

function init() {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch();
  });
  $('#clearBtn').addEventListener('click', clearAll);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
