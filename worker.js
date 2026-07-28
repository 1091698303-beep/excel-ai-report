// Cloudflare Worker - AI 报告生成后端
// 你需要把下面的 API_KEY 替换成你的 GLM-5.2 API Key

const API_KEY = '你的_GLM_5.2_API_Key';  // ← 改成你的真实 Key
const API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';  // GLM API 地址，根据实际调整

export default {
  async fetch(request, env, ctx) {
    // 处理 CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    try {
      const body = await request.json();
      const prompt = body.prompt || '请生成一份数据分析报告';

      const response = await fetch(API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${API_KEY}`
        },
        body: JSON.stringify({
          model: 'glm-5.2',  // 根据实际模型名称调整
          messages: [
            { role: 'system', content: '你是一位专业的数据分析师，擅长从数据中发现洞察并生成结构化报告。' },
            { role: 'user', content: prompt }
          ],
          temperature: 0.7,
          max_tokens: 4000
        })
      });

      const data = await response.json();
      
      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        }
      });
    }
  }
};
