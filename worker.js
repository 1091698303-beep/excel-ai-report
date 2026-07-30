// Cloudflare Worker - excel-ai-report 后端
// /ftshare  : 转发到 FTShare HTTP API(https://market.ft.tech/gateway/),无认证
//             按前端 dataTypes(quote/financial/kline)调对应接口,自动转换股票代码格式
// /chat     : 兼容旧版 GLM 直连(占位,前端 AI 报告已改走本地 proxy.py,这里保留备用)

const FTSHARE_BASE = 'https://market.ft.tech/gateway/';

// 6 位代码 -> 带交易所后缀的 symbol(600519 -> 600519.SH, 000001 -> 000001.SZ)
function toSymbol(code) {
  code = String(code || '').trim().toUpperCase();
  if (code.includes('.')) return code; // 已带后缀
  if (/^(688|6|9)/.test(code)) return code + '.SH'; // 沪市
  if (/^(0|2|3)/.test(code)) return code + '.SZ'; // 深市
  if (/^8/.test(code)) return code + '.BJ'; // 北交所
  return code + '.SH'; // 默认沪市
}

// 调 FTShare HTTP API
async function ftFetch(path, params, method = 'GET') {
  const url = new URL(FTSHARE_BASE + path);
  const opts = { method, headers: { 'User-Agent': 'excel-ai-report-worker/1.0' } };
  if (method === 'POST') {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(params || {});
  } else {
    for (const [k, v] of Object.entries(params || {})) {
      if (v !== undefined && v !== null) url.searchParams.set(k, v);
    }
  }
  const r = await fetch(url, opts);
  const text = await r.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return json;
}

// 从 FTShare 响应提取表格行(data.records / data.items / items / 顶层数组)
function extractRows(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (payload.data) {
    if (Array.isArray(payload.data)) return payload.data;
    if (Array.isArray(payload.data.records)) return payload.data.records;
    if (Array.isArray(payload.data.items)) return payload.data.items;
  }
  if (Array.isArray(payload.records)) return payload.records;
  if (Array.isArray(payload.items)) return payload.items;
  return payload;
}

// 处理 /ftshare 请求
async function handleFtshare(body) {
  const stockCodes = String(body?.stockCodes || body?.stock_codes || '');
  const codes = stockCodes.split(',').map(s => s.trim()).filter(Boolean);
  const types = (body?.dataTypes && body.dataTypes.length)
    ? body.dataTypes
    : ['quote', 'financial', 'kline'];
  if (!codes.length) return { success: false, error: 'stockCodes 为空' };

  const stocks = [];
  for (const code of codes) {
    const symbol = toSymbol(code);
    const entry = { code, symbol, data: {} };

    if (types.includes('quote')) {
      try {
        entry.data.quote = extractRows(
          await ftFetch('api/v1/market/data/daec/history/prices', { symbol })
        );
      } catch (e) { entry.data.quote = { error: e.message }; }
    }
    if (types.includes('financial')) {
      try {
        entry.data.financial = extractRows(
          await ftFetch('api/v1/market/data/finance/income', { stock_code: symbol, year: 2024, page: 1, page_size: 5 })
        );
      } catch (e) { entry.data.financial = { error: e.message }; }
    }
    if (types.includes('kline')) {
      try {
        entry.data.kline = extractRows(
          await ftFetch('api/v1/market/data/stock-candlesticks', {
            symbol, interval_unit: 'Day', interval_value: 1, adjust_kind: 'Forward', until_ts_millis: Date.now(), limit: 120
          }, 'POST')
        );
      } catch (e) { entry.data.kline = { error: e.message }; }
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
    try { body = await request.json(); } catch { /* 空 body */ }

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
  }
};
