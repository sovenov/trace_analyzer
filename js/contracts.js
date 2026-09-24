/* ====================== contracts ======================
   Every call one service made to another, in the order they happened, with what went
   over the wire as far as the logs show it. Each hop is logged in its own dialect —
   langflow's integration log (fields path/body/response_body), its older access log
   (python dicts inline), comod-adapter's COMOD envelopes, strategy's protobuf text,
   java toString()s, the MCP servers' TOOL lines — so every dialect gets a small
   extractor, and all of them produce the same shape:
     {ts, end, kind, from, to, title, method, endpoint, status, ms, src,
      req: {headers, body, fmt, note, rebuilt}, resp: {…}}
   fmt says how to read body: json · py (python repr) · proto (protobuf text) ·
   tostring (java record toString) · text. A hop whose body nobody logged is still a hop:
   it stays in the chain with a note saying so, because "A called B here" is half of
   what a contract is. Computed lazily, when the report for the trace is opened. */
const CONTRACT_KINDS = {
  channel: 'Канал',
  flow: 'Оркестрация',
  llm: 'LLM',
  mcp: 'MCP',
  rag: 'RAG',
  llmgw: 'Шлюз LLM',
  auth: 'Авторизация'
};
const CONTRACT_HIDDEN = {llmgw: true, auth: true};

const uuidIn = s => { const m = UUID_RE.exec(String(s || '')); return m ? m[0].toLowerCase() : null; };
function rawPrefixed(raw, prefix){
  const out = {};
  let n = 0;
  Object.keys(raw || {}).forEach(k => {
    if(k.lastIndexOf(prefix, 0) !== 0) return;
    const v = raw[k];
    out[k.slice(prefix.length)] = Array.isArray(v) ? v.join(', ') : v;
    n++;
  });
  return n ? out : null;
}
/* "{host=[a], accept=[b, c]}" — a java Map of header lists as Spring prints it */
function javaHeaders(s){
  if(!s) return null;
  const out = {};
  let m, n = 0;
  const re = /([\w\-]+)=\[([^\]]*)\]/g;
  while((m = re.exec(s))){ out[m[1]] = m[2]; n++; }
  return n ? out : null;
}
/* the call's messageId as a pairing key; log masking sometimes eats part of the uuid,
   but both lines of one call are masked the same way, so the literal text still pairs them */
function msgIdKey(m){
  const x = /messageId=([^\]\s,]+)/.exec(m);
  if(x) return uuidIn(x[1]) || x[1];
  return uuidIn(m);
}
function afterMarker(msg, marker){
  const i = msg.indexOf(marker);
  return i < 0 ? null : msg.slice(i + marker.length).trim();
}

