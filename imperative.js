// CiNii Research WebMCP デモ（命令的 API + JSON-LD 整備版）
//
// このページの狙い:
//   1. WebMCP 宣言的 API（<form toolname>, <input toolparamdescription>）を一切使わず、
//      命令的 API navigator.modelContext.registerTool() のみで searchPaper を登録する。
//   2. CiNii の format=json レスポンスを JSON-LD として意味的に解釈し、
//      AI に返す戻り値に @context・型・著者・件名・同定子（DOI/URI）等を残す。
//
// 既存の app.js とは独立した実装で、index.html / app.js には影響しない。

import { ciniiJsonldAdapter, JSONLD_CONTEXT } from './sources/cinii-jsonld.js';

const LOGICAL_FIELDS = [
  'q', 'title', 'publicationTitle', 'name', 'affiliation', 'description',
  'productYearFrom', 'productYearUntil', 'hasLinkToFullText',
  'languageType',
  'sortorder', 'resourceType', 'count', 'start',
];

const TOOL_NAME = 'searchPaper';

let currentAbort = null;

// ---------- DOM ----------
const $ = (sel) => document.querySelector(sel);
const form = $('#searchForm');
const statusEl = $('#status');
const resultsHeader = $('#resultsHeader');
const resultsEl = $('#results');
const paginationEl = $('#pagination');
const mcpStatusEl = $('#mcp-status');
const debugArgsEl = $('#debugArgs');
const debugReturnEl = $('#debugReturn');

// ---------- フォーム / パラメータ変換 ----------
function getFormParams(formEl) {
  const fd = new FormData(formEl);
  const params = {};
  for (const f of LOGICAL_FIELDS) {
    const v = fd.get(f);
    if (v !== null && String(v).trim() !== '') {
      params[f] = String(v).trim();
    }
  }
  return params;
}

function fillForm(params) {
  if (!params || typeof params !== 'object') return;
  for (const f of LOGICAL_FIELDS) {
    if (params[f] === undefined || params[f] === null) continue;
    const el = formEl(f);
    if (el) el.value = String(params[f]);
  }
}

function formEl(name) {
  return form.elements.namedItem(name);
}

function normalizeArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const f of LOGICAL_FIELDS) {
    if (args[f] !== undefined && args[f] !== null && String(args[f]).trim() !== '') {
      out[f] = String(args[f]).trim();
    }
  }
  return out;
}

// ---------- 検索ディスパッチ ----------
async function runSearch(params) {
  if (currentAbort) currentAbort.abort();
  currentAbort = new AbortController();
  const signal = currentAbort.signal;

  renderStatus('検索中...', 'info');
  resultsEl.replaceChildren();
  resultsHeader.replaceChildren();
  paginationEl.replaceChildren();

  let result;
  try {
    result = await ciniiJsonldAdapter.search(params, { signal });
  } catch (e) {
    result = { ok: false, source: 'cinii', error: e?.message || String(e) };
  }

  renderResults(result);
  renderResultsHeader(result, params);
  renderPagination(result, params);

  if (result.ok) {
    renderStatus('', '');
  } else {
    renderStatus(`検索に失敗しました。${result.error || ''}`, 'error');
  }
  return result;
}

// ---------- レンダリング ----------
function renderStatus(message, kind) {
  statusEl.textContent = message || '';
  statusEl.dataset.kind = kind || '';
}

function renderResultsHeader(result, params) {
  if (!result.ok) return;
  const start = Number(params.start) || 1;
  const count = Number(params.count) || 20;
  const div = document.createElement('div');
  div.className = 'results-header';
  div.textContent =
    `CiNii Research: ${result.total ?? 0} 件` +
    `（${start} 件目から最大 ${count} 件、合計 ${result.total ?? 0} 件）`;
  resultsHeader.replaceChildren(div);
}

