// 电商售后客服插件：知识库 + 业务工具
// 零依赖 ESM 模块，由预设 agent.cordis.yml 按相对路径 `./aftersales.mjs` 加载。
// 只消费 host 的 `tools` 注册表，不发布任何服务，因此无需 isolate realm。
export const name = 'aftersales-tools'
export const inject = ['tools']

export function apply(ctx) {
  // ── 知识库（内存态，上传即时可检索；生产可换成存储后端 + 向量检索） ──
  let docs = []

  function tokenize(text) {
    const t = String(text || '').toLowerCase()
    const out = new Set()
    const words = t.match(/[a-z0-9]+/g)
    if (words) {
      for (let i = 0; i < words.length; i++) if (words[i].length >= 2) out.add(words[i])
    }
    let cjk = ''
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i)
      if (c >= 0x4e00 && c <= 0x9fff) cjk += t.charAt(i)
    }
    if (cjk.length >= 2) {
      for (let i = 0; i < cjk.length - 1; i++) out.add(cjk.slice(i, i + 2))
    } else {
      for (let i = 0; i < cjk.length; i++) out.add(cjk.charAt(i))
    }
    return Array.from(out)
  }

  function chunkText(content) {
    const maxLen = 512
    const text = String(content || '').trim()
    if (!text) return []
    const paras = text.split('\n').map(function (p) { return p.trim() }).filter(Boolean)
    const chunks = []
    let buf = ''
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i]
      if (buf && (buf.length + p.length) > maxLen) { chunks.push(buf); buf = '' }
      if (p.length > maxLen) {
        let rest = p
        while (rest.length > maxLen) {
          const cut = rest.slice(0, maxLen)
          const sp = cut.lastIndexOf('。')
          const idx = sp > maxLen * 0.5 ? sp + 1 : maxLen
          chunks.push(rest.slice(0, idx))
          rest = rest.slice(idx)
        }
        if (rest) chunks.push(rest)
      } else {
        buf = buf ? buf + '\n' + p : p
      }
    }
    if (buf) chunks.push(buf)
    return chunks
  }

  function newId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
  }

  function seed() {
    const items = [
      ['7天无理由退货政策', ['退货', '时效'], '自签收之日起 7 日内，商品保持完好且不影响二次销售的，可申请无理由退货；定制类、鲜活易腐类、贴身用品等特殊商品除外。'],
      ['质量问题换货流程', ['换货', '质量'], '商品存在质量问题的，自签收之日起 15 日内可申请换货；需上传凭证照片，审核通过后商家承担来回运费。'],
      ['退款时效说明', ['退款', '时效'], '退款审核通过后，原路退回一般 1-3 个工作日到账；使用银行卡支付的最长不超过 7 个工作日。'],
      ['运费承担规则', ['运费', '退货'], '无理由退货时，退回运费由买家承担；质量问题或商家原因导致的退货，运费由商家承担。'],
      ['发票开具政策', ['发票'], '支持开具电子发票，下单时勾选或在订单详情申请；发票内容为商品明细，不支持修改抬头类型。'],
      ['售后联系方式', ['联系', '客服'], '人工客服热线 400-000-0000，服务时间 9:00-21:00；重大客诉请直接联系人工客服处理。']
    ]
    return items.map(function (item) {
      return {
        id: newId('kb'),
        title: item[0],
        tags: item[1],
        createdAt: Date.now(),
        chunks: chunkText(item[2]).map(function (t) { return { text: t, tokens: tokenize(t) } })
      }
    })
  }

  docs = seed()

  function asText(value) {
    return [{ type: 'text', text: value }]
  }

  // ── 知识库工具 ──
  ctx.tools.register({
    name: 'kb_upload',
    description: '上传一条知识到售后知识库：给定标题、正文和可选标签（逗号分隔），自动分块建索引。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '知识标题，用于来源溯源' },
        content: { type: 'string', description: '知识正文' },
        tags: { type: 'string', description: '可选，逗号分隔的标签，如 退货,时效' }
      },
      required: ['title', 'content']
    },
    output: { schema: { type: 'string' }, render: function (_a, v) { return asText(v) } },
    execute: async function (args) {
      const title = String(args.title || '').trim()
      const content = String(args.content || '').trim()
      if (!title || !content) return '上传失败：标题和正文不能为空。'
      const tags = String(args.tags || '').split(/[,，]/).map(function (s) { return s.trim() }).filter(Boolean)
      const chunks = chunkText(content).map(function (t) { return { text: t, tokens: tokenize(t) } })
      if (!chunks.length) return '上传失败：正文分块后为空。'
      docs.push({ id: newId('kb'), title: title, tags: tags, chunks: chunks, createdAt: Date.now() })
      return '已上传知识《' + title + '》，共 ' + chunks.length + ' 个分块' + (tags.length ? '，标签：' + tags.join('、') : '') + '。'
    }
  })

  ctx.tools.register({
    name: 'kb_search',
    description: '检索售后知识库，返回与问题最相关的政策片段及来源（关键词打分，可按标签过滤）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '检索问题或关键词' },
        top_k: { type: 'number', description: '返回片段数，默认 5，上限 10' },
        tag: { type: 'string', description: '可选，按标签过滤，如 退货' }
      },
      required: ['query']
    },
    output: { schema: { type: 'string' }, render: function (_a, v) { return asText(v) } },
    execute: async function (args) {
      if (!docs.length) return '知识库为空：暂无可检索的政策，请先上传知识。'
      const q = String(args.query || '').trim()
      if (!q) return '检索失败：query 不能为空。'
      const qTokens = tokenize(q)
      if (!qTokens.length) return '检索失败：query 未能提取有效关键词。'
      const tagFilter = String(args.tag || '').trim()
      const topK = Math.min(Math.max(Number(args.top_k) || 5, 1), 10)
      const results = []
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i]
        if (tagFilter && (doc.tags || []).indexOf(tagFilter) < 0) continue
        for (let j = 0; j < doc.chunks.length; j++) {
          const chunk = doc.chunks[j]
          const cSet = new Set(chunk.tokens)
          let inter = 0
          for (let k = 0; k < qTokens.length; k++) if (cSet.has(qTokens[k])) inter++
          const score = inter / qTokens.length
          if (score > 0) results.push({ score: score, source: doc.title, snippet: chunk.text })
        }
      }
      results.sort(function (a, b) { return b.score - a.score })
      const top = results.slice(0, topK)
      if (!top.length) return '未检索到相关售后政策（无命中）' + (tagFilter ? '（标签：' + tagFilter + '）' : '') + '，建议核实关键词或转人工处理，切勿编造政策。'
      const lines = []
      for (let i = 0; i < top.length; i++) lines.push((i + 1) + '. [' + top[i].score.toFixed(2) + '] 《' + top[i].source + '》 ' + top[i].snippet)
      return lines.join('\n')
    }
  })

  ctx.tools.register({
    name: 'kb_list',
    description: '列出知识库中的全部知识条目（标题、标签、分块数）。',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'string' }, render: function (_a, v) { return asText(v) } },
    execute: async function () {
      if (!docs.length) return '知识库为空。'
      const lines = []
      for (let i = 0; i < docs.length; i++) lines.push(docs[i].id + '｜《' + docs[i].title + '》 标签[' + (docs[i].tags || []).join('、') + '] ' + docs[i].chunks.length + ' 个分块')
      return lines.join('\n')
    }
  })

  ctx.tools.register({
    name: 'kb_delete',
    description: '按 id 删除一条知识（用 kb_list 查看 id）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '知识条目 id' } },
      required: ['id']
    },
    output: { schema: { type: 'string' }, render: function (_a, v) { return asText(v) } },
    execute: async function (args) {
      const id = String(args.id || '').trim()
      if (!id) return '删除失败：请提供知识 id。'
      const before = docs.length
      docs = docs.filter(function (d) { return d.id !== id })
      if (docs.length === before) return '未找到 id 为 ' + id + ' 的知识条目。'
      return '已删除知识条目 ' + id + '，当前知识库共 ' + docs.length + ' 条。'
    }
  })

  // ── 业务工具（内置模拟订单/退款/物流数据） ──
  const orders = [
    { order_id: 'SO20260601001', status: '已签收', product: '蓝牙耳机 Pro', amount: 199, order_date: '2026-06-01', user_phone: '13800000001' },
    { order_id: 'SO20260605002', status: '运输中', product: '智能手环', amount: 299, order_date: '2026-06-05', user_phone: '13800000002' },
    { order_id: 'SO20260520003', status: '已签收', product: '无线充电器', amount: 99, order_date: '2026-05-20', user_phone: '13800000001' }
  ]
  const refunds = [
    { refund_id: 'RF20260612001', order_id: 'SO20260601001', status: '退款处理中', reason: '质量问题', amount: 199, progress: '已通过审核，等待原路退回（预计 1-3 个工作日到账）' },
    { refund_id: 'RF20260610002', order_id: 'SO20260520003', status: '已退款', reason: '7天无理由', amount: 99, progress: '已原路退回，请留意到账' }
  ]
  const shipments = [
    { order_id: 'SO20260605002', carrier: '顺丰速运', tracking_no: 'SF1234567890', status: '运输中', events: [{ time: '2026-06-06 10:00', location: '广州分拨中心', description: '快件已发出' }, { time: '2026-06-07 08:30', location: '上海转运中心', description: '已到达转运中心' }] },
    { order_id: 'SO20260601001', carrier: '中通快递', tracking_no: 'ZT9876543210', status: '已签收', events: [{ time: '2026-06-03 09:12', location: '买家签收', description: '已签收，感谢惠顾' }] }
  ]
  const tickets = []

  ctx.tools.register({
    name: 'order_lookup',
    description: '按订单号或手机号查询订单状态（模拟订单系统）。',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: '订单号' },
        user_phone: { type: 'string', description: '下单手机号' }
      }
    },
    output: { schema: { type: 'string' }, render: function (_a, v) { return asText(v) } },
    execute: async function (args) {
      const id = String(args.order_id || '').trim()
      const phone = String(args.user_phone || '').trim()
      if (!id && !phone) return '查询失败：请提供订单号或手机号。'
      const hits = orders.filter(function (o) { return (id && o.order_id === id) || (phone && o.user_phone === phone) })
      if (!hits.length) return '未查询到订单（ORDER_NOT_FOUND），请核实订单号或手机号。'
      const lines = []
      for (let i = 0; i < hits.length; i++) lines.push('订单 ' + hits[i].order_id + '｜商品：' + hits[i].product + '｜状态：' + hits[i].status + '｜金额：¥' + hits[i].amount + '｜下单日期：' + hits[i].order_date)
      return lines.join('\n')
    }
  })

  ctx.tools.register({
    name: 'refund_status',
    description: '按退款单号或订单号查询退款进度（模拟退款系统）。',
    parameters: {
      type: 'object',
      properties: {
        refund_id: { type: 'string', description: '退款单号' },
        order_id: { type: 'string', description: '关联订单号' }
      }
    },
    output: { schema: { type: 'string' }, render: function (_a, v) { return asText(v) } },
    execute: async function (args) {
      const rid = String(args.refund_id || '').trim()
      const oid = String(args.order_id || '').trim()
      if (!rid && !oid) return '查询失败：请提供退款单号或订单号。'
      const hits = refunds.filter(function (r) { return (rid && r.refund_id === rid) || (oid && r.order_id === oid) })
      if (!hits.length) return '未查询到退款单（REFUND_NOT_FOUND），请核实单号。'
      const lines = []
      for (let i = 0; i < hits.length; i++) lines.push('退款单 ' + hits[i].refund_id + '｜关联订单 ' + hits[i].order_id + '｜状态：' + hits[i].status + '｜原因：' + hits[i].reason + '｜进度：' + hits[i].progress)
      return lines.join('\n')
    }
  })

  ctx.tools.register({
    name: 'shipping_query',
    description: '按订单号查询物流轨迹（模拟物流系统）。',
    parameters: {
      type: 'object',
      properties: { order_id: { type: 'string', description: '订单号' } },
      required: ['order_id']
    },
    output: { schema: { type: 'string' }, render: function (_a, v) { return asText(v) } },
    execute: async function (args) {
      const oid = String(args.order_id || '').trim()
      if (!oid) return '查询失败：请提供订单号。'
      let s = null
      for (let i = 0; i < shipments.length; i++) if (shipments[i].order_id === oid) { s = shipments[i]; break }
      if (!s) return '未查询到物流信息（SHIPPING_NOT_FOUND），请核实订单号。'
      const lines = ['订单 ' + s.order_id + '｜承运商：' + s.carrier + '｜运单号：' + s.tracking_no + '｜状态：' + s.status]
      for (let i = 0; i < s.events.length; i++) lines.push('· ' + s.events[i].time + ' ' + s.events[i].location + '：' + s.events[i].description)
      return lines.join('\n')
    }
  })

  ctx.tools.register({
    name: 'complaint_escalate',
    description: '生成投诉工单并升级到人工处理（模拟工单系统）。',
    parameters: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: '关联订单号' },
        reason: { type: 'string', description: '投诉原因' },
        severity: { type: 'string', description: '严重程度 low/high，默认 low' }
      },
      required: ['order_id', 'reason']
    },
    output: { schema: { type: 'string' }, render: function (_a, v) { return asText(v) } },
    execute: async function (args) {
      const oid = String(args.order_id || '').trim()
      const reason = String(args.reason || '').trim()
      if (!oid || !reason) return '生成工单失败：请提供订单号和投诉原因。'
      const sev = String(args.severity || '').trim() === 'high' ? 'high' : 'low'
      const ticket = { ticket_id: 'TK' + Date.now(), order_id: oid, status: 'created', reason: reason, severity: sev, assignee: sev === 'high' ? '售后紧急组' : '售后一组', created_at: Date.now() }
      tickets.push(ticket)
      return '已生成投诉工单 ' + ticket.ticket_id + '｜订单 ' + oid + '｜严重程度：' + sev + '｜处理人：' + ticket.assignee + '，请保持电话畅通。'
    }
  })
}