function extractContracts(recs){
  const C = [];
  const add = o => {
    o.req = o.req || {};
    o.resp = o.resp || null;
    C.push(o);
    return o;
  };
  const js = s => ({body: s, fmt: 'json'});
  const usesGateway = recs.some(r => /\|\s*server=mcp_gateway|java-gateway\/gateway\/mcp/i.test(r.msg) ||
                                     (r.raw && /\/gateway\/mcp/i.test(String(r.raw.url || r.raw.path || ''))));

  // the model's answers by the gateway messageId, to pair langflow's [ASK LLM] halves
  const answerByKey = new Map();
  recs.forEach(r => {
    if(r.msg.lastIndexOf('Answer is ready with messageId=', 0) === 0 || r.msg.indexOf('Rest response from LLM:') >= 0){
      const t = r.msg.indexOf('Rest response') >= 0 ? extractRestLlm(r.msg) : extractLlmTurn(r.msg);
      if(t && t.messageId && t.content) answerByKey.set(turnKey(t.content), String(t.messageId).toLowerCase());
    }
  });

  // first sighting of each langflow span, to date a response whose request line is missing
  const spanFirst = new Map();
  recs.forEach(r => { const sp = r.raw && r.raw.span_id; if(sp && r.app === 'alfagen-langflow' && !spanFirst.has(sp)) spanFirst.set(sp, r.ts); });
  const toolByReq = new Map();
  recs.forEach(r => { if(r.raw && r.raw.tool && r.raw.requestId && /mcp-server/.test(r.app)) toolByReq.set(r.raw.requestId, r.raw.tool); });

  const pend = {access: [], ask: [], mcp: [], lfint: new Map(), strat: new Map(), llmint: new Map(),
                safety: [], gw: new Map(), payload: [], init: new Map(), restOrphan: new Map()};
  const integ = [];          // langflow integration-log hops, for de-duplicating the rest
  let lastCaddyInbound = null;

  recs.forEach(r => {
    const m = r.msg, app = r.app, raw = r.raw || {};

    // ---------- langflow integration log: "[Target] Request|Response" + structured fields
    let im;
    if(app === 'alfagen-langflow' && (im = /^\[([^\]]+)\] (Request|Response)$/.exec(m)) &&
       (raw.path || raw.url || raw.body != null || raw.response_body != null || raw.status_code != null)){
      const target = im[1];
      if(target === 'MCP' && /\//.test(raw.operation || '')) return;     // tools/list and the other handshakes
      // span_id is unique per outgoing call; responses drop `path`, so it cannot be part of the key
      const sp = raw.span_id || raw.spanId || '';
      const key = target + '|' + (sp || (raw.message_id || raw.operation || raw.event_type || ''));
      if(im[2] === 'Request'){
        const h = rawPrefixed(raw, 'headers.');
        const o = {ts: r.ts, kind: 'flow', from: 'alfagen-langflow', to: target, method: raw.method || 'POST',
                   endpoint: raw.url || raw.path || '', src: 'alfagen-langflow · ' + target,
                   req: {headers: h, body: raw.body != null ? String(raw.body) : null, fmt: 'json'}};
        if(target === 'ACCESS'){
          o.from = h && (h.prev_agent || h.conversation_session_id) ? 'aiagentscn-agent-orchestrator' :
                   h && /ReactorNetty/i.test(h['user-agent'] || '') ? 'alfagen-strategy-api' : 'клиент';
          o.to = 'alfagen-langflow';
          o.title = /\/run\//.test(o.endpoint) ? 'запуск флоу' : 'входящий запрос';
        } else if(target === 'AlfaGen API'){
          o.kind = 'llm'; o.to = 'alfagen-gateway-api (LLM)';
          o.title = 'вызов модели' + (raw.model ? ' ' + raw.model : '');
          o.llmId = (raw.message_id || (h && h.messageid) || '').toLowerCase();
        } else if(target === 'MCP'){
          o.kind = 'mcp'; o.to = usesGateway || /\/gateway\/mcp/i.test(raw.url || raw.path || '') ? 'mcp-gateway' : 'MCP-сервер';
          o.title = 'tools/call ' + (raw.operation || '');
          o.tool = raw.operation || '';
        } else if(target === 'Comod Webhook'){
          o.to = 'aiagentscn-queue-keeper'; o.title = 'callback ' + (raw.event_type || '');
          o.event = raw.event_type || '';
        } else if(target === 'Keycloak'){
          o.kind = 'auth'; o.to = 'Keycloak'; o.title = 'получение токена';
        } else o.title = target;
        o.integ = true; add(o); integ.push(o);
        pend.lfint.set(key, o);
      } else {
        let o = pend.lfint.get(key);
        if(!o){                      // a response whose request fell outside the dump
          const tg = target === 'MCP' ? {kind: 'mcp', to: usesGateway ? 'mcp-gateway' : 'MCP-сервер', title: 'tools/call ' + (raw.operation || ''), tool: raw.operation || ''}
                   : target === 'AlfaGen API' ? {kind: 'llm', to: 'alfagen-gateway-api (LLM)', title: 'вызов модели', llmId: (raw.message_id || '').toLowerCase()}
                   : target === 'Comod Webhook' ? {kind: 'flow', to: 'aiagentscn-queue-keeper', title: 'callback ' + (raw.event_type || ''), event: raw.event_type || ''}
                   : target === 'Keycloak' ? {kind: 'auth', to: 'Keycloak', title: 'получение токена'}
                   : target === 'ACCESS' ? {kind: 'flow', to: 'alfagen-langflow', title: 'входящий запрос'}
                   : {kind: 'flow', to: target, title: target};
          o = add(Object.assign({ts: Math.min(r.ts, spanFirst.get(sp) || r.ts), from: target === 'ACCESS' ? 'клиент' : 'alfagen-langflow', method: raw.method || 'POST',
                   endpoint: raw.url || raw.path || '', integ: true,
                   src: 'alfagen-langflow · ' + target, req: {note: 'запрос не попал в выгрузку (был раньше начала выгрузки)'}}, tg));
          integ.push(o);
        }
        pend.lfint.delete(key);
        o.status = raw.status_code != null ? +raw.status_code : o.status;
        o.ms = raw.operation_duration_ms != null ? +raw.operation_duration_ms : o.ms;
        o.end = r.ts;
        o.resp = {headers: rawPrefixed(raw, 'response_headers.'),
                  body: raw.response_body != null ? String(raw.response_body) : null, fmt: 'json'};
      }
      return;
    }

    // ---------- langflow access log, older dialect (python dicts inline)
    if(app === 'alfagen-langflow' && m.lastIndexOf('[ACCESS] ->', 0) === 0){
      const a = extractAccess(m, app);
      if(!a) return;
      if(a.phase === 'Request'){
        const hm = /headers=(\{[\s\S]*?\})\s+body=/.exec(m);
        const hs = hm ? safeJson(pyToJson(hm[1])) : null;
        const o = add({ts: r.ts, kind: 'flow', to: 'alfagen-langflow', method: a.method, endpoint: a.path,
                       from: /\/alfi\/run\//.test(a.path) ? 'aiagentscn-agent-orchestrator' :
                             /\/flows\//.test(a.path) ? 'клиент (UI langflow)' :
                             (hs && /ReactorNetty/i.test(hs['user-agent'] || '')) ? 'alfagen-strategy-api' : 'клиент',
                       title: /\/run\//.test(a.path) ? 'запуск флоу' : 'входящий запрос', src: 'alfagen-langflow · ACCESS',
                       req: {headers: hs, body: a.body, fmt: 'json'}});
        pend.access.push(o);
      } else {
        const i = pend.access.findIndex(o => o.endpoint === a.path);
        const o = i >= 0 ? pend.access.splice(i, 1)[0] :
          add({ts: r.ts, kind: 'flow', from: 'клиент', to: 'alfagen-langflow', method: a.method, endpoint: a.path,
               title: 'ответ langflow', src: 'alfagen-langflow · ACCESS', req: {note: 'запрос не попал в выгрузку'}});
        const hm = /headers=MutableHeaders\((\{[\s\S]*?\})\)/.exec(m);
        o.status = a.code; o.end = r.ts; o.ms = r.ts - o.ts;
        o.resp = {headers: hm ? safeJson(pyToJson(hm[1])) : null, body: a.body, fmt: 'json'};
      }
      return;
    }

    // ---------- langflow → model: "[ASK LLM] Request|Response | … | headers: {…} | body: {…}"
    if(app === 'alfagen-langflow' && m.lastIndexOf('[ASK LLM]', 0) === 0){
      const ph = /^\[ASK LLM\]\s*(Request|Response)/.exec(m);
      if(!ph) return;
      const hi = m.indexOf('headers:'), bi = m.indexOf('| body:');
      const headers = hi >= 0 ? m.slice(hi + 8, bi > hi ? bi : undefined).trim() : null;
      const body = bi >= 0 ? m.slice(bi + 7).trim() : null;
      const model = (/\|\s*model=([^|]+?)\s*\|/.exec(m) || [])[1] || (/'model':\s*'([^']+)'/.exec(body || '') || [])[1] || '';
      if(ph[1] === 'Request'){
        const ids = (headers || '').match(/'messageId':\s*'([^']+)'/g) || [];
        const id = ids.length ? uuidIn(ids[ids.length - 1]) : null;      // the call's own id is the last one
        const o = add({ts: r.ts, kind: 'llm', from: 'alfagen-langflow', to: 'alfagen-gateway-api (LLM)',
                       method: 'POST', endpoint: '/internal/llm/v1/chat/completions',
                       title: 'вызов модели' + (model ? ' ' + model : ''), src: 'alfagen-langflow · ASK LLM',
                       llmId: id, req: {headers: headers, hfmt: 'py', body: body, fmt: 'py'}});
        pend.ask.push(o);
      } else {
        const t = extractAskLlm(m);
        const id = t && t.content ? answerByKey.get(turnKey(t.content)) : null;
        let i = id ? pend.ask.findIndex(o => o.llmId === id) : -1;
        if(i < 0) i = 0;
        const o = pend.ask.length ? pend.ask.splice(i, 1)[0] :
          add({ts: r.ts, kind: 'llm', from: 'alfagen-langflow', to: 'alfagen-gateway-api (LLM)',
               title: 'ответ модели', src: 'alfagen-langflow · ASK LLM', req: {note: 'запрос не попал в выгрузку'}});
        const tt = /total_tokens=(\d+)/.exec(m);
        o.end = r.ts; o.ms = r.ts - o.ts; o.status = 200;
        o.resp = {headers: headers, hfmt: 'py', body: body, fmt: 'py'};
        if(tt) o.tokens = +tt[1];
      }
      return;
    }

    // ---------- langflow → MCP: "[MCP -> {http}] | Request|Response | tool | … body=…"
    if(m.lastIndexOf('[MCP -> {http}]', 0) === 0){
      const x = extractMcpHttp(m);
      if(!x || x.protocol) return;
      if(x.phase === 'Request'){
        const srv = (/\|\s*server=([\w.\-]+)/.exec(m) || [])[1] || '';
        const url = (/\|\s*url=(\S+)/.exec(m) || [])[1] || '';
        add(Object.assign({ts: r.ts, kind: 'mcp', from: 'alfagen-langflow',
                           to: /gateway/i.test(srv) || /\/gateway\/mcp/i.test(url) ? 'mcp-gateway' : (srv || 'MCP-сервер'),
                           method: 'POST', endpoint: url, title: 'tools/call ' + x.name, tool: x.name,
                           src: 'alfagen-langflow · MCP', req: js(firstJsonAfter(m, '| body='))}, {}));
        pend.mcp.push(C[C.length - 1]);
      } else {
        const i = pend.mcp.findIndex(o => o.tool === x.name);
        if(i < 0) return;
        const o = pend.mcp.splice(i, 1)[0];
        o.end = r.ts; o.ms = r.ts - o.ts; o.status = x.isError ? 'isError' : 200;
        o.resp = js(x.result);
      }
      return;
    }

    // ---------- MCP server side: "TOOL: name, PARAMETERS: {…}, … RESULT: {…}"
    if(/^TOOL:\s/.test(m)){
      const x = extractMcp(m);
      if(!x || !x.tool) return;
      // a server that logs the call twice — once on entry, once with the result — is one call
      const open = C.slice().reverse().find(o => o.src === app && o.tool === x.tool && o.openTool && r.ts - o.ts < 120000);
      if(open && (x.result || x.code)){
        open.openTool = false; open.end = r.ts; open.ms = x.ms != null ? x.ms : r.ts - open.ts;
        open.status = x.failed ? (x.statusCode || x.code || 'ошибка') : 'ok';
        open.resp = x.result ? js(x.result) : {note: 'ошибка ' + x.code};
        if(x.params && (!open.req.body || open.req.body === '{}')) open.req = js(x.params);
        return;
      }
      add({openTool: !(x.result || x.code), ts: r.ts, kind: 'mcp', from: usesGateway ? 'mcp-gateway' : 'alfagen-langflow', to: app,
           method: 'tools/call', endpoint: x.tool, title: 'tools/call ' + x.tool, tool: x.tool, ms: x.ms,
           status: x.failed ? (x.statusCode || x.code || 'ошибка') : 'ok', src: app,
           req: js(x.params || '{}'), resp: x.result ? js(x.result) : {note: x.code ? 'ошибка ' + x.code : 'результат не записан'}});
      return;
    }
    // MCP server → core service it calls on behalf of a tool
    if(/^UPSTREAM_SUBCALL:/.test(m)){
      const peer = (/UPSTREAM_SUBCALL:\s*([\w.\-]+)/.exec(m) || [])[1] || '?';
      const ep = (/ENDPOINT:\s*([^,]+)/.exec(m) || [])[1] || '';
      const ri = m.indexOf('RESULT:');
      let body = null;
      if(ri >= 0){ let j = ri + 7; while(j < m.length && m[j] !== '{' && m[j] !== '[') j++; const b = balanced(m, j); body = b ? b.text : null; }
      const d = /DURATION_MS:\s*([\d.]+)/.exec(m);
      // the same call's "start" may have come in the other dialect — finish that one instead
      const st = C.slice().reverse().find(o => o.src === app && o.upStart && o.to === peer && o.endpoint === ep.trim() && r.ts - o.ts < 120000);
      if(st){
        st.upStart = false; st.status = (/PHASE:\s*(\w+)/.exec(m) || [])[1] || 'ok'; st.end = r.ts;
        st.ms = d ? +d[1] : r.ts - st.ts;
        st.resp = body ? js(body) : {note: 'результат не записан'};
        return;
      }
      add({ts: r.ts, kind: 'mcp', from: app, to: peer, method: 'GET', endpoint: ep.trim(), title: 'вызов core',
           ms: d ? +d[1] : null, status: (/PHASE:\s*(\w+)/.exec(m) || [])[1] || '', src: app,
           req: {note: (m.slice(0, m.indexOf(', RESULT:') > 0 ? m.indexOf(', RESULT:') : 200)).replace(/^UPSTREAM_SUBCALL:\s*/, '')},
           resp: body ? js(body) : null});
      return;
    }
    if(/^upstream_retry, traceId:/.test(m)){
      // a failed attempt at a core call that will be retried
      const peer = raw.service || (/\bservice:\s*([\w.\-]+)/.exec(m) || [])[1] || raw.upstream_peer || 'core';
      const ep = raw.endpoint || (/\bendpoint:\s*([^,\s]+)/.exec(m) || [])[1] || '';
      const att = raw.attempt || (/\battempt:\s*(\d+)/.exec(m) || [])[1] || '';
      const maxA = raw.max_attempts || (/max_attempts:\s*(\d+)/.exec(m) || [])[1] || '';
      const rb = {};
      Object.keys(raw).forEach(k => { if(k.lastIndexOf('upstream_response_body.', 0) === 0) rb[k.slice(23)] = raw[k]; });
      add({ts: r.ts, kind: 'mcp', from: app, to: peer, method: raw.http_method || (/http_method:\s*(\w+)/.exec(m) || [])[1] || 'GET',
           endpoint: raw.upstream_url || ep, title: 'повтор вызова core' + (att ? ' · попытка ' + att + (maxA ? ' из ' + maxA : '') : ''),
           status: raw.upstream_status || (/upstream_status:\s*(\d+)/.exec(m) || [])[1] || 'ошибка', src: app,
           req: {note: 'параметры запроса в URL' + (raw.next_retry_delay_s ? '; следующая попытка через ' + raw.next_retry_delay_s + ' с' : '')},
           resp: Object.keys(rb).length ? js(JSON.stringify(rb)) : (firstJsonAfter(m, 'upstream_response_body:') ? js(firstJsonAfter(m, 'upstream_response_body:')) : {note: 'тело ответа не записано'})});
      return;
    }
    if(/_upstream_subcall, traceId:/.test(m)){
      const peer = raw.upstream_peer || (/upstream_peer:\s*([\w.\-]+)/.exec(m) || [])[1] || '?';
      const ep = raw.upstream_endpoint || (/upstream_endpoint:\s*(\S+)/.exec(m) || [])[1] || '';
      const tool = raw.tool || (/tool:\s*([\w.\-]+)/.exec(m) || [])[1] || '';
      const d = raw.duration_ms != null ? [0, raw.duration_ms] : /duration_ms:\s*([\d.]+)/.exec(m);
      const phase = raw.phase || (/phase:\s*(\w+)/.exec(m) || [])[1] || '';
      const ep2 = ep.replace(/,$/, '');
      const started = phase !== 'start' && C.slice().reverse().find(o => o.src === app && o.upStart && o.to === peer && o.endpoint === ep2 && r.ts - o.ts < 120000);
      if(started){
        started.upStart = false; started.status = phase; started.end = r.ts; started.ms = d ? +d[1] : r.ts - started.ts;
        const res = firstJsonAfter(m, 'result:');
        started.resp = res ? js(res) : {note: 'результат не записан'};
        const par = firstJsonAfter(m, 'parameters:');
        if(par && (!started.req.body || started.req.body === '{}')) started.req = js(par);
        return;
      }
      add({upStart: phase === 'start', ts: r.ts, kind: 'mcp', from: app, to: peer, method: 'GET', endpoint: ep2, ms: d ? +d[1] : null,
           title: 'вызов core' + (tool ? ' для ' + tool : ''),
           status: phase, src: app,
           req: js(firstJsonAfter(m, 'parameters:')), resp: js(firstJsonAfter(m, 'result:'))});
      return;
    }
    // MCP server that logs the raw inbound JSON-RPC
    if(/^Inbound request: id=/.test(m)){
      const uri = (/uri=(\S+?),/.exec(m) || [])[1] || '';
      const hb = /headers=(\{[\s\S]*?\}), body=/.exec(m);
      const body = afterMarker(m, ', body=');
      const tool = (/"name"\s*:\s*"([\w.\-]+)"/.exec(body || '') || [])[1] || '';
      add({ts: r.ts, kind: 'mcp', from: 'mcp-gateway', to: app, method: (/method=(\w+)/.exec(m) || [])[1] || 'POST',
           endpoint: uri, title: tool ? 'tools/call ' + tool : 'MCP-запрос', tool: tool, src: app,
           req: {headers: hb ? javaHeaders(hb[1]) : null, body: body, fmt: 'json'}});
      return;
    }

    // MCP servers that log only an access line ("Request", method/path/status/latency);
    // the tool is named by the server's other records of the same request
    if(/mcp-server/.test(app) && m === 'Request' && raw.path){
      const tool = toolByReq.get(raw.requestId) || '';
      add({ts: r.ts - Math.round((+raw.latency || 0) * 1000), end: r.ts, kind: 'mcp', from: usesGateway ? 'mcp-gateway' : 'alfagen-langflow',
           to: app, method: raw.method || 'POST', endpoint: raw.path, status: raw.status != null ? +raw.status : null,
           ms: raw.latency != null ? Math.round(+raw.latency * 1000) : null, title: tool ? 'tools/call ' + tool : 'MCP-запрос',
           tool: tool, src: app, req: {note: 'тело сервер не логирует' + (raw.user_agent ? ' · ' + raw.user_agent : '')},
           resp: {note: 'тело сервер не логирует'}});
      return;
    }

    // ---------- RAG gateway
    if(app.indexOf('arag') >= 0 && m.lastIndexOf('Chunks request with request=', 0) === 0){
      add({ts: r.ts, kind: 'rag', from: 'alfagen-langflow', to: app, method: 'POST', endpoint: raw.url || '/chunks',
           title: 'поиск чанков', src: app, req: {body: afterMarker(m, 'request='), fmt: 'py'}});
      return;
    }

    // ---------- COMOD ↔ comod-adapter
    if(m.lastIndexOf('Inbound COMOD request received', 0) === 0){
      const o = add({ts: r.ts, kind: 'channel', from: 'COMOD', to: app, method: 'POST', endpoint: '/api/v1/inbound',
                     title: 'сообщение пользователя', src: app, comodId: uuidIn(m), req: {}});
      const j = /^Inbound COMOD request received\s*\{/.test(m) ? firstJsonAfter(m, 'received') : null;
      if(j){ o.req.body = j; o.req.fmt = 'json'; }
      else {
        o.req.note = 'тело не логируется: ' + m.replace(/^Inbound COMOD request received\s*/, '');
        o.wantRebuild = true;
      }
      if(lastCaddyInbound && Math.abs(lastCaddyInbound.ts - r.ts) < 3000) o.req.headers = lastCaddyInbound.headers;
      pend.comodIn = o;
      return;
    }
    if(m.lastIndexOf('Inbound COMOD response', 0) === 0){
      const o = pend.comodIn;
      if(o){ o.status = +((/status=(\d+)/.exec(m) || [])[1] || 0) || o.status; o.end = r.ts; o.ms = r.ts - o.ts;
             o.resp = {note: m.replace(/^Inbound COMOD response\s*/, '')}; }
      return;
    }
    if(m.lastIndexOf('Message is queued', 0) === 0 && pend.comodIn && !pend.comodIn.resp){
      pend.comodIn.resp = {note: m};
      return;
    }
    if(app.indexOf('comod-adapter') >= 0 && m.lastIndexOf('AI Flow callback received', 0) === 0){
      const j = firstJsonAfter(m, 'received');
      if(!j) return;
      const ev = (/"event_type"\s*:\s*"(\w+)"/.exec(j) || [])[1] || '';
      add({ts: r.ts, kind: 'flow', from: 'alfagen-langflow', to: app, method: 'POST', endpoint: '/api/v1/aiflow-response',
           title: 'callback ' + ev, event: ev, src: app, req: js(j)});
      return;
    }
    if(m.lastIndexOf('COMOD answer send request', 0) === 0){
      const bi = m.indexOf('body=');
      const body = bi >= 0 ? balanced(m, bi + 5) : null;
      const st = (/"status"\s*:\s*"([A-Z_]+)"/.exec(m) || [])[1] || '';
      const o = add({ts: r.ts, kind: 'channel', from: app, to: 'COMOD', method: 'POST',
                     endpoint: '/adapters/bank/agenthub/message/send', title: 'ответ в канал' + (st ? ' · ' + st : ''),
                     src: app, comodId: uuidIn(m), req: body ? js(body.text) : {note: 'тело не записано'}});
      pend.comodOut = o;
      return;
    }
    if(m.lastIndexOf('COMOD answer sent', 0) === 0 || m.lastIndexOf('Answer sent directly', 0) === 0){
      const o = pend.comodOut;
      if(o && !o.resp){ o.resp = {note: m}; o.status = o.status || 'отправлено'; o.end = r.ts; o.ms = r.ts - o.ts; }
      return;
    }
    if(m.lastIndexOf('COMOD intermediate status send completed', 0) === 0){
      add({ts: r.ts, kind: 'channel', from: app, to: 'COMOD', method: 'POST', endpoint: '/adapters/bank/agenthub/message/send',
           title: 'промежуточный статус', src: app, req: {note: 'тело не логируется: ' + m.replace(/^COMOD intermediate status send completed\s*/, '')},
           resp: {note: 'отправлено'}});
      return;
    }
    // newer comod-adapter: no bodies, ids only
    if(m.lastIndexOf('COMOD answer send [', 0) === 0){
      const o = add({ts: r.ts, kind: 'channel', from: app, to: 'COMOD', method: 'POST',
                     endpoint: '/adapters/bank/agenthub/message/send', title: 'ответ в канал', src: app,
                     comodId: uuidIn(m), wantAssembly: true,
                     req: {note: 'тело не логируется: ' + m.replace(/^COMOD answer send\s*/, '')}});
      pend.comodOut = o;
      return;
    }
    if(m.lastIndexOf('COMOD answer send succeeded', 0) === 0){
      const o = pend.comodOut;
      if(o){ o.status = +((/httpStatus=(\d+)/.exec(m) || [])[1] || 0) || 'ok'; o.end = r.ts; o.ms = r.ts - o.ts;
             o.resp = {note: m.replace(/^COMOD answer send succeeded\s*/, '')}; }
      return;
    }
    if(m.lastIndexOf('Queue Keeper enqueue request', 0) === 0){
      pend.qkIn = add({ts: r.ts, kind: 'flow', from: app, to: 'aiagentscn-queue-keeper', method: 'POST', endpoint: '',
                       title: 'постановка в очередь', src: app, req: {note: 'тело не логируется: ' + m.replace(/^Queue Keeper enqueue request\s*/, '')}});
      return;
    }
    if(m.lastIndexOf('Queue Keeper enqueue response', 0) === 0 && pend.qkIn){
      const o = pend.qkIn; pend.qkIn = null;
      o.status = +((/status=(\d+)/.exec(m) || [])[1] || 0) || 'ok'; o.end = r.ts; o.ms = r.ts - o.ts;
      o.resp = {note: m.replace(/^Queue Keeper enqueue response\s*/, '')};
      return;
    }
    if(m.lastIndexOf('Queue Keeper callback received', 0) === 0){
      const ev = (/callbackEventId='([^']+)'/.exec(m) || [])[1] || '';
      pend.qkCb = add({ts: r.ts, kind: 'flow', from: 'aiagentscn-queue-keeper', to: app, method: 'POST', endpoint: '',
                       title: 'callback ' + ((/eventType=(\w+)/.exec(m) || [])[1] || ''), cbEvent: ev, src: app,
                       req: {note: 'тело не логируется: ' + m.replace(/^Queue Keeper callback received\s*/, '')}});
      return;
    }
    if(m.lastIndexOf('Queue Keeper callback response', 0) === 0 && pend.qkCb){
      const o = pend.qkCb; pend.qkCb = null;
      o.status = +((/status=(\d+)/.exec(m) || [])[1] || 0) || 'ok'; o.end = r.ts; o.ms = r.ts - o.ts;
      o.resp = {note: m.replace(/^Queue Keeper callback response\s*/, '')};
      return;
    }
    // queue-keeper's copy of langflow's callback (kept only if langflow's own is missing)
    if(app.indexOf('queue-keeper') >= 0 && m.lastIndexOf('AI Flow callback received', 0) === 0){
      const ri = m.indexOf("requestBody='");
      if(ri < 0) return;
      const body = m.slice(ri + 13, m.lastIndexOf("']") > ri ? m.lastIndexOf("']") : undefined);
      const ev = (/type='(\w+)'/.exec(m) || [])[1] || '';
      add({ts: r.ts, kind: 'flow', from: 'alfagen-langflow', to: app, method: 'POST', endpoint: '/api/v1/ai-flow/callback',
           title: 'callback ' + ev.toLowerCase(), event: ev.toLowerCase(), qkEvent: (/eventId='([^']+)'/.exec(m) || [])[1] || '',
           src: app, dupOfLangflow: true, req: js(body)});
      return;
    }

    // ---------- proxy-caddy access log: headers of the hop, never the body
    if(app.indexOf('proxy-caddy') >= 0 && raw['attributes.request.uri']){
      const uri = raw['attributes.request.uri'];
      const h = rawPrefixed(raw, 'attributes.request.headers.');
      if(uri === '/api/v1/inbound'){
        lastCaddyInbound = {ts: r.ts, headers: h};
        const o = C.slice().reverse().find(x => x.endpoint === '/api/v1/inbound' && Math.abs(x.ts - r.ts) < 3000);
        if(o){
          o.req.headers = o.req.headers || h;
          o.host = raw['attributes.request.host'];
          if(!o.status) o.status = raw.status;
        }
        return;
      }
      const svc = h && h['X-Source-Service'] ? String(h['X-Source-Service']) : null;
      const from = /\/api\/v\d+\/(?!route)\w+$/.test(uri) && !/aiflow/.test(uri) ? 'aiagentscn-agent-orchestrator' :
                   svc ? (svc.indexOf('aiagentscn') === 0 ? svc : 'aiagentscn-' + svc) :
                   /route/.test(uri) ? 'aiagentscn-queue-keeper' : 'клиент';
      const to = /route/.test(uri) ? 'aiagentscn-agent-orchestrator' :
                 /aiflow-response/.test(uri) ? 'aiagentscn-comod-adapter' :
                 /\/api\/v\d+\/(\w+)/.test(uri) ? 'агент ' + /\/api\/v\d+\/(\w+)/.exec(uri)[1] + ' (langflow)' :
                 (raw['attributes.request.host'] || 'сервис');
      add({ts: r.ts - Math.round((+raw['attributes.duration'] || 0) * 1000), end: r.ts, kind: 'flow', from: from, to: to,
           method: raw['attributes.request.method'] || 'POST', endpoint: uri, status: raw.status,
           ms: Math.round((+raw['attributes.duration'] || 0) * 1000), title: 'HTTP через proxy-caddy', src: app,
           req: {headers: h, note: 'тело не логируется · ' + (raw['attributes.bytes_read'] || '?') + ' байт'},
           resp: {headers: rawPrefixed(raw, 'attributes.resp_headers.'), note: (raw['attributes.size'] || '?') + ' байт'}});
      return;
    }
    // orchestrator's outbound calls (routing model, the agent); the agent call is covered
    // by the caddy record when there is one
    if(app.indexOf('agent-orchestrator') >= 0 && /^Выполняется POST-запрос: url=/.test(m)){
      const url = m.replace(/^Выполняется POST-запрос: url=/, '').trim();
      const agent = /\/api\/v\d+\/\w+$/.test(url);
      add({ts: r.ts, kind: 'flow', from: app, to: agent ? 'агент ' + url.split('/').pop() + ' (langflow)' : url.replace(/^https?:\/\/([^\/]+).*$/, '$1'),
           method: 'POST', endpoint: url, title: agent ? 'вызов агента' : 'модель маршрутизации', src: app, orchAgent: agent,
           req: {note: 'тело не логируется'}});
      return;
    }
    // egress-gateway: the address the answer went to
    if(app.indexOf('egress-gateway') >= 0 && /^HTTP Request: (POST|GET) \S+ "HTTP\/[\d.]+ (\d+)/.test(m)){
      const x = /^HTTP Request: (POST|GET) (\S+) "HTTP\/[\d.]+ (\d+)/.exec(m);
      if(/\/message\/send/.test(x[2])){
        const o = C.slice().reverse().find(c => c.to === 'COMOD' && c.from.indexOf('comod-adapter') >= 0 &&
                                              r.ts - c.ts < 5000 && r.ts >= c.ts - 50 && !c.egress);
        if(o){ o.egress = true; o.endpoint = x[2]; o.via = 'aiagentscn-egress-gateway'; if(!o.status) o.status = +x[3]; return; }
        add({ts: r.ts, kind: 'channel', from: 'aiagentscn-egress-gateway', to: 'COMOD', method: x[1], endpoint: x[2],
             status: +x[3], title: 'ответ в канал', src: app, req: {note: 'тело не логируется'}});
      } else if(/token|keycloak/i.test(x[2])){
        add({ts: r.ts, kind: 'auth', from: app, to: x[2].replace(/^https?:\/\/([^\/]+).*$/, '$1'), method: x[1], endpoint: x[2],
             status: +x[3], title: 'получение токена / секрета', src: app, req: {note: 'тело не логируется'}});
      }
      return;
    }

    // ---------- synchronous stack: gateway → bot-conversation → session → strategy
    if(app === 'alfagen-gateway-api' && /^HTTP request received: POST https?:\/\//.test(m)){
      const url = /^HTTP request received: POST (\S+)/.exec(m)[1];
      if(/\/chat\/completions/.test(url)) return;               // a model call — covered by langflow's side
      const bank = /adapters\/bank\d*\//.test(url);
      const o = add({ts: r.ts, kind: 'channel', from: bank ? 'alfagen-bot-conversation-api' : 'COMOD',
                     to: bank ? 'COMOD' : (/bot-conversation/.test(url) ? 'alfagen-bot-conversation-api' : 'alfagen-gateway-api'),
                     via: 'alfagen-gateway-api', method: 'POST', endpoint: url,
                     title: bank ? 'ответ в канал' : 'сообщение пользователя', src: app,
                     req: {note: 'тело шлюз не логирует'}});
      if(raw.requestId) pend.gw.set(raw.requestId, o);
      if(bank) pend.bankOut = o;
      return;
    }
    if(app === 'alfagen-gateway-api' && /^HTTP Response sent: Status=(\d+)/.test(m) && raw.requestId && pend.gw.has(raw.requestId)){
      const o = pend.gw.get(raw.requestId); pend.gw.delete(raw.requestId);
      o.status = +/Status=(\d+)/.exec(m)[1]; o.end = r.ts; o.ms = r.ts - o.ts;
      o.resp = o.resp || {note: 'тело шлюз не логирует'};
      return;
    }
    if(app === 'alfagen-gateway-api' && /^RequestAuthDetails/.test(m)){
      const o = raw.requestId && pend.gw.get(raw.requestId);
      if(o) o.auth = m.replace(/^RequestAuthDetails\s*\|\s*/, '').replace(/\s*\|\s*/g, ' ');
      return;
    }
    if(m.lastIndexOf('Start processing new question', 0) === 0){
      const o = C.slice().reverse().find(c => c.to === 'alfagen-bot-conversation-api' && r.ts - c.ts < 5000);
      if(o) o.req.note = (o.req.note ? o.req.note + ' · ' : '') + m.replace(/^Start processing new question\s*/, '');
      return;
    }
    if(m.lastIndexOf('Success sent answer for comod', 0) === 0){
      const ai = m.indexOf('llm2comod=');
      const arr = ai >= 0 ? balanced(m, ai + 10) : null;
      const body = arr ? '{"llm2comod":' + arr.text + '}' : null;
      const o = pend.bankOut && r.ts - pend.bankOut.ts < 5000 ? pend.bankOut : null;
      if(o){ o.req = {body: body, fmt: 'json', note: 'тело — из лога bot-conversation-api (DTO ComodAnswer)'}; pend.bankOut = null; }
      else add({ts: r.ts, kind: 'channel', from: app, to: 'COMOD', method: 'POST', endpoint: '/adapters/bank2/bot_llm/message/send',
                title: 'ответ в канал', src: app, req: {body: body, fmt: 'json'}});
      return;
    }
    if(/ERROR response stub is sent to comod/.test(m)){
      add({ts: r.ts, kind: 'channel', from: app, to: 'COMOD', method: 'POST', endpoint: '', title: 'ответ-заглушка об ошибке',
           status: 'ошибка', src: app, req: {note: m.replace(/^ERROR response stub is sent to comod\s*/, '')}});
      return;
    }
    if(m.lastIndexOf('Start processing llm response', 0) === 0){
      const ri = m.indexOf("response='");
      add({ts: r.ts, kind: 'flow', from: 'alfagen-session-api', to: app, method: 'gRPC', endpoint: 'stream',
           title: 'ответ модели в бот', src: app, req: {body: ri >= 0 ? m.slice(ri + 10).replace(/'\]\s*$/, '') : null, fmt: 'proto'}});
      return;
    }
    if(m.lastIndexOf('Incoming request:', 0) === 0 && app === 'alfagen-strategy-api'){
      const id = (/requestId:\s*"([^"]+)"/.exec(m) || [])[1] || '';
      const o = add({ts: r.ts, kind: 'flow', from: 'alfagen-session-api', to: app, method: 'gRPC', endpoint: 'Conversation',
                     title: 'вопрос в стратегию', src: app, req: {body: m.replace(/^Incoming request:\s*/, ''), fmt: 'proto'}});
      pend.strat.set(id, o);
      return;
    }
    if(m.lastIndexOf('Strategy->session returned response', 0) === 0){
      const id = (/requestId:\s*"([^"]+)"/.exec(m) || [])[1] || '';
      const o = pend.strat.get(id);
      const resp = {body: m.replace(/^Strategy->session returned response\s*=\s*/, ''), fmt: 'proto'};
      if(o){ o.resp = resp; o.end = r.ts; o.ms = r.ts - o.ts; o.status = 'ok'; pend.strat.delete(id); }
      else add({ts: r.ts, kind: 'flow', from: app, to: 'alfagen-session-api', method: 'gRPC', title: 'ответ стратегии',
                src: app, req: {note: 'запрос не попал в выгрузку'}, resp: resp});
      return;
    }
    if(m.lastIndexOf('Request to LangFlow:', 0) === 0){
      pend.toLf = add({ts: r.ts, kind: 'flow', from: app, to: 'alfagen-langflow', method: 'POST', endpoint: '/api/v1/run/…',
                       title: 'запуск флоу', src: app, fromStrategy: true,
                       req: {body: m.replace(/^Request to LangFlow:\s*/, ''), fmt: 'tostring'}});
      return;
    }
    if(/^Request to LangFlow succeeded:|^LangFlow response status=/.test(m) && pend.toLf){
      const o = pend.toLf; pend.toLf = null;
      const code = /status=(\d+)/.exec(m);
      o.status = code ? +code[1] : 200; o.end = r.ts; o.ms = r.ts - o.ts;
      o.resp = code ? {body: afterMarker(m, 'raw='), fmt: 'json'}
                    : {body: m.replace(/^Request to LangFlow succeeded:\s*/, ''), fmt: 'tostring'};
      return;
    }

    // ---------- inside the LLM gateway (one model call = a small chain of its own)
    if(app === 'alfagen-transformation-service' && /^Payload 'chat' for /.test(m)){
      const o = add({ts: r.ts, kind: 'llmgw', from: 'alfagen-gateway-api', to: app, method: 'POST', endpoint: '/internal/llm/v1/chat/completions',
                     title: 'запрос к модели', llmId: uuidIn(m), src: app,
                     req: {body: m.replace(/^Payload 'chat' for [^:]+:\s*/, ''), fmt: 'tostring'}});
      pend.payload.push(o);
      return;
    }
    if(app === 'alfagen-transformation-service' && /^Response 'chat' from strategy/.test(m)){
      const o = pend.payload.shift();
      if(o){ o.resp = {body: m.replace(/^Response 'chat' from strategy\s*/, ''), fmt: 'tostring'}; o.end = r.ts; o.ms = r.ts - o.ts; o.status = 200; }
      return;
    }
    if(app === 'alfagen-transformation-service' && /^Sending chat request /.test(m)){
      add({ts: r.ts, kind: 'llmgw', from: app, to: 'alfagen-strategy-api', method: 'gRPC', endpoint: 'chat', title: 'запрос к модели',
           src: app, req: {body: m.replace(/^Sending chat request\s*/, ''), fmt: 'proto'}, resp: {note: 'ответ — в звене gateway → transformation'}});
      return;
    }
    if(/^\[FUNCTIONS\] Init request:/.test(m)){
      const id = uuidIn(m);
      const o = add({ts: r.ts, kind: 'llmgw', from: app, to: 'alfagen-java-functions-service', method: 'gRPC', endpoint: 'Init',
                     title: 'запуск функций', llmId: id, src: app, req: {body: m.replace(/^\[FUNCTIONS\] Init request:\s*/, ''), fmt: 'proto'}});
      pend.init.set(id || ('#' + r.ts), o);
      return;
    }
    if(m.lastIndexOf('Answer is ready with messageId=', 0) === 0){
      const id = uuidIn(m);
      let o = id && pend.init.get(id);
      if(!o){                          // masking ate the id — take the oldest open one
        const firstKey = Array.from(pend.init.keys())[0];
        if(firstKey != null){ o = pend.init.get(firstKey); pend.init.delete(firstKey); }
      } else pend.init.delete(id);
      const resp = {body: afterMarker(m, ': payload') ? 'payload ' + afterMarker(m, ': payload') : m, fmt: 'proto'};
      if(o){ o.resp = resp; o.end = r.ts; o.ms = r.ts - o.ts; o.status = 'ok'; }
      return;
    }
    if(/^SUCCESS: 'OpenAiIntegrationController\.chat'/.test(m)){
      const id = msgIdKey(m);
      const ri = m.indexOf("[request='");
      const orphan = id && pend.restOrphan.get(id);
      if(orphan){                      // the provider's answer was logged first
        orphan.from = 'alfagen-java-functions-service'; orphan.to = app + ' → модель'; orphan.method = 'gRPC'; orphan.endpoint = 'chat';
        orphan.title = 'запрос к провайдеру модели';
        orphan.req = {body: ri >= 0 ? m.slice(ri + 10).replace(/'\]\s*$/, '') : null, fmt: 'proto'};
        pend.restOrphan.delete(id);
        return;
      }
      const o = add({ts: r.ts, kind: 'llmgw', from: 'alfagen-java-functions-service', to: app + ' → модель', method: 'gRPC', endpoint: 'chat',
                     title: 'запрос к провайдеру модели', llmId: id, src: app,
                     req: {body: ri >= 0 ? m.slice(ri + 10).replace(/'\]\s*$/, '') : null, fmt: 'proto'}});
      if(id) pend.llmint.set(id, o);
      return;
    }
    if(m.indexOf('Rest response from LLM:') >= 0){
      const id = msgIdKey(m);
      const body = afterMarker(m, 'Rest response from LLM:');
      const o = id && pend.llmint.get(id);
      if(o){ o.resp = js(body); o.status = 200; o.end = r.ts; pend.llmint.delete(id); }
      else {
        const orphan = add({ts: r.ts, kind: 'llmgw', from: 'alfagen-java-functions-service', to: app + ' → модель', title: 'ответ провайдера модели',
                            llmId: id, src: app, status: 200, req: {note: 'запрос не попал в выгрузку'}, resp: js(body)});
        if(id) pend.restOrphan.set(id, orphan);
      }
      return;
    }
    if(/^CALL: 'SafetyBusController\.censorCheck'/.test(m)){
      const ri = m.indexOf("[request='");
      pend.safety.push(add({ts: r.ts, kind: 'llmgw', from: 'alfagen-llm-integration-service', to: app, method: 'gRPC',
                            endpoint: 'censorCheck', title: 'проверка цензора', llmId: uuidIn(m), src: app,
                            req: {body: ri >= 0 ? m.slice(ri + 10).replace(/'\]\s*$/, '') : null, fmt: 'proto'}}));
      return;
    }
    if(/^SUCCESS: 'SafetyBusController\.censorCheck'/.test(m)){
      const id = uuidIn(m);
      const i = pend.safety.findIndex(o => o.llmId === id);
      const o = pend.safety.splice(i >= 0 ? i : 0, 1)[0];
      if(o){ o.status = 'ok'; o.end = r.ts; o.ms = r.ts - o.ts;
             const rs = m.indexOf("[response='"); o.resp = rs >= 0 ? {body: m.slice(rs + 11).replace(/'\]\s*$/, ''), fmt: 'proto'} : {note: 'проверка пройдена'}; }
      return;
    }
    if(/^SUCCESS: 'PermissionController\.checkPermission'/.test(m)){
      const ri = m.indexOf("[request='");
      add({ts: r.ts, kind: 'llmgw', from: 'alfagen-transformation-service', to: app, method: 'gRPC', endpoint: 'checkPermission',
           title: 'проверка прав', src: app, status: 'ok', req: {body: ri >= 0 ? m.slice(ri + 10).replace(/'\]\s*$/, '') : null, fmt: 'proto'}});
      return;
    }
  });

  // ---- de-duplicate hops logged at both ends, keeping the richer copy
  const near = (a, b, ms) => Math.abs(a.ts - b.ts) <= ms;
  const drop = new Set();
  C.forEach(c => {
    // langflow's integration log covers what the older/other dialects say about the same hop
    if(c.integ) return;
    if(c.src === 'alfagen-langflow · ASK LLM' && c.llmId && integ.some(o => o.kind === 'llm' && o.llmId === c.llmId)) drop.add(c);
    if(c.src === 'alfagen-langflow · MCP' && integ.some(o => o.kind === 'mcp' && o.tool === c.tool && near(o, c, 1500))) drop.add(c);
    if(c.dupOfLangflow && integ.some(o => o.to === 'aiagentscn-queue-keeper' && o.event === c.event && near(o, c, 3000))) drop.add(c);
    // strategy's own copy of the langflow run, when langflow logged the run itself
    if(c.fromStrategy && C.some(o => o !== c && o.to === 'alfagen-langflow' && /\/run\//.test(o.endpoint || '') &&
                                     o.src.indexOf('alfagen-langflow') === 0 && near(o, c, 3000))) drop.add(c);
    // the orchestrator's "calling the agent" when caddy logged that very request
    if(c.orchAgent && C.some(o => o.src.indexOf('proxy-caddy') >= 0 && /^агент /.test(o.to) && near(o, c, 3000))) drop.add(c);
  });

  // ---- bodies nobody logged but a neighbour did
  const lfRun = C.find(c => c.to === 'alfagen-langflow' && c.req && c.req.body && /"comod"\s*:/.test(c.req.body));
  C.forEach(c => {
    if(c.wantRebuild && lfRun){
      const o = safeJson(lfRun.req.body);
      if(o && o.comod && o.metadata){
        const md = Object.assign({}, o.metadata);
        delete md.orchestrator; delete md.client_segment;
        const secs = [{type: 'comod', body: o.comod}, {type: 'metadata', body: md}];
        if(o.assembly) secs.push(o.assembly);
        c.req.body = JSON.stringify(secs);
        c.req.fmt = 'json';
        c.req.rebuilt = 'восстановлено: секции comod / metadata / assembly взяты из тела запроса к langflow, куда comod-adapter переслал их без изменений (добавленные дальше orchestrator и client_segment убраны). Корневая обёртка и порядок секций в логах не видны.';
      }
    }
    if(c.wantAssembly){
      const cb = C.slice().reverse().find(o => o.ts <= c.ts && c.ts - o.ts < 10000 && o.req && o.req.body &&
                                               (o.to === 'aiagentscn-queue-keeper' || o.to.indexOf('queue-keeper') >= 0) &&
                                               /"event_type"\s*:\s*"add_message"/.test(o.req.body));
      const v = cb ? safeJson(cb.req.body) : null;
      const val = v && v.data && v.data.value;
      if(val){
        c.req.body = JSON.stringify(val);
        c.req.fmt = 'json';
        c.req.rebuilt = 'восстановлено: это assembly из callback langflow, который comod-adapter завернул в конверт COMOD. Сам конверт в логах не виден.';
      }
    }
  });

  return C.filter(c => !drop.has(c)).sort((a, b) => a.ts - b.ts);
}

/* python repr → JSON text, as far as it goes: strings re-quoted, None/True/False mapped,
   anything else passed through (a cut-off tail stays cut off) */
function pyToJson(s){
  s = String(s == null ? '' : s);
  let out = '', i = 0;
  while(i < s.length){
    const c = s[i];
    if(c === "'" || c === '"'){
      const r = pyString(s, i);
      if(!r) break;
      out += JSON.stringify(r.text);
      i = r.end + 1;
      continue;
    }
    if(/[A-Za-z_]/.test(c)){
      let j = i;
      while(j < s.length && /[\w.]/.test(s[j])) j++;
      const w = s.slice(i, j);
      out += w === 'None' ? 'null' : w === 'True' ? 'true' : w === 'False' ? 'false' : JSON.stringify(w);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}