function renderResults(result) {
  resultsEl.replaceChildren();
  const section = document.createElement('section');
  section.className = 'source-section';
  section.dataset.source = 'cinii';

  const h = document.createElement('h2');
  h.className = 'source-title';
  h.textContent = 'CiNii Research (JSON-LD)';
  section.appendChild(h);

  if (!result.ok) {
    const msg = document.createElement('p');
    msg.className = 'source-error';
    msg.textContent = result.error || '検索に失敗しました。';
    section.appendChild(msg);
    resultsEl.appendChild(section);
    return;
  }

  if (!result.items || result.items.length === 0) {
    const msg = document.createElement('p');
    msg.className = 'source-empty';
    msg.textContent = '該当する結果はありませんでした。';
    section.appendChild(msg);
    resultsEl.appendChild(section);
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'result-list';
  for (const item of result.items) {
    ul.appendChild(renderItem(item));
  }
  section.appendChild(ul);
  resultsEl.appendChild(section);
}

function renderItem(item) {
  const li = document.createElement('li');
  li.className = 'result-item';

  const titleEl = document.createElement('a');
  titleEl.className = 'result-title';
  titleEl.href = item.link || item.id || '#';
  titleEl.target = '_blank';
  titleEl.rel = 'noopener noreferrer';
  titleEl.textContent = item.title || '(タイトル不明)';
  li.appendChild(titleEl);

  const meta = document.createElement('div');
  meta.className = 'result-meta';
  const metaParts = [];
  if (item.resourceType) metaParts.push(item.resourceType);
  if (item.creators && item.creators.length > 0) {
    const names = item.creators.map((c) => c.name).filter(Boolean);
    if (names.length > 0) {
      metaParts.push(names.slice(0, 5).join(', ') + (names.length > 5 ? ' 他' : ''));
    }
  }
  if (item.publication?.name) metaParts.push(item.publication.name);
  if (item.year) metaParts.push(item.year);
  if (item.hasFullText) metaParts.push('本文あり');
  meta.textContent = metaParts.join(' / ');
  li.appendChild(meta);

  if (item.subjects && item.subjects.length > 0) {
    const subj = document.createElement('div');
    subj.className = 'result-subjects';
    subj.textContent = '件名: ' + item.subjects.map((s) => s.label).filter(Boolean).join(' / ');
    li.appendChild(subj);
  }

  if (item.identifiers && item.identifiers.length > 0) {
    const ids = document.createElement('div');
    ids.className = 'result-identifiers';
    ids.textContent = item.identifiers
      .map((id) => `${id.type}: ${id.value}`)
      .join(' / ');
    li.appendChild(ids);
  }

  if (item.description) {
    const desc = document.createElement('p');
    desc.className = 'result-desc';
    desc.textContent = item.description.length > 240
      ? item.description.slice(0, 240) + '…'
      : item.description;
    li.appendChild(desc);
  }

  return li;
}

function renderPagination(result, params) {
  paginationEl.replaceChildren();
  if (!result.ok) return;

  const start = Number(params.start) || 1;
  const count = Number(params.count) || 20;
  const maxTotal = result.total || 0;

  const prev = document.createElement('button');
  prev.type = 'button';
  prev.textContent = '← 前へ';
  prev.disabled = start <= 1;
  prev.addEventListener('click', () => {
    const next = Math.max(1, start - count);
    formEl('start').value = String(next);
    runSearch(getFormParams(form));
  });
  paginationEl.appendChild(prev);

  const info = document.createElement('span');
  info.className = 'page-info';
  info.textContent = `${start} 〜 ${start + count - 1} 件目`;
  paginationEl.appendChild(info);

  const next = document.createElement('button');
  next.type = 'button';
  next.textContent = '次へ →';
  next.disabled = start + count - 1 >= maxTotal;
  next.addEventListener('click', () => {
    const nextStart = start + count;
    formEl('start').value = String(nextStart);
    runSearch(getFormParams(form));
  });
  paginationEl.appendChild(next);
}

// ---------- WebMCP 検出と命令的 API ----------
function getRegistrationApi() {
  const mc = navigator?.modelContext;
  if (!mc) return null;
  if (typeof mc.registerTool === 'function') {
    return { kind: 'registerTool', mc };
  }
  if (typeof mc.provideContext === 'function') {
    return { kind: 'provideContext', mc };
  }
  return null;
}

function detectWebMCP() {
  const hasModelContext =
    typeof navigator !== 'undefined' && 'modelContext' in navigator;
  const reg = getRegistrationApi();
  const hasTesting =
    typeof navigator !== 'undefined' && 'modelContextTesting' in navigator;
  const supported = !!reg;

  if (mcpStatusEl) {
    mcpStatusEl.replaceChildren();
    mcpStatusEl.dataset.supported = supported ? 'true' : 'false';

    const main = document.createElement('span');
    main.textContent = supported
      ? `WebMCP: このブラウザで利用可能（${reg.kind}() で ${TOOL_NAME} を登録します）`
      : 'WebMCP: 未対応（フォーム検索は動作）';
    mcpStatusEl.appendChild(main);

    const detail = document.createElement('span');
    detail.className = 'mcp-detail';
    const hasRegister = !!(navigator.modelContext?.registerTool);
    const hasProvide = !!(navigator.modelContext?.provideContext);
    detail.textContent =
      ` [modelContext: ${hasModelContext ? 'yes' : 'no'}` +
      ` / registerTool: ${hasRegister ? 'yes' : 'no'}` +
      ` / provideContext: ${hasProvide ? 'yes' : 'no'}` +
      ` / modelContextTesting: ${hasTesting ? 'yes' : 'no'}]`;
    mcpStatusEl.appendChild(detail);

    if (!supported) {
      const hint = document.createElement('div');
      hint.className = 'mcp-hint';
      hint.innerHTML =
        'Chrome 146+ で <code>chrome://flags/#enable-webmcp-testing</code> ' +
        '（<b>WebMCP for testing</b>）を Enabled にして Relaunch、' +
        'その後このページを開き直してください。';
      mcpStatusEl.appendChild(hint);
    }
  }
  return supported;
}

// ---------- AI 向け戻り値（JSON-LD セマンティック整備版） ----------
// raw を除外し、@context を付加して返す。
// items[].raw は AI 戻り値には含めない（トークン浪費の防止）。
function stripRaw(item) {
  const { raw, ...rest } = item;
  return rest;
}

function summarizeForAgent(result, params) {
  if (!result.ok) {
    return {
      '@context': JSONLD_CONTEXT,
      source: 'cinii',
      ok: false,
      error: result.error,
      params,
    };
  }
  return {
    '@context': JSONLD_CONTEXT,
    source: 'cinii',
    resourceType: params.resourceType || 'all',
    query: { ...params },
    total: result.total,
    start: result.start,
    perPage: result.perPage,
    items: (result.items || []).map(stripRaw),
  };
}

function showDebug(args, agentReturn) {
  if (debugArgsEl) {
    debugArgsEl.textContent = JSON.stringify(args, null, 2);
  }
  if (debugReturnEl) {
    // 大きすぎる戻り値の表示は先頭3件 + メタに絞る
    const preview = agentReturn.ok === false
      ? agentReturn
      : {
          '@context': agentReturn['@context'],
          source: agentReturn.source,
          resourceType: agentReturn.resourceType,
          query: agentReturn.query,
          total: agentReturn.total,
          start: agentReturn.start,
          perPage: agentReturn.perPage,
          items: (agentReturn.items || []).slice(0, 3),
          _note: agentReturn.items && agentReturn.items.length > 3
            ? `（残り ${agentReturn.items.length - 3} 件を省略表示。AI には全件返しています）`
            : undefined,
        };
    debugReturnEl.textContent = JSON.stringify(preview, null, 2);
  }
}

function buildTool() {
  const description =
    'CiNii Research OpenSearch v2 で論文・書籍・研究データ等を検索する。' +
    'レスポンスは JSON-LD として解釈され、戻り値には @context, ' +
    '著者, 件名, 同定子（DOI/URI）, 刊行物メタを構造化して含む。' +
    'ページ内の検索フォームと同じパラメータを受け付ける。';

  const inputSchema = {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'フリーワード（タイトル・本文・著者などを横断）' },
      title: { type: 'string', description: 'タイトルに含まれる語' },
      publicationTitle: { type: 'string', description: '刊行物（雑誌名・書籍名）に含まれる語' },
      name: { type: 'string', description: '著者・編者などの人物名' },
      affiliation: { type: 'string', description: '著者の所属機関名' },
      description: { type: 'string', description: '注記・抄録（abstract）に含まれる語' },
      productYearFrom: { type: 'string', description: '出版年（開始）。YYYY または YYYYMM' },
      productYearUntil: { type: 'string', description: '出版年（終了）。YYYY または YYYYMM' },
      hasLinkToFullText: {
        type: 'string',
        enum: ['', 'true', 'false'],
        description: '本文ありで絞る場合 "true"、本文なしのみなら "false"、未指定なら空',
      },
      languageType: {
        type: 'string',
        description:
          '資料の言語種別。ISO-639-1 コード（例: ja=日本語, en=英語, zh=中国語, ko=韓国語, fr=仏語, de=独語, es=西語）。複数指定はカンマ区切りで OR。例: "ja,en"。researchers 検索では非対応。',
      },
      resourceType: {
        type: 'string',
        enum: ciniiJsonldAdapter.resourceTypes,
        description: 'CiNii の検索種別。all=横断, articles=論文, books=書籍, data=研究データ, dissertations=博士論文, projects=研究プロジェクト, researchers=研究者',
      },
      sortorder: {
        type: 'string',
        enum: ['0', '1', '4', '5'],
        description: 'ソート順。0=新しい順, 1=古い順, 4=関連度（既定）, 5=五十音順',
      },
      count: { type: 'string', description: '1ページの件数（1〜200）' },
      start: { type: 'string', description: '開始位置（1始まり）' },
    },
    required: [],
  };

  return {
    name: TOOL_NAME,
    description,
    inputSchema,
    async execute(args) {
      const params = normalizeArgs(args);
      fillForm(params);
      const result = await runSearch(params);
      const agentReturn = summarizeForAgent(result, params);
      showDebug(args, agentReturn);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(agentReturn, null, 2),
          },
        ],
      };
    },
  };
}

