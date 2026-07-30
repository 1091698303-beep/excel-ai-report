// Cloudflare Worker - excel-ai-report 后端
// /ftshare  : 转发到 FTShare HTTP API(https://market.ft.tech/gateway/),无认证
//             按前端 dataTypes(quote/financial/kline)调对应接口,自动转换股票代码格式
// 注意: FTShare 偶发返回空 body; 必须把空/非 JSON 收成 error, 避免前端只剩 raw 列

const FTSHARE_BASE = 'https://market.ft.tech/gateway/';

// 6 位代码 -> 带交易所后缀的 symbol(600519 -> 600519.SH, 000001 -> 000001.SZ)
function toSymbol(code) {
  code = String(code || '').trim().toUpperCase();
  if (code.includes('.')) return code;
  if (/^(688|6|9)/.test(code)) return code + '.SH';
  if (/^(0|2|3)/.test(code)) return code + '.SZ';
  if (/^8/.test(code)) return code + '.BJ';
  return code + '.SH';
}

// 调 FTShare HTTP API(空 body / 非 JSON 会重试,最终给 error)
async function ftFetch(path, params, method = 'GET', retries = 2) {
  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const url = new URL(FTSHARE_BASE + path);
      const opts = {
        method,
        headers: {
          'User-Agent': 'excel-ai-report-worker/1.0',
          Accept: 'application/json',
        },
      };
      if (method === 'POST') {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(params || {});
      } else {
        for (const [k, v] of Object.entries(params || {})) {
          if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
        }
      }
      const r = await fetch(url, opts);
      const text = await r.text();
      if (!text || !String(text).trim()) {
        lastErr = new Error(`FTShare 空响应 HTTP ${r.status} (${path})`);
        continue;
      }
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        // 可能是 HTML/纯文本错误页
        lastErr = new Error(`FTShare 非 JSON HTTP ${r.status}: ${String(text).slice(0, 120)}`);
        continue;
      }
      if (!r.ok) {
        lastErr = new Error(`FTShare HTTP ${r.status}: ${JSON.stringify(json).slice(0, 160)}`);
        continue;
      }
      return json;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('FTShare 请求失败');
}

// 从 FTShare 响应提取表格行(data.records / data.items / items / 顶层数组)
// 绝不把 {raw:""} 当有效行返回
function extractRows(payload) {
  if (payload == null) return [];
  if (Array.isArray(payload)) return payload.filter((x) => x != null);

  // 旧逻辑里 JSON 解析失败会落成 { raw: "..." }, 这不是业务行
  if (typeof payload === 'object' && Object.keys(payload).length === 1 && 'raw' in payload) {
    const raw = payload.raw;
    if (typeof raw === 'string' && raw.trim()) {
      try {
        return extractRows(JSON.parse(raw));
      } catch {
        return [];
      }
    }
    return [];
  }

  if (payload.data != null) {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.data.records)) return payload.data.records;
    if (Array.isArray(payload.data.items)) return payload.data.items;
    // data 是单对象(非 error)
    if (typeof payload.data === 'object' && !payload.data.error) {
      // 再挖一层常见包装
      if (Array.isArray(payload.data.list)) return payload.data.list;
      if (Array.isArray(payload.data.rows)) return payload.data.rows;
    }
  }
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.items)) return payload.items;
  if (Array.isArray(payload.list)) return payload.list;
  if (Array.isArray(payload.rows)) return payload.rows;

  // 单对象: 有业务字段才当一行, 纯 error/raw 不当有效行
  if (typeof payload === 'object') {
    if (payload.error) return [];
    const keys = Object.keys(payload).filter((k) => k !== 'raw' && k !== 'success' && k !== 'code' && k !== 'msg' && k !== 'message');
    if (keys.length) return [payload];
  }
  return [];
}

// quote 分时可能很长, 只保留最近 N 条, 避免 Worker/前端撑爆
function capRows(rows, max) {
  if (!Array.isArray(rows)) return rows;
  if (rows.length <= max) return rows;
  return rows.slice(-max);
}

async function fetchQuote(symbol) {
  // 优先分时历史; 空则回退日 K 最近 30 根当行情
  try {
    const rows = extractRows(await ftFetch('api/v1/market/data/daec/history/prices', { symbol }));
    if (rows.length) return capRows(rows, 300);
  } catch (e) {
    /* fallback below */
  }
  const krows = extractRows(
    await ftFetch(
      'api/v1/market/data/stock-candlesticks',
      {
        symbol,
        interval_unit: 'Day',
        interval_value: 1,
        adjust_kind: 'Forward',
        until_ts_millis: Date.now(),
        limit: 30,
      },
      'POST'
    )
  );
  if (!krows.length) throw new Error('quote 无数据(分时与日K皆空)');
  return krows;
}

async function fetchFinancial(symbol) {
  // 不强制 year: 让接口返回近期报表; page_size 放大一点
  const rows = extractRows(
    await ftFetch('api/v1/market/data/finance/income', {
      stock_code: symbol,
      page: 1,
      page_size: 20,
    })
  );
  if (!rows.length) {
    // 兼容某些环境必须带 year
    const y = new Date().getFullYear();
    for (const year of [y, y - 1, y - 2]) {
      const r2 = extractRows(
        await ftFetch('api/v1/market/data/finance/income', {
          stock_code: symbol,
          year,
          page: 1,
          page_size: 20,
        })
      );
      if (r2.length) return r2;
    }
    throw new Error('financial 无数据');
  }
  return rows;
}

async function fetchKline(symbol) {
  const rows = extractRows(
    await ftFetch(
      'api/v1/market/data/stock-candlesticks',
      {
        symbol,
        interval_unit: 'Day',
        interval_value: 1,
        adjust_kind: 'Forward',
        until_ts_millis: Date.now(),
        limit: 120,
      },
      'POST'
    )
  );
  if (!rows.length) throw new Error('kline 无数据');
  return rows;
}

// 处理 /ftshare 请求
async function handleFtshare(body) {
  const stockCodes = String(body?.stockCodes || body?.stock_codes || '');
  const codes = stockCodes.split(',').map((s) => s.trim()).filter(Boolean);
  const types = body?.dataTypes && body.dataTypes.length ? body.dataTypes : ['quote', 'financial', 'kline'];
  if (!codes.length) return { success: false, error: 'stockCodes 为空' };

  const stocks = [];
  for (const code of codes) {
    const symbol = toSymbol(code);
    const entry = { code, symbol, data: {} };

    if (types.includes('quote')) {
      try {
        entry.data.quote = await fetchQuote(symbol);
      } catch (e) {
        entry.data.quote = { error: e.message || String(e) };
      }
    }
    if (types.includes('financial')) {
      try {
        entry.data.financial = await fetchFinancial(symbol);
      } catch (e) {
        entry.data.financial = { error: e.message || String(e) };
      }
    }
    if (types.includes('kline')) {
      try {
        entry.data.kline = await fetchKline(symbol);
      } catch (e) {
        entry.data.kline = { error: e.message || String(e) };
      }
    }
    stocks.push(entry);
  }
  return { success: true, data: { stocks } };
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    let body = {};
    try {
      body = await request.json();
    } catch {
      /* 空 body */
    }

    try {
      if (url.pathname === '/ftshare') {
        const result = await handleFtshare(body);
        return new Response(JSON.stringify(result), {
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
        });
      }
      return new Response(JSON.stringify({ error: '未知路径: ' + url.pathname }), {
        status: 404,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders() },
      });
    }
  },
};