function registerWebMCPTool() {
  const reg = getRegistrationApi();
  if (!reg) return;

  const tool = buildTool();

  if (reg.kind === 'registerTool') {
    // 同名ツールが残っているケース（前回ページ遷移・他タブ）に備え、まず解除を試みる
    if (typeof reg.mc.unregisterTool === 'function') {
      try { reg.mc.unregisterTool(tool.name); } catch (_) { /* 未登録なら無視 */ }
    }
    try {
      reg.mc.registerTool(tool);
    } catch (e) {
      if (e && e.name === 'InvalidStateError' &&
          /Duplicate tool name/i.test(e.message || '')) {
        // 既に同名ツールが登録済み。index.html を別タブで開いている等。
        // 解除不能のためフォーム検索のみ動作する状態として継続。
        console.warn(`${tool.name} は既に登録済みです。今回の登録はスキップします:`, e.message);
      } else {
        throw e;
      }
    }
  } else if (reg.kind === 'provideContext') {
    // 旧仕様の後方互換
    reg.mc.provideContext({ tools: [tool] });
  }
}

// ---------- appid 設定 UI ----------
function wireAppIdSettings() {
  const input = $('#appidInput');
  const saveBtn = $('#appidSave');
  const clearBtn = $('#appidClear');
  if (!input || !saveBtn) return;

  try {
    input.value = localStorage.getItem('cinii.appid') || '';
  } catch { /* localStorage 不可 */ }

  saveBtn.addEventListener('click', () => {
    try {
      const v = input.value.trim();
      if (v === '') {
        localStorage.removeItem('cinii.appid');
      } else {
        localStorage.setItem('cinii.appid', v);
      }
      renderStatus('appid を保存しました。', 'info');
    } catch (e) {
      renderStatus(`appid 保存に失敗: ${e.message}`, 'error');
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      try {
        localStorage.removeItem('cinii.appid');
        input.value = '';
        renderStatus('appid を削除しました。', 'info');
      } catch (e) {
        renderStatus(`appid 削除に失敗: ${e.message}`, 'error');
      }
    });
  }
}

// ---------- 起動 ----------
function init() {
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    runSearch(getFormParams(form));
  });

  const resetStart = $('#resetStart');
  if (resetStart) {
    resetStart.addEventListener('click', () => {
      formEl('start').value = '1';
      runSearch(getFormParams(form));
    });
  }

  wireAppIdSettings();
  detectWebMCP();
  try {
    registerWebMCPTool();
  } catch (e) {
    console.warn('WebMCP ツール登録に失敗:', e);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
