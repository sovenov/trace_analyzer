/* Разбор выгрузок Kibana: записи → трейсы → события хроники, статистика, бюджет MCP.
   Чистые функции без DOM — этот файл и js/contracts.js можно гонять в node. */
const MONTHS = {Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11};
/* Core services write Moscow wall clock into `time`, while the Kibana they are
   exported from renders @timestamp in whatever timezone the analyst's session had —
   the two dumps then disagree by hours. See liftRecord. */
const CORE_TZ = '+03:00';

function parseKibanaTs(s){
  if(!s) return null;
  let m = /^(\w{3})\s+(\d{1,2}),\s*(\d{4})\s*@\s*(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/.exec(s);
  if(m && MONTHS[m[1]] !== undefined){
    return new Date(+m[3], MONTHS[m[1]], +m[2], +m[4], +m[5], +m[6], +(m[7]||0));
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

/* Find a balanced {...} or [...] starting at `start`. Quote- and escape-aware. */
function balanced(s, start){
  const open = s[start];
  const close = open === '{' ? '}' : open === '[' ? ']' : null;
  if(!close) return null;
  let depth = 0, inStr = false, esc = false;
  for(let i = start; i < s.length; i++){
    const c = s[i];
    if(esc){ esc = false; continue; }
    if(c === '\\'){ esc = true; continue; }
    if(c === '"'){ inStr = !inStr; continue; }
    if(inStr) continue;
    if(c === open) depth++;
    else if(c === close){ depth--; if(depth === 0) return {text: s.slice(start, i+1), end: i+1}; }
  }
  return {text: s.slice(start), end: s.length};
}

/* Logs are PII-masked, which turns numbers into *MASKED_X* and breaks JSON. Repair, then parse. */
function safeJson(txt){
  if(!txt) return null;
  let t = String(txt).trim();
  t = t.replace(/:\s*\*MASKED_[A-Z_]+\*/g, ': "\u2039masked\u203a"');
  // epoch timestamps get blanked into a bare run of asterisks ("startPeriod":**********)
  t = t.replace(/:\s*\*{3,}(?=\s*[,}\]])/g, ': "\u2039masked\u203a"');
  try { return JSON.parse(t); } catch(e){}
  try { return JSON.parse(t.replace(/,\s*([}\]])/g, '$1')); } catch(e){}
  return null;
}

function unesc(s){
  if(s == null) return '';
  return String(s)
    .replace(/\\r\\n|\\n/g, '\n').replace(/\\r/g, '\n').replace(/\\t/g, '\t')
    .replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

function firstJsonAfter(msg, marker){
  const i = msg.indexOf(marker);
  if(i < 0) return null;
  let j = i + marker.length;
  while(j < msg.length && msg[j] !== '{' && msg[j] !== '[') j++;
  if(j >= msg.length) return null;
  const b = balanced(msg, j);
  return b ? b.text : null;
}

/* Two collectors feed these dumps. The old one writes a record flat — app_id, traceId,
   logger, level, message. The OpenTelemetry one nests the real log line under an
   "envoy." prefix and the service identity under "resource.", leaving the top level
   holding nothing but the raw JSON envelope in `message`: to every extractor below such
   a record looks untraced, unattributed and unreadable, so it lands in the "(нет
   traceId)" bucket with its payload unseen. A third variant stuffs that same envelope
   into `message` as a JSON string with no envoy fields at all. Lift all of them back to
   the flat shape before anything else looks at a record.
   Runtimes disagree on spelling — java writes traceId/spanId, python trace_id/span_id —
   so both are accepted, and "null" arrives as a literal string often enough to check. */
function liftRecord(l){
  if(!l || typeof l !== 'object') return l;
  // A hop through the java gateway starts a fresh traceparent, so the MCP server behind
  // it logs a trace id of its own and every call it serves becomes a one-record trace in
  // the tab strip. The caller's trace rides along in the b3 header the request carried —
  // the record prints its own headers, so take the trace back from there.
  const rawMsg = l.message == null ? '' : String(l.message);
  if(rawMsg.indexOf('x-b3-traceid') >= 0){
    const b3 = /x-b3-traceid=?["'\[\s]*([0-9a-f]{32})/i.exec(rawMsg);
    if(b3 && l.traceId !== b3[1]) l = Object.assign({}, l, {traceId: b3[1]});
  }
  // the overwhelming majority of records are already flat — leave them untouched rather
  // than shallow-copying every one of tens of thousands of 200-key objects. A record the
  // quality pipeline tagged is never one of them: it has to be re-keyed onto the trace it
  // grades, see langfuse below.
  if(l.traceId && l.app_id && l.message != null && l['attributes.langfuse_trace_id'] == null &&
     l['envoy.message'] == null && l['envoy.method'] == null && l.method == null) return l;
  const val = v => (v == null || v === '' || v === 'null') ? null : v;
  const pick = function(){
    for(let i = 0; i < arguments.length; i++){ const v = val(l[arguments[i]]); if(v != null) return v; }
    return null;
  };
  const hasEnvoyMsg = val(l['envoy.message']) != null;

  // the envelope in `message` is only worth parsing when it is the sole copy of the line
  let env = null;
  if(!hasEnvoyMsg && !val(l.traceId)){
    const raw = String(l.message == null ? '' : l.message).trim();
    if(raw.charAt(0) === '{') env = safeJson(raw);
    // caddy blanks its timestamps into runs of asterisks, which no JSON parser survives.
    // Repair only for that shape: a caddy access log never carries answer text, so a
    // mangled number costs nothing there, while the same repair applied to any envelope
    // would eat the "**0,05%**" markdown out of a real answer.
    if(!env && raw.indexOf('"logger":"http.log.access') >= 0){
      env = safeJson(raw.replace(/:\s*\*{2,}[\d.\s*]*(?=\s*[,}\]])/g, ': 0'));
    }
    // a parsed object counts as an envelope only if it actually wraps a log line. An
    // istio access log is JSON too, but carries no message of its own — treating it as
    // an envelope swallows the record and leaves the raw blob on screen, so let it fall
    // through to the access-log rendering below.
    if(!env || typeof env !== 'object' || (val(env.message) == null && val(env.msg) == null)) env = null;
  }
  const from = k => env ? val(env[k]) : null;

  // Some python services write snake_case fields directly at the top level. Flat
  // service-mesh access logs may carry the same trace in request_id instead; only use
  // that value when it has the exact 32-hex trace-id shape so ordinary request UUIDs do
  // not accidentally merge unrelated records.
  // …but only a record with no message of its own: langflow's integration log also
  // carries method/path next to a real message ("[MCP] Request"), which must survive
  const flatAccess = (!hasEnvoyMsg && !env && val(l.method) != null && val(l.path) != null && val(l.message) == null);
  const requestTrace = flatAccess && /^[0-9a-f]{32}$/i.test(String(val(l.request_id) || ''))
    ? val(l.request_id) : null;

  // The core services the MCP server calls out to sit in a different Kibana and write a
  // .NET-shaped record that shares no field with the flat one: the service is in
  // appName, the logger in category, and the trace only at the tail of userCode —
  // invest_aiagent_<клиент>_<traceId>. Unlifted, the whole core dump lands in the "(нет
  // traceId)" bucket as unattributed noise.
  const coreApp = (!hasEnvoyMsg && !env && val(l.category)) ? pick('appName', 'systemCode') : null;
  const coreTrace = coreApp
    ? (/([0-9a-f]{32})$/i.exec(String(pick('userCode', 'X-External-User-Code') || '')) || [])[1] || null
    : null;
  // The quality pipeline (collector -> arbiter -> pipeline-worker) grades a finished
  // conversation hours later, in a nightly batch, under a trace id of its own — one id
  // covering a whole batch of unrelated conversations. What it actually graded is named
  // in attributes.langfuse_trace_id, so group by that: otherwise the nightly run becomes
  // its own unattributed tab and the verdict is never seen next to the answer it judges.
  const langfuseTrace = val(l['attributes.langfuse_trace_id']);
  // the collector's own reads out of langfuse/clickhouse carry no attributes at all —
  // the trace they fetch is a query parameter of the url the http client logged
  const collectorTrace = (!langfuseTrace && rawMsg.indexOf('param_trace_id=') >= 0)
    ? (/param_trace_id=([0-9a-f]{32})/i.exec(rawMsg) || [])[1] || null : null;
  // the data-masking service reports on a whole trace, and names it in attributes.trace;
  // pymongo's DEBUG echo of a langflow job update carries no trace fields of its own, but
  // the job document it prints holds the W3C traceparent of the run
  const attrTrace = /^[0-9a-f]{32}$/i.test(String(val(l['attributes.trace']) || '')) ? val(l['attributes.trace']) : null;
  const replyTrace = (typeof l.reply === 'string' && l.reply.indexOf('traceparent') >= 0)
    ? (/"traceparent"\s*:\s*"00-([0-9a-f]{32})-/i.exec(l.reply) || [])[1] || null : null;
  const traceId = langfuseTrace || collectorTrace ||
                  pick('traceId', 'trace_id', 'envoy.traceId', 'envoy.trace_id') ||
                  from('traceId') || from('trace_id') || requestTrace || coreTrace ||
                  attrTrace || replyTrace;
  const appId = pick('app_id', 'resource.service_name', 'resource.k8s_container_name', 'envoy.service') || coreApp;
  // an istio access log has no message of its own — state the hop it recorded
  const accessMethod = (!hasEnvoyMsg && !env) ? pick('envoy.method', 'method') : null;
  const accessPath = pick('envoy.path', 'path') || '';
  const accessCode = pick('envoy.response_code', 'response_code');
  const accessDuration = pick('envoy.duration', 'duration');
  const access = accessMethod
    ? accessMethod + ' ' + accessPath + ' -> ' + (accessCode || '?') +
      (accessDuration != null ? ' | ' + accessDuration + ' мс' : '')
    : null;
  // caddy writes its access log as JSON with `msg` instead of `message`, and the useful
  // part is the request it handled, not the constant "handled request" it always says
  const req = env && env.request && typeof env.request === 'object' ? env.request : null;
  const caddy = (env && val(env.msg) != null && req)
    ? (val(req.method) || '?') + ' ' + (val(req.uri) || '') +
      ' -> ' + (val(env.status) || '?') +
      (env.duration != null && !isNaN(+env.duration) ? ' | ' + Math.round(+env.duration * 1000) + ' мс' : '')
    : null;
  const message = pick('envoy.message') || caddy || from('message') || from('msg') || (val(l.message) == null ? access : null);

  if(!traceId && !appId && !message) return l;

  const out = Object.assign({}, l);
  const put = (k, v) => { if(v != null && !val(out[k])) out[k] = v; };
  // not put(): a graded record may already carry the pipeline's own traceId, and the
  // conversation it grades has to win. The pipeline's id stays readable in trace_id.
  if(langfuseTrace) out.traceId = langfuseTrace;
  put('traceId', traceId);
  put('app_id', appId);
  // not put(): what sits in `message` on these records is the raw envelope, with the
  // real line escaped inside it. Every extractor below reads `message`, so the lifted
  // copy has to replace it rather than politely stand aside.
  if(message != null) out.message = message;
  put('spanId', pick('spanId', 'span_id', 'envoy.spanId', 'envoy.span_id') || from('spanId') || from('span_id'));
  put('logger', pick('envoy.logger', 'logger_name') || from('logger') || (coreApp ? val(l.category) : null));
  put('exception', pick('envoy.exception') || from('exception'));
  put('pod_name', pick('resource.k8s_pod_name') || (coreApp ? val(l.host) : null));
  put('namespace', pick('resource.k8s_namespace_name'));
  put('app_version', pick('resource.service_version'));
  // python lowercases its levels; the raw-log filter lists them verbatim, so one casing
  let lvl = pick('level', 'envoy.level') || from('level');
  // an access log has no level of its own — take it from the status it recorded, so a
  // failing hop in the mesh still reaches the errors section
  if(lvl == null && access != null){
    const code = +accessCode;
    lvl = code >= 500 ? 'ERROR' : code >= 400 ? 'WARN' : 'INFO';
  }
  if(lvl != null) out.level = String(lvl).toUpperCase();
  // A core record is dated twice: @timestamp as its Kibana chose to render it, and `time`
  // as the service itself wrote it. Only the second is a fixed point — take it, or the
  // hop lands hours away from the tool call it served.
  if(coreApp){
    const t = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d+))?/.exec(String(val(l.time) || ''));
    if(t) out['@timestamp'] = t[1] + 'T' + t[2] + '.' + ((t[3] || '') + '000').slice(0, 3) + CORE_TZ;
  }
  return out;
}

/* Accept {logs:[...]}, [...], {hits:{hits:[...]}} */
function normalizeFile(json){
  const lift = arr => arr.map(liftRecord);
  if(Array.isArray(json)) return {logs: lift(json), url: ''};
  if(json && Array.isArray(json.logs)) return {logs: lift(json.logs), url: json.url || ''};
  if(json && json.hits && Array.isArray(json.hits.hits)){
    return {logs: lift(json.hits.hits.map(h => Object.assign({}, h._source, {_id: h._id}))), url: ''};
  }
  return null;
}

function fileOrderKey(name){
  const m = String(name).match(/(\d{10,16})/);
  if(!m) return null;
  let n = +m[1];
  if(m[1].length <= 10) n *= 1000;          // seconds -> ms
  else if(m[1].length >= 16) n = Math.round(n/1000); // micros -> ms
  return n;
}

/* records the collector left without a traceId are grouped under this stand-in */
const NO_TRACE = '(нет traceId)';

const REFUSAL = [/нет данных/i, /не могу/i, /к сожалению/i, /не располагаю/i,
                 /отсутству\w* данн/i, /нет информации/i, /не удалось найти/i];

/* ---- per-record extractors ------------------------------------------- */

/* The langflow run endpoint is versioned and sometimes namespaced by installation:
   /api/v1/run/<flow>, /api/v1/alfi/run/<flow>, … — match the shape, not one literal. */
const LANGFLOW_RUN = /\/api\/v\d+\/(?:[\w.-]+\/)?run\//;
/* The apo flows are called at a different endpoint — /api/v1/flows/<name>/<flowId> — and
   are handed the dialogue itself instead of one input string, then answer inline with the
   http response. Same service, same access log, a different payload at both ends. */
const LANGFLOW_FLOW = /\/api\/v\d+\/flows\//;

/* langflow's access middleware writes a request and its response as two lines:
     [ACCESS] -> Request  POST <path> headers={…} body={…}
     [ACCESS] -> Response POST <path> -> <code> | headers=… | body={…}
   Everything the caller sent and got back is in there, and for the apo endpoint that is
   the only place either one appears in full. */
function extractAccess(msg, app){
  if(app !== 'alfagen-langflow' || msg.lastIndexOf('[ACCESS]', 0) !== 0) return null;
  const m = /->\s*(Request|Response)\s+([A-Z]+)\s+(\S+)(?:\s*->\s*(\d{3}))?/.exec(msg);
  if(!m) return null;
  return {phase: m[1], method: m[2], path: m[3], code: m[4] ? +m[4] : null,
          body: firstJsonAfter(msg, 'body=')};
}

/* findings are written as HTML and get values straight out of the logs */
const escText = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function extractUser(msg, app, raw){
  // langflow's integration log ("[ACCESS] Request") keeps path and body in fields of
  // their own, not in the message — read them as if they were the older one-line form
  if(app === 'alfagen-langflow' && raw && raw.body != null && /^\[ACCESS\] Request$/.test(msg) &&
     LANGFLOW_RUN.test(String(raw.path || ''))){
    msg = '[ACCESS] -> Request ' + (raw.method || 'POST') + ' ' + raw.path + ' body=' + raw.body;
  }
  // langflow access log carries a clean JSON body
  if(app === 'alfagen-langflow' && LANGFLOW_RUN.test(msg)){
    const raw = firstJsonAfter(msg, 'body=');
    const o = safeJson(raw);
    if(o && o.input_value){
      // async (queue-keeper) stack nests the client profile under tweaks and the
      // channel under comod; the direct stack puts both at the top level
      const md = Object.assign({}, ((o.tweaks || {})['Chat Input Metadata'] || {}).metadata || {},
                               (o.metadata && typeof o.metadata === 'object') ? o.metadata : {});
      const cm = o.comod || {};
      const u = {text: o.input_value, session: o.session_id,
                 cus: o.customer_id || cm.cus || md.cus || md.cardOwnerId,
                 channel: o.source_channel_id || cm.source_channel_id || md.channelApp,
                 os: o.operation_system || md.operationSystem,
                 segment: o.segment || md.segment};
      const ctx = ctxFrom(md);
      if(!ctx.cus && u.cus) ctx.cus = u.cus;
      const sc = o.source_channel_id || cm.source_channel_id;
      if(sc) ctx.sourceChannel = sc;
      if(Object.keys(ctx).length) u.ctx = ctx;
      return u;
    }
    // response-shaped access log: question sits in outputs[].inputs.input_value
    if(o && Array.isArray(o.outputs) && o.outputs[0] && o.outputs[0].inputs && o.outputs[0].inputs.input_value){
      return {text: o.outputs[0].inputs.input_value, session: o.session_id};
    }
    // body is frequently truncated mid-JSON, so parse fails — dig the value out directly
    const iv = /"input_value"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(msg);
    if(iv && iv[1].trim()){
      const sid = /"session_id"\s*:\s*"([^"]*)"/.exec(msg);
      return {text: unesc(iv[1]), session: sid && sid[1]};
    }
  }
  // the apo endpoint is given the conversation, not one string: {customerId, history:[…]}.
  // What was asked is the last thing the customer said in it.
  if(app === 'alfagen-langflow' && LANGFLOW_FLOW.test(msg)){
    const ac = extractAccess(msg, app);
    const o = (ac && ac.phase === 'Request') ? safeJson(ac.body) : null;
    const hist = o && Array.isArray(o.history) ? o.history.filter(h => h && h.text) : null;
    if(hist && hist.length){
      const said = hist.filter(h => String(h.party || '').toUpperCase() === 'CUSTOMER');
      const last = (said.length ? said : hist)[said.length ? said.length - 1 : hist.length - 1];
      return {text: String(last.text), cus: o.customerId, session: last.sessionId,
              messageId: last.messageId, via: 'endpoint ' + ac.path};
    }
  }
  // Some dumps have no access log at all — then the only full copy of the question is
  // langflow's run summary, "Run outputs: inputs={'input_value': '…'}". That record is
  // written when the flow finishes, so the event is anchored to the start of the trace.
  if(app === 'alfagen-langflow' && msg.lastIndexOf('Run outputs:', 0) === 0){
    const i = msg.indexOf("'input_value'");
    if(i >= 0){
      let j = i + "'input_value'".length;
      while(j < msg.length && msg[j] !== "'" && msg[j] !== '"') j++;
      const str = pyString(msg, j);
      if(str && str.text.trim()) return {text: str.text, atStart: true, fallback: true};
    }
  }
  // the third-party client's own hand-off, ahead of everything langflow says
  if(app.indexOf('comod-adapter') >= 0){
    const cm = extractComod(msg);
    if(cm) return cm;
  }
  if(app === 'alfagen-compliance-api'){
    const m = /body:([\s\S]+)$/.exec(msg);
    if(m) return {text: m[1].trim()};
  }
  if(app === 'alfagen-strategy-api' && msg.indexOf('Request to LangFlow:') >= 0){
    const t = /inputValue=([\s\S]*?), sessionId=/.exec(msg);
    const s = /sessionId=([^,\]]+)/.exec(msg);
    const c = /customerId=([^,\]]+)/.exec(msg);
    const ch = /sourceChannelId=([^,\]]+)/.exec(msg);
    if(t) return {text: t[1], session: s && s[1], cus: c && c[1], channel: ch && ch[1]};
  }
  return null;
}

function extractContext(msg){
  const out = {};
  // one line or laid out over several — the separators are whitespace either way; values
  // with Cyrillic arrive as octal-escaped UTF-8 bytes (\320\225…)
  const grab = k => {
    const re = new RegExp('key:\\s*"' + k + '"\\s*value\\s*\\{\\s*string_value:\\s*"((?:[^"\\\\]|\\\\.)*)"');
    const m = re.exec(msg);
    return m ? protoUnescape(m[1]) : null;
  };
  CTX_KEYS.concat(['messageNum']).forEach(k => { const v = grab(k); if(v && !/^\*+$/.test(v)) out[k] = v; });
  const sc = grab('source_channel_id') || grab('sourceChannelId');
  if(sc) out.sourceChannel = sc;
  if(out.channelApp || out.firstName || out.mobileUserRole) out.profileSeen = true;
  return Object.keys(out).length ? out : null;
}
/* the client-profile fields every extractor copies into meta.ctx */
const CTX_KEYS = ['cus','channelApp','deviceModel','segment','operationSystem','mobileUserRole','am_version',
                  'firstName','lastName','middleName','nickname','selectedSkill','selectedChip','bot_feature'];
function ctxFrom(md, into){
  const ctx = into || {};
  // the whole client profile was in view: a skill or chip missing from it was not chosen,
  // rather than not logged
  if(md && typeof md === 'object' && (md.channelApp || md.firstName || md.mobileUserRole || md.segment)) ctx.profileSeen = true;
  if(md && typeof md === 'object') CTX_KEYS.forEach(k => {
    const v = md[k];
    if(v != null && v !== '' && typeof v !== 'object' && !/^\*MASKED|^\*+$/.test(String(v))) ctx[k] = String(v);
  });
  return ctx;
}
/* protobuf text escapes: octal UTF-8 bytes, \n, \", \\ */
function protoUnescape(s){
  s = String(s);
  if(s.indexOf('\\') < 0) return s;
  const bytes = [];
  for(let i = 0; i < s.length; i++){
    const c = s[i];
    if(c === '\\' && i + 1 < s.length){
      const o = /^[0-3][0-7]{2}/.exec(s.slice(i + 1, i + 4));
      if(o){ bytes.push(parseInt(o[0], 8)); i += 3; continue; }
      const n = s[i + 1];
      bytes.push((n === 'n' ? 10 : n === 't' ? 9 : n === 'r' ? 13 : n.charCodeAt(0)) & 0xff);
      i++; continue;
    }
    const code = c.charCodeAt(0);
    if(code < 128) bytes.push(code);
    else { const e = unescape(encodeURIComponent(c)); for(let k = 0; k < e.length; k++) bytes.push(e.charCodeAt(k)); }
  }
  try { return new TextDecoder('utf-8').decode(new Uint8Array(bytes)); } catch(e){ return s; }
}

/* java-functions-service: "Answer is ready with messageId=X: payload { ... }" */
function extractLlmTurn(msg){
  const idm = /Answer is ready with messageId=([^:\s]+):/.exec(msg);
  if(!idm) return null;
  const out = {messageId: idm[1], toolCalls: [], content: '', finish: null, usage: {}};

  const model = /model \{ value: "([^"]+)" \}/.exec(msg);
  if(model) out.model = model[1];

  const cm = /content \{ value: "((?:[^"\\]|\\[\s\S])*)" \}/.exec(msg);
  if(cm) out.content = unesc(cm[1]);

  const fr = /finish_reason \{ value: "([^"]+)" \}/.exec(msg);
  if(fr) out.finish = fr[1];

  const re = /function \{ name \{ value: "([^"]+)" \} arguments \{ value: "((?:[^"\\]|\\[\s\S])*)" \} \}/g;
  let m;
  while((m = re.exec(msg))){
    out.toolCalls.push({name: m[1], args: unesc(m[2])});
  }
  ['prompt_tokens','completion_tokens','total_tokens'].forEach(k => {
    const t = new RegExp(k + ' \\{ value: (\\d+) \\}').exec(msg);
    if(t) out.usage[k] = +t[1];
  });
  return out;
}

/* Read one Python-repr string literal starting at the quote under `at`. */
function pyString(s, at){
  const q = s[at];
  if(q !== "'" && q !== '"') return null;
  let out = '', i = at + 1;
  const ESC = {n: '\n', t: '\t', r: '\r', '0': '\0'};
  while(i < s.length){
    const c = s[i];
    if(c === '\\'){
      const n = s[i + 1];
      if(n === 'x' || n === 'u' || n === 'U'){
        const len = n === 'x' ? 2 : (n === 'u' ? 4 : 8);
        const hex = s.substr(i + 2, len);
        if(/^[0-9a-fA-F]+$/.test(hex)){ out += String.fromCodePoint(parseInt(hex, 16)); i += 2 + len; continue; }
      }
      out += (ESC[n] != null ? ESC[n] : n);
      i += 2; continue;
    }
    if(c === q) return {text: out, end: i};
    out += c; i++;
  }
  return {text: out, end: s.length};   // record cut by Kibana — keep what we read
}

/* langflow's "Спросить LLM" component logs every model turn on both sides:
     [ASK LLM] Request  | model=… | headers: {…} | body: {…}
     [ASK LLM] Response | model=… | total_tokens=N | headers: {…} | body: {…}
   The body is a Python repr, not JSON, so the generation text is read as a Python
   string. This is the only LLM trace the async (queue-keeper) stack leaves — there
   is no java-functions-service "Answer is ready" record there. */
function extractAskLlm(msg){
  const m = /^\[ASK LLM\]\s*(Request|Response)\s*\|/.exec(msg);
  if(!m) return null;
  const out = {phase: m[1], toolCalls: [], content: '', finish: null, usage: {}};

  const model = /\|\s*model=([^|]+?)\s*(?:\||$)/.exec(msg);
  if(model) out.model = model[1];
  const id = /'messageId':\s*'([^']+)'/.exec(msg);
  if(id) out.messageId = id[1];
  if(out.phase === 'Request') return out;

  ['prompt_tokens','completion_tokens','total_tokens'].forEach(k => {
    const t = new RegExp("'" + k + "':\\s*(\\d+)").exec(msg);
    if(t) out.usage[k] = +t[1];
  });
  const gi = msg.indexOf("'generations'");
  if(gi >= 0){
    const ci = msg.indexOf("'content'", gi);
    if(ci >= 0){
      let j = ci + "'content'".length;
      while(j < msg.length && msg[j] !== "'" && msg[j] !== '"') j++;
      const str = pyString(msg, j);
      if(str) out.content = str.text;
    }
  }
  return out;
}

/* Identity of a model turn, for matching the same turn logged by two services. The two
   records are masked independently ("26248" vs "*MASKED_CURRENCY*"), so digits and
   masks collapse to the same placeholder before comparing, and the two services also
   escape newlines differently, so backslash escapes are flattened too. */
function turnKey(s){
  return String(s == null ? '' : s)
    .replace(/\\+[nrt]/g, ' ').replace(/\\+/g, '')
    .replace(/\*MASKED_[A-Z_]+\*/g, '#').replace(/\d+/g, '#').replace(/#+/g, '#')
    .replace(/\s+/g, ' ').trim().slice(0, 300);
}

/* llm-integration-service mirrors the raw provider answer:
     [messageId=…] [additionalTags=[…]] Rest response from LLM: {"model":…,"choices":[…]}
   It is JSON, but masking rewrites numbers inside strings ("00:00:*MASKED_CURRENCY*"),
   which breaks JSON.parse on perfectly good records — so read the fields directly.
   This is the only model log some dumps carry: no langflow, no java-functions. */
function extractRestLlm(msg){
  const i = msg.indexOf('Rest response from LLM:');
  if(i < 0) return null;
  const out = {toolCalls: [], content: '', finish: null, usage: {}};

  const id = /\[messageId=([^\]\s]+)\]/.exec(msg);
  if(id) out.messageId = id[1];
  const model = /"model"\s*:\s*"([^"]+)"/.exec(msg);
  if(model) out.model = model[1];
  const fr = /"finish_reason"\s*:\s*"([^"]+)"/.exec(msg);
  if(fr) out.finish = fr[1];
  ['prompt_tokens','completion_tokens','total_tokens'].forEach(k => {
    const t = new RegExp('"' + k + '"\\s*:\\s*(\\d+)').exec(msg);
    if(t) out.usage[k] = +t[1];
  });

  const mi = msg.indexOf('"message"', i);
  if(mi >= 0){
    const ci = msg.indexOf('"content"', mi);
    if(ci >= 0){
      let j = ci + '"content"'.length;
      while(j < msg.length && msg[j] !== '"' && msg[j] !== 'n') j++;   // "…" or null
      if(msg[j] === '"'){
        const s = pyString(msg, j);
        if(s) out.content = s.text;
      }
    }
  }
  const re = /"name"\s*:\s*"([\w.\-]+)"\s*,\s*"arguments"\s*:\s*"/g;
  re.lastIndex = i;
  let m;
  while((m = re.exec(msg))){
    const s = pyString(msg, re.lastIndex - 1);
    out.toolCalls.push({name: m[1], args: s ? s.text : ''});
    if(s) re.lastIndex = s.end + 1;
  }
  return out;
}

/* Classify an LLM turn by the shape of what it produced. */
function classifyTurn(turn){
  if(turn.toolCalls.length) return {role: 'Решение вызвать инструмент', tag: 'call'};
  const o = safeJson(turn.content);
  if(o && typeof o === 'object'){
    if('route' in o && 'steps' in o) return {role: 'План маршрутизации', tag: 'plan', data: o};
    if('approved' in o || 'is_safe' in o) return {role: 'Проверка безопасности', tag: 'guard', data: o};
    if('query' in o && 'decision' in o) return {role: 'Переформулировка запроса', tag: 'reform', data: o};
    return {role: 'Структурированный вывод', tag: 'json', data: o};
  }
  return {role: 'Текстовый ответ', tag: 'text'};
}

/* MCP adapter lines */
function extractMcp(msg){
  const method = /MCP_METHOD:\s*([\w\/]+)/.exec(msg);
  const hasTool = /(?:^|,\s*)TOOL:\s*([\w.\-]+)/.exec(msg);
  if(!method && !hasTool) return null;

  const out = {method: method ? method[1] : null, tool: hasTool ? hasTool[1] : null};

  const pi = msg.indexOf('PARAMETERS:');
  if(pi >= 0){
    let j = pi + 'PARAMETERS:'.length;
    while(j < msg.length && msg[j] !== '{' && msg[j] !== '[') j++;
    const b = balanced(msg, j);
    if(b) out.params = b.text;
  }
  const ri = msg.indexOf('RESULT:');
  if(ri >= 0){
    let j = ri + 'RESULT:'.length;
    while(j < msg.length && msg[j] !== '{' && msg[j] !== '[') j++;
    const b = balanced(msg, j);
    out.result = b ? b.text : msg.slice(ri + 7).trim();
  }
  const d = /(?:^|,\s*)DURATION_MS:\s*([\d.]+)/.exec(msg);
  if(d) out.ms = +d[1];
  const ad = /ALFADIRECT_DURATION_MS:\s*([\d.]+)/.exec(msg);
  if(ad) out.upstreamMs = +ad[1];
  const st = /HTTP_STATUS:\s*(\d+)/.exec(msg);
  if(st) out.status = +st[1];
  // a failed call has no RESULT at all — what it has instead is the verdict
  const code = /(?:^|,\s*)CODE:\s*([A-Z_]+)/.exec(msg);
  if(code) out.code = code[1];
  const sc = /STATUS_CODE:\s*(\d+)/.exec(msg);
  if(sc) out.statusCode = +sc[1];
  const rtr = /RETRYABLE:\s*(\w+)/.exec(msg);
  if(rtr) out.retryable = rtr[1];
  out.failed = !!(out.code || out.statusCode >= 400);

  out.isCall = !!(out.result || (out.method === 'tool/call'));
  out.isHandshake = !out.tool && !!out.method;
  return out;
}

/* A record from a core service the MCP server called: the service in appName, the .NET
   logger in category, the structured payload flattened into data.*, and one requestId
   per incoming HTTP request — that id is what makes hundreds of TRACE lines one hop. */
function coreRecord(l){
  const svc = l.appName || l.systemCode;
  if(!svc || !l.category) return null;
  return {svc: String(svc), cat: String(l.category), req: l.requestId || null,
          path: l['data.RequestPath'] || l['data.requestPath.Value'] || null};
}

/* .NET times things two ways: a TimeSpan ("00:00:00.0003768") and plain milliseconds */
function spanMs(v){
  if(v == null || v === '') return null;
  const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(String(v).trim());
  if(m) return ((+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3])) * 1000;
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
}

/* The orchestrator that stands between a client and the agent flows. It classifies the
   message, picks one flow, and — when that flow answers with an error — picks another.
   Every step is one line of its own, so parse them apart and let buildOne assemble the
   attempt they describe. */
function extractRoute(msg){
  const kv = s => {
    const out = {};
    const re = /([\w.]+)=('[^']*'|\S+)/g;
    let m;
    while((m = re.exec(s))) out[m[1]] = m[2].replace(/^'|'$/g, '');
    return out;
  };
  if(msg.lastIndexOf('Запрос маршрутизации принят', 0) === 0) return {kind: 'start'};
  if(msg.lastIndexOf('Запрос маршрутизации обработан', 0) === 0) return {kind: 'end'};
  const send = /^Отправка запроса агенту:\s*agent=(\S+)/.exec(msg);
  if(send) return {kind: 'send', agent: send[1]};
  const post = /^Выполняется POST-запрос:\s*url=(\S+)/.exec(msg);
  if(post) return {kind: 'post', url: post[1]};
  if(msg.lastIndexOf('Роутинг:', 0) === 0) return {kind: 'decision', data: kv(msg.slice(8))};
  if(msg.lastIndexOf('Эвристика завершена:', 0) === 0) return {kind: 'heuristic', data: kv(msg.slice(20))};
  if(msg.lastIndexOf('Failed-agent redirect:', 0) === 0) return {kind: 'redirect', data: kv(msg.slice(22))};
  if(msg.lastIndexOf('Нормализация:', 0) === 0){
    // business=('invest',) social=() … — the tuple keeps its parentheses
    const b = /business=\(([^)]*)\)/.exec(msg);
    return {kind: 'norm', domains: b ? b[1].replace(/['\s]/g, '').replace(/,$/, '') : ''};
  }
  return null;
}

/* The message as the third-party client handed it over: the question, who asked it, and
   which skill the client had already picked for them. This record opens the trace, so it
   dates the question better than langflow's copy and carries context nothing else has. */
function extractComod(msg){
  if(msg.lastIndexOf('Inbound COMOD request received', 0) !== 0) return null;
  const raw = firstJsonAfter(msg, 'received');
  // COMOD masks its timestamps into runs of asterisks, which no JSON parser survives.
  // The repair only touches a bare run standing where a number belongs, never text in
  // quotes, so markdown in the message itself is left alone.
  const o = safeJson(raw) || safeJson(String(raw || '').replace(/:\s*\*{2,}[\d.\s*]*(?=\s*[,}\]])/g, ': 0'));
  const items = o && (o.COMOD2AGENTHUB || o.comod2agenthub);
  if(!Array.isArray(items)) return null;
  const of = type => (items.find(x => x && x.type === type) || {}).body || null;
  const cm = of('comod') || {};
  const md = of('metadata') || {};
  // the question travels as an assembly, same shape as the answer does on the way back
  let text = null;
  items.forEach(x => {
    if(text || !x || x.type !== 'assembly' || !Array.isArray(x.children)) return;
    const node = x.children.find(c => c && c.body && c.body.text);
    if(node) text = String(node.body.text);
  });
  if(!text) return null;

  const ctx = ctxFrom(md);
  if(cm.source_channel_id) ctx.sourceChannel = cm.source_channel_id;
  const via = [cm.source_channel_id, md.channelApp,
               md.selectedSkill ? 'скилл ' + md.selectedSkill : null,
               md.selectedChip ? 'чип ' + md.selectedChip : null]
    .filter(Boolean).join(' · ');
  return {text: text, cus: cm.cus || md.cus, session: cm.sessionId,
          channel: cm.source_channel_id || md.channelApp,
          messageId: cm.messageId, via: via, ctx: Object.keys(ctx).length ? ctx : null};
}

/* A dozen calls of one tool in a row are told apart only by what was asked, so put the
   scalar arguments on the row itself and leave the rest to the fold. */
function argPreview(json){
  const o = safeJson(json);
  if(!o || typeof o !== 'object' || Array.isArray(o)) return '';
  const parts = [];
  Object.keys(o).forEach(k => {
    const v = o[k];
    if(parts.length >= 2 || v == null || typeof v === 'object') return;
    if(v === false || v === '') return;          // defaults say nothing about the call
    parts.push(k + '=' + String(v).slice(0, 60));
  });
  return parts.join(', ');
}

/* langflow's MCP transport log. It is the only record of a call to a server that answers
   through the java gateway — that hop starts a new trace, so the server's own logs land
   under a trace id of their own and never join this one.
     [MCP -> {http}] | Request  | <tool> | headers={…} | body={"method":"tools/call",…}
     [MCP -> {http}] | Response | <tool> | body={…}
   The component logs its own Request line for the same call with the bare arguments in
   `body`; only the transport one states the method, which is how the two are told apart. */
function extractMcpHttp(msg){
  if(msg.lastIndexOf('[MCP -> {http}]', 0) !== 0) return null;
  const m = /^\[MCP -> \{http\}\]\s*\|\s*(Request|Response)\s*\|\s*([\w.\-\/]+)\s*\|/.exec(msg);
  if(!m) return null;
  const phase = m[1], name = m[2];
  // tools/list and the other protocol methods are not tool calls
  if(name.indexOf('/') >= 0) return {phase: phase, method: name, protocol: true};
  const body = firstJsonAfter(msg, '| body=');
  if(phase === 'Request'){
    const o = safeJson(body);
    if(!o || !o.method) return null;             // the component's copy, without the call
    const args = o.params && o.params.arguments;
    return {phase: phase, name: name, args: args ? JSON.stringify(args) : '{}'};
  }
  return {phase: phase, name: name, result: body,
          isError: /"isError"\s*:\s*true/.test(String(body || ''))};
}

/* langflow: "[TOOL] | Request|Response | name | headers={...} | body=..." */
function extractSubAgent(msg){
  const m = /\[TOOL\]\s*\|\s*(Request|Response)\s*\|\s*([\w.\-]+)\s*\|/.exec(msg);
  if(!m) return null;
  const out = {phase: m[1], name: m[2]};
  const h = firstJsonAfter(msg, 'headers=');
  const ho = safeJson(h);
  if(ho){
    out.runId = ho.run_id; out.parentRunId = ho.parent_run_id; out.status = ho.status;
    // metadata tells the two apart: server_name = a real MCP tool, display_name = a flow
    // component, i.e. a sub-agent wearing a tool's clothes
    const md = ho.metadata || {};
    if(md.server_name){ out.mcp = true; out.server = md.server_name; }
    else if(md.display_name) out.mcp = false;
    // a Response states its own window, which beats pairing it with a Request record
    if(ho.start_time && ho.finish_time){
      const a = new Date(ho.start_time), b = new Date(ho.finish_time);
      if(!isNaN(a) && !isNaN(b)){ out.startTs = a.getTime(); out.endTs = b.getTime(); out.ms = b - a; }
    }
  }
  const bi = msg.indexOf('| body=');
  if(bi >= 0) out.body = msg.slice(bi + 7).trim();
  return out;
}

function extractRag(msg){
  if(msg.indexOf('[RAG') < 0 && msg.indexOf('чанк') < 0 && msg.indexOf('/chunks') < 0) return null;
  const out = {};
  const q = /Запрос к ARAG:\s*system_id=([\w\-]+),\s*query_len=(\d+),\s*filters=(.+)$/.exec(msg);
  if(q){ out.kind = 'request'; out.systemId = q[1]; out.queryLen = +q[2]; out.filters = q[3]; }
  const got = /Получено\s+(\d+)\s+чанк/.exec(msg);
  if(got){ out.kind = 'response'; out.chunks = +got[1]; }
  const cr = /Chunks request with request=/.exec(msg);
  if(cr){
    out.kind = 'gateway';
    const qq = /'query':\s*'([^']*)'/.exec(msg);
    if(qq) out.query = qq[1];
  }
  return Object.keys(out).length ? out : null;
}

function extractAvailableTools(msg){
  if(msg.indexOf('update_tools') < 0 && msg.indexOf('сохранены в кэш') < 0) return null;
  const srv = /server=([\w\-]+)/.exec(msg);
  const li = msg.indexOf("tools=[");
  if(li < 0) return null;
  const b = balanced(msg, li + 6);
  if(!b) return null;
  const names = [];
  const re = /'([\w.\-]+)'|"([\w.\-]+)"/g;
  let m;
  while((m = re.exec(b.text))) names.push(m[1] || m[2]);
  if(!names.length) return null;
  return {server: srv ? srv[1] : 'mcp', tools: names};
}

/* The tool set handed to one model turn. Logged twice in two shapes:
     tools=[FunctionTool[type=function, function=Function[description=…, name=X, parameters={…}…
     "tools":[{"type":"function","function":{"description":"…","name":"X","parameters":{…}…
   Both put the name immediately before "parameters", and that pair is what we anchor on —
   a bare name= would also hit names mentioned inside a description. */
function extractOfferedTools(msg){
  const i = msg.indexOf('tools=[FunctionTool');
  const j = msg.indexOf('"tools":[{');
  const at = (i >= 0 && (j < 0 || i < j)) ? i : j;
  if(at < 0) return null;
  const re = /"name"\s*:\s*"([\w.\-]+)"\s*,\s*"parameters"|name=([\w.\-]+),\s*parameters=/g;
  re.lastIndex = at;
  const names = [];
  let m;
  while((m = re.exec(msg))){
    const n = m[1] || m[2];
    if(names.indexOf(n) < 0) names.push(n);
  }
  if(!names.length) return null;
  // Kibana cuts a record at ~6 KB, often mid-list. If the array never closes, what we
  // read is a prefix of the real tool set — say so instead of pretending it is complete.
  const java = (at === i);
  const closed = java ? msg.indexOf('strict=false]]]', at) >= 0
                      : msg.indexOf('"strict":false}}]', at) >= 0;
  const id = /messageId=([0-9a-fA-F\-]{16,})/.exec(msg);
  return {messageId: id ? id[1] : null, tools: names, partial: !closed};
}

/* langflow prints every tool it binds to a component:
     StructuredTool(name='X', description=…, args_schema=<class '…InputSchema'>, metadata={'server_name': …}
   The mcp.util schema marks a real MCP tool, langflow.io.schema marks a flow component —
   that is, a sub-agent wearing a tool's clothes. */
function extractToolKinds(msg){
  if(msg.indexOf('StructuredTool(name=') < 0) return null;
  const out = [];
  msg.split('StructuredTool(').slice(1).forEach(chunk => {
    const nm = /^name='([\w.\-]+)'/.exec(chunk);
    const sch = /args_schema=<class '([^']+)'/.exec(chunk);
    if(!nm || !sch) return;
    const srv = /'server_name':\s*'([\w.\-]+)'/.exec(chunk);
    out.push({name: nm[1], mcp: sch[1].indexOf('mcp') >= 0, server: srv ? srv[1] : null});
  });
  return out.length ? out : null;
}

function extractFinalAnswer(msg, app){
  // the apo endpoint answers inline: the body the caller got back is the answer, next to
  // the agent that wrote it. A 200 here is also the delivery — there is no channel hop.
  const ac = extractAccess(msg, app);
  if(ac && ac.phase === 'Response' && ac.code === 200){
    const o = safeJson(ac.body);
    if(o && typeof o.answer === 'string' && o.answer.trim()){
      return {text: o.answer, delivered: true,
              via: 'HTTP 200' + (o.agent ? ' · агент ' + o.agent : '') +
                   (o.messageType ? ' · ' + o.messageType : '')};
    }
  }
  if(app === 'alfagen-strategy-api' && msg.indexOf('Request to LangFlow succeeded') >= 0){
    const m = /LangFlowResponse\[sessionId=([^,]*), text=([\s\S]*)\]\s*$/.exec(msg);
    if(m) return {session: m[1], text: m[2]};
  }
  // async stack, callback flavour: langflow reports every bubble back to queue-keeper
  // ("AI Flow callback received … type='ADD_MESSAGE', requestBody='{…assembly…}'"). The
  // "thinking" bubbles are type intermediate; the answer is the one with real content.
  if(msg.indexOf('AI Flow callback received') === 0 && msg.indexOf("type='ADD_MESSAGE'") >= 0){
    const at = msg.indexOf('{"type":"assembly"');
    if(at < 0) return null;
    const txt = balanced(msg, at).text;
    if(!/"type"\s*:\s*"(message|asset|lineChart)"/.test(txt)) return null;
    const id = /messageId='([^']*)'/.exec(msg);
    const s = /sessionId='([^']*)'/.exec(msg);
    return {session: s && s[1], messageId: id && id[1], text: txt};
  }
  // async stack: comod-adapter posts the answer to the channel. The same call carries
  // intermediate "thinking" bubbles too — only status REPLY is the real answer.
  if((msg.indexOf('COMOD answer send request') >= 0 ||
      msg.indexOf('Success sent answer for comod') >= 0) &&
     /"status"\s*:\s*"REPLY"/.test(msg)){
    const at = msg.indexOf('{"type":"assembly"');
    if(at < 0) return null;
    const id = /messageId='([^']*)'/.exec(msg);
    const s = /"sessionId"\s*:\s*"([^"]*)"/.exec(msg);
    // the same envelope carries the client profile — the only place it appears when the
    // langflow access log is missing from the dump
    const md = safeJson(firstJsonAfter(msg, '{"type":"metadata","body":')) || {};
    const ctx = ctxFrom(md);
    const cus = /"cus"\s*:\s*"([^"]+)"/.exec(msg);
    if(!ctx.cus && cus) ctx.cus = cus[1];
    return {session: s && s[1], messageId: id && id[1], text: balanced(msg, at).text,
            ctx: Object.keys(ctx).length ? ctx : null};
  }
  return null;
}

/* Answers now arrive as a structured "assembly" (message bubbles + chip buttons)
   instead of plain text. Flatten it to what the user actually saw. */
/* Kibana cuts a record at ~6 KB, and an assembly is routinely longer than that, so
   JSON.parse gets nothing. Harvest the bubbles the user saw straight from the text. */
function scrapeAssembly(txt){
  const bubbles = [], chips = [];
  const re = /"type"\s*:\s*"(message|dialogSuggestion|chips)"\s*,\s*"body"\s*:\s*\{\s*"text"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while((m = re.exec(txt))){
    (m[1] === 'message' ? bubbles : chips).push(unesc(m[2]));
  }
  const card = /"type"\s*:\s*"asset"\s*,\s*"body"\s*:\s*\{[^}]*?"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  while((m = card.exec(txt))) bubbles.push('[карточка] ' + unesc(m[1]));
  if(!bubbles.length && !chips.length) return null;
  let out = bubbles.join('\n\n');
  if(chips.length) out += (out ? '\n\n' : '') + 'Кнопки: ' + chips.join(' · ');
  return out;
}

/* The answer split into what it is made of, so the report can tell the words the user
   read apart from the widgets we only *describe* - a chip row, an instrument card.
   Returns null when `txt` is not an assembly at all. Every part keeps the node it came
   from, so the report can show the JSON behind a described element on demand. */
function answerParts(txt, depth){
  depth = depth || 0;
  const o = safeJson(txt);
  if(!(o && o.type === 'assembly' && Array.isArray(o.children))) return null;
  const parts = [], chips = [];
  (function walk(nodes){
    nodes.forEach(n => {
      if(!n || typeof n !== 'object') return;
      if(n.type === 'message' && n.body && n.body.text){
        let t = String(n.body.text);
        // a bubble's text is sometimes itself a serialized assembly - unwrap it
        if(depth < 4 && /"type"\s*:\s*"assembly"/.test(t)) t = humanizeAnswer(t, depth + 1);
        parts.push({kind: 'text', text: t});
      }
      // the chip node was renamed on the AGENTHUB channel; both names are in the wild
      else if((n.type === 'chips' || n.type === 'dialogSuggestion') && n.body && n.body.text){
        chips.push(n);
      }
      // an instrument widget: the user saw a card, not a sentence. Name it, so the
      // answer does not quietly lose a bubble that was on the screen.
      else if(n.type === 'lineChart' && n.body){
        const pts = Array.isArray(n.body.children) ? n.body.children.length : 0;
        const fmt = n.body.yAxis && n.body.yAxis.format && n.body.yAxis.format.currency;
        parts.push({kind: 'chart', node: n,
                    text: [n.body.chartDataType || 'линейный график', pts ? pts + ' точек' : '', fmt || '']
                          .filter(Boolean).join(' · ')});
        return;       // its points are not bubbles
      }
      else if(n.type === 'asset' && n.body && (n.body.title || n.body.subtitle)){
        parts.push({kind: 'asset', node: n,
                    text: [n.body.title, n.body.subtitle].filter(Boolean).join(' · ')});
      }
      if(Array.isArray(n.children)) walk(n.children);
    });
  })(o.children);
  if(chips.length) parts.push({kind: 'chips', node: chips,
                               text: chips.map(c => String(c.body.text)).join(' · ')});
  return parts.length ? parts : null;
}

/* Flatten the parts back to the plain string the rest of the code searches and compares
   on. The bracketed labels mark the two kinds the user did not read as prose. */
function partsToText(parts){
  if(!parts) return '';
  const body = parts.filter(p => p.kind !== 'chips')
    .map(p => p.kind === 'asset' ? '[карточка] ' + p.text : p.kind === 'chart' ? '[график] ' + p.text : p.text).join('\n\n');
  const chips = parts.filter(p => p.kind === 'chips').map(p => p.text).join(' · ');
  return body + (chips ? (body ? '\n\n' : '') + 'Кнопки: ' + chips : '');
}

function humanizeAnswer(txt, depth){
  const parts = answerParts(txt, depth);
  if(!parts){
    if(/"type"\s*:\s*"assembly"/.test(txt)) return scrapeAssembly(txt) || txt;
    return txt;
  }
  return partsToText(parts) || txt;
}

function extractDelivery(msg){
  if(msg.indexOf('Success sent answer') >= 0){
    const s = /sessionId='([^']*)'/.exec(msg);
    const u = /userId='([^']*)'/.exec(msg);
    return {kind: 'sent', session: s && s[1], userId: u && u[1]};
  }
  // newer comod-adapter: "COMOD answer send succeeded [originalMessageId=…, …, httpStatus=200]".
  // One per bubble, thinking ones included — the caller counts only a send made after
  // the final answer was seen.
  if(msg.indexOf('COMOD answer send succeeded') === 0){
    const id = /originalMessageId='([^']*)'/.exec(msg);
    const code = /httpStatus=(\d+)/.exec(msg);
    if(code && !/^2/.test(code[1])) return null;
    const ch = /channel='([^']*)'/.exec(msg);
    return {kind: 'sent', messageId: id && id[1], channel: ch && ch[1], afterAnswer: true};
  }
  // async stack. Fires for every intermediate bubble as well, so the messageId is
  // reported and the caller keeps only the one matching the final answer.
  if(msg.indexOf('COMOD answer sent') >= 0){
    const id = /messageId='([^']*)'/.exec(msg);
    const u = /userId='([^']*)'/.exec(msg);
    const ch = /clientChannel='([^']*)'/.exec(msg);
    return {kind: 'sent', messageId: id && id[1], userId: u && u[1], channel: ch && ch[1]};
  }
  if(msg.indexOf("changed status to 'ANSWERED'") >= 0) return {kind: 'answered'};
  return null;
}

/* The quality pipeline grades a finished conversation in a nightly batch: the collector
   pulls the trace out of langfuse, the arbiter runs the judge over it, the pipeline
   worker publishes whatever came of the verdict. Everything worth reading sits in OTEL
   attributes rather than in the message text, and the whole run happens hours after the
   conversation — so this is a verdict *about* the trace, not a step inside it, and it is
   reported in its own section instead of being spliced into the chronicle. */
const QUALITY_APP = /quality-(collector|arbiter|pipeline-worker)/;

function extractQuality(recs){
  const rows = recs.filter(r => QUALITY_APP.test(r.app) ||
                                (r.raw && r.raw['attributes.langfuse_trace_id'] != null));
  if(!rows.length) return null;
  const at = (r, k) => {
    const v = r.raw ? r.raw['attributes.' + k] : null;
    return (v == null || v === '' || v === 'null') ? null : String(v);
  };
  const q = {records: rows.length, from: rows[0].t, to: rows[rows.length - 1].t, steps: []};
  const keep = (k, v) => { if(v != null) q[k] = v; };
  rows.forEach(r => {
    keep('strategy', at(r, 'evaluation_strategy'));
    keep('kind', at(r, 'evaluation_kind'));
    keep('configVersion', at(r, 'config_version'));
    keep('batchId', at(r, 'batch_id'));
    keep('itemId', at(r, 'pipeline_item_id'));
    keep('arbiterItemId', at(r, 'arbiter_item_id'));
    keep('exampleId', at(r, 'our_example_id'));
    keep('rawScore', at(r, 'raw_score'));
    keep('score', at(r, 'score'));
    // what the pipeline did with the verdict: hand the example to manual labelling, or
    // publish it as a few-shot example on its own
    if(at(r, 'dependency') === 'label-studio'){
      q.humanReview = {task: at(r, 'ls_task_id'), project: at(r, 'project_id'), job: at(r, 'job_id')};
    }
    if(r.msg.indexOf('Auto-accept') >= 0){
      q.autoAccept = {job: at(r, 'job_id'), store: at(r, 'dependency')};
    }
    // an item the arbiter closed without a score was graded by a strategy that does not
    // produce one — a different statement from "the verdict has not been logged yet"
    if(at(r, 'record_type') === 'lifecycle' && r.app.indexOf('arbiter') >= 0 &&
       r.msg.indexOf('обработан') >= 0) q.arbiterDone = true;
    // the http client's own chatter is the trace lookup, not a step of the evaluation
    if(r.logger !== 'httpx' && at(r, 'record_type') != null){
      q.steps.push({ts: r.ts, t: r.t, app: r.app, text: r.msg, type: at(r, 'record_type')});
    }
  });
  return q;
}

/* ---- main build ------------------------------------------------------ */

function buildTraces(fileEntries){
  // Event order always comes from the logs' own @timestamp (see all.sort below).
  // File order/numbering: sort by the real period each file covers (its earliest
  // @timestamp), because the unixtime in the filename is only the download moment
  // and can disagree with the actual log time. Filename unixtime is the fallback.
  fileEntries.forEach(f => {
    let min = Infinity, max = -Infinity;
    (f.logs || []).forEach(l => {
      const t = parseKibanaTs(l['@timestamp'] || l.timestamp);
      if(t){ const ms = t.getTime(); if(ms < min) min = ms; if(ms > max) max = ms; }
    });
    f.logMinTs = min === Infinity ? null : min;
    f.logMaxTs = max === -Infinity ? null : max;
    f.nameKey = fileOrderKey(f.name);
  });
  const ordered = fileEntries.slice().sort((a, b) => {
    if(a.logMinTs != null && b.logMinTs != null) return a.logMinTs - b.logMinTs;
    if(a.logMinTs != null) return -1;
    if(b.logMinTs != null) return 1;
    if(a.nameKey != null && b.nameKey != null) return a.nameKey - b.nameKey;
    if(a.nameKey != null) return -1;
    if(b.nameKey != null) return 1;
    return a.name.localeCompare(b.name);
  });
  ordered.forEach((f, i) => { f.order = i + 1; f.key = f.nameKey; });

  const seen = new Set();
  const all = [];
  ordered.forEach(f => {
    (f.logs || []).forEach((l, idx) => {
      const id = l._id || (f.name + ':' + idx);
      if(seen.has(id)) { f.dupes = (f.dupes || 0) + 1; return; }
      seen.add(id);
      const t = parseKibanaTs(l['@timestamp'] || l.timestamp);
      all.push({raw: l, t: t, ts: t ? t.getTime() : 0, srcFile: f.name,
                app: l.app_id || '', msg: l.message || '',
                // python lowercases its levels and only the records that go through
                // liftRecord get normalized there — the flat ones arrive as written. Fold
                // the casing here so the raw-log filter offers INFO once, not INFO и info.
                level: String(l.level == null ? '' : l.level).toUpperCase(),
                logger: l.logger || l.logger_name || '', traceId: l.traceId || NO_TRACE});
    });
  });
  all.sort((a, b) => a.ts - b.ts);
  linkTraces(all);

  const groups = new Map();
  all.forEach(r => {
    if(!groups.has(r.traceId)) groups.set(r.traceId, []);
    groups.get(r.traceId).push(r);
  });

  const traces = [];
  groups.forEach((recs, traceId) => traces.push(buildOne(traceId, recs)));
  // chronological, so the tab strip reads top-down as a timeline. Records with no
  // traceId are not a conversation at all, so they sit at the bottom whatever their
  // timestamps say.
  traces.sort((a, b) =>
    (a.traceId === NO_TRACE) - (b.traceId === NO_TRACE) ||
    (a.meta.from ? a.meta.from.getTime() : 0) - (b.meta.from ? b.meta.from.getTime() : 0));

  markRetries(traces);

  // the strip is ordered by time, but the trace worth opening first is the substantial
  // one, not whichever happened earliest — keep that as the landing tab
  let active = 0;
  traces.forEach((t, i) => {
    if(t.traceId !== NO_TRACE && t.records.length > traces[active].records.length) active = i;
  });

  return {traces: traces, files: ordered, total: all.length, active: active};
}

/* One user question can be spread over several traceIds, because a few hops start a
   trace of their own instead of continuing the caller's:
     · strategy-api hands the question to langflow ("Request to LangFlow: … sessionId=S")
       and the flow run arrives at langflow as a fresh trace, whose request body carries
       "session_id": "S";
     · every model call langflow makes through the gateway ("[ASK LLM] Request … messageId
       M") runs gateway → transformation → strategy → java-functions → llm-integration
       under a new traceId, and every hop of it logs M.
   Left alone, each of those is a tab of its own with no question and no context — the
   chain the analyst is looking for is cut into pieces. So children are folded into the
   trace that started them (transitively: a model call of a flow run lands in the trace
   of the question). Each record keeps the id it was logged under in origTrace, and the
   trace lists what it was assembled from. */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function linkTraces(all){
  const askParent = new Map();          // messageId of an [ASK LLM] call -> trace that made it
  const flowCalls = [];                 // {session, ts, trace} of "Request to LangFlow"
  const info = new Map();               // trace -> {ids, runs}
  all.forEach(r => {
    if(r.traceId === NO_TRACE) return;
    const m = r.msg;
    let g = info.get(r.traceId);
    if(!g){ g = {ids: new Set(), runs: []}; info.set(r.traceId, g); }
    if(m.indexOf('[ASK LLM] Request') === 0){
      const id = String(r.raw.messageId || (/'messageId':\s*'([^']+)'/.exec(m) || [])[1] || '');
      if(UUID_RE.test(id)) askParent.set(id.toLowerCase(), r.traceId);
      return;
    }
    if(m.indexOf('Request to LangFlow') >= 0){
      const sid = /sessionId=([0-9a-zA-Z-]{12,})/.exec(m);
      if(sid) flowCalls.push({session: sid[1], ts: r.ts, trace: r.traceId});
    }
    if(/^\[ACCESS\] -> Request POST \/api\/v\d+\/run\//.test(m)){
      const sid = /"session_id"\s*:\s*"([^"]+)"/.exec(m);
      if(sid) g.runs.push({session: sid[1], ts: r.ts});
    }
    const own = r.raw.messageId || r.raw.message_id;
    if(own && UUID_RE.test(String(own))) g.ids.add(String(own).toLowerCase());
    const inMsg = /message_?[iI]d\s*[=:]\s*["']?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(m);
    if(inMsg) g.ids.add(inMsg[1].toLowerCase());
  });
  if(!askParent.size && !flowCalls.length) return;

  const parent = new Map();
  info.forEach((g, t) => {
    for(const id of g.ids){
      const p = askParent.get(id);
      if(p && p !== t){ parent.set(t, {to: p, why: 'llm', key: id}); return; }
    }
    for(const run of g.runs){
      let best = null, bd = Infinity;
      flowCalls.forEach(c => {
        if(c.session !== run.session || c.trace === t) return;
        const d = run.ts - c.ts;                  // the run follows the hand-off
        if(d < -2000 || d > 30000) return;
        if(Math.abs(d) < bd){ bd = Math.abs(d); best = c; }
      });
      if(best){ parent.set(t, {to: best.trace, why: 'flow'}); return; }
    }
  });
  if(!parent.size) return;
  const rootOf = t => {
    const seen = new Set();
    while(parent.has(t) && !seen.has(t)){ seen.add(t); t = parent.get(t).to; }
    return t;
  };
  all.forEach(r => {
    const link = parent.get(r.traceId);
    if(!link) return;
    r.origTrace = r.traceId;
    r.linkWhy = link.why;
    if(link.key) r.linkKey = link.key;
    r.traceId = rootOf(r.traceId);
  });
}

/* the traceIds folded into this one by linkTraces, with what each of them was */
function linkedOf(recs, evs){
  const m = new Map();
  recs.forEach(r => {
    if(!r.origTrace) return;
    let g = m.get(r.origTrace);
    if(!g){
      g = {traceId: r.origTrace, why: r.linkWhy, key: r.linkKey || null, count: 0, from: r.ts, what: ''};
      m.set(r.origTrace, g);
    }
    g.count++;
  });
  // a model call is named the way the chronicle names that turn (Проверка безопасности,
  // Переформулировка запроса, …) — found by the messageId both sides carry
  const out = Array.from(m.values());
  out.forEach(g => {
    if(g.why === 'flow'){ g.what = 'запуск флоу в langflow'; return; }
    const ev = (evs || []).find(e => e.kind === 'llm' && e.messageId &&
                                     String(e.messageId).toLowerCase() === g.key);
    g.what = ev ? 'вызов модели: ' + ev.title : 'вызов модели';
  });
  return out.sort((a, b) => a.from - b.from);
}

/* One message sent more than once is not several conversations: a request that was
   turned away gets retried, and every retry opens a trace of its own. sessionId alone
   does not say that — one chat session covers a whole day of unrelated questions, six of
   them in some of these dumps — but sessionId together with messageId names exactly one
   message, so traces sharing both are repeats of it. They stay separate traces, because a
   traceId is what the analyst searches ELK by; they just say so. */
function markRetries(traces){
  const groups = new Map();
  traces.forEach(t => {
    const q = t.userQ || {};
    if(!q.session || !q.messageId) return;
    const key = q.session + ' ' + q.messageId;
    if(!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  });
  const outcome = t => {
    const rej = (t.events || []).filter(e => e.kind === 'reject').pop();
    if(rej) return 'HTTP ' + rej.code;
    return t.finalAnswer ? 'ответ получен' : 'ответа нет';
  };
  groups.forEach(group => {
    if(group.length < 2) return;
    group.sort((a, b) => (a.meta.from ? a.meta.from.getTime() : 0) -
                         (b.meta.from ? b.meta.from.getTime() : 0));
    group.forEach((t, i) => {
      t.retry = {index: i + 1, total: group.length,
                 messageId: (t.userQ || {}).messageId,
                 others: group.filter(x => x !== t)
                   .map(x => ({traceId: x.traceId, from: x.meta.from, outcome: outcome(x)}))};
      const list = t.retry.others.map(o =>
        '<code>' + escText(o.traceId) + '</code>' +
        (o.from ? ' ' + o.from.toLocaleTimeString('ru-RU') : '') + ' — ' + escText(o.outcome)).join(', ');
      t.findings.unshift({level: 'note', text: 'Одно и то же обращение отправлено ' +
        group.length + ' раза: это попытка <b>' + (i + 1) + '</b> из <b>' + group.length +
        '</b> (сообщение <code>' + escText(t.retry.messageId) + '</code>). Остальные: ' + list + '.'});
    });
  });
}

/* tokens spent on one model turn: total_tokens, or its parts when only those were logged */
function tokensOf(e){
  const u = e.usage || {};
  return u.total_tokens || ((u.prompt_tokens || 0) + (u.completion_tokens || 0));
}

/* content-length of what came back over HTTP, over a scoped slice of records.
   MCP: langflow logs every MCP HTTP response as TransportResponse — initialize,
   tools/list and the 202 notification acks included — but writes a ProtocolDiagnostic
   (with the body's first bytes) only for a tools/call result, one per call. So the
   diagnostic is the record that says "this many bytes of tool output". The tool's name
   is not in it: it is taken from the "Response | <tool>" record that follows, matched by
   the start of the result text.
   LLM: httpx logs "HTTP Response: POST …/chat/completions … 'content-length': 'N'" —
   present only on stacks that call the model from langflow directly. */
function sizeKey(s){
  const i = s.indexOf('"text":"');
  return i < 0 ? '' : s.slice(i + 8, i + 400).replace(/\\+/g, '').replace(/[^0-9A-Za-zА-Яа-яЁё]+/g, '').slice(0, 60);
}
/* one entry per tools/call result: bytes on the wire, when, and which tool */
function mcpSizeList(rcs){
  return extractSizes(rcs).mcpList;
}
function extractSizes(rcs){
  const mcp = [], llm = [], resp = [];
  rcs.forEach(r => {
    const m = r.msg || '';
    if(m.indexOf('[MCP -> {http}] | ProtocolDiagnostic') === 0){
      if(!/"result"\s*:\s*\{\s*"content"/.test(m)) return;
      const c = /"content-length"\s*:\s*"(\d+)"/i.exec(m);
      if(!c) return;
      const bp = m.indexOf('body_prefix=');
      mcp.push({bytes: +c[1], ts: r.ts, key: bp >= 0 ? sizeKey(m.slice(bp)) : ''});
    } else if(m.indexOf('[MCP -> {http}] | Response |') === 0){
      const n = /^\[MCP -> \{http\}\] \| Response \| ([^|]+?) \|/.exec(m);
      const bi = m.indexOf('body=');
      resp.push({ts: r.ts, name: n ? n[1].trim() : '', key: bi >= 0 ? sizeKey(m.slice(bi)) : ''});
    } else if(/^HTTP Response: POST \S*chat\/completions/.test(m)){
      const c = /'content-length'\s*:\s*'(\d+)'/i.exec(m);
      if(c) llm.push({bytes: +c[1], ts: r.ts});
    }
  });
  mcp.forEach(x => {
    const near = resp.filter(y => y.ts >= x.ts - 5 && y.ts - x.ts < 120000);
    const hit = near.find(y => x.key && y.key === x.key) || near[0];
    if(hit) x.tool = hit.name;
  });
  const agg = (xs, extra) => {
    const top = xs.reduce((a, x) => (!a || x.bytes > a.bytes) ? x : a, null);
    return {bytes: xs.reduce((a, x) => a + x.bytes, 0), n: xs.length,
            max: top ? Object.assign({bytes: top.bytes, ts: top.ts}, extra(top)) : null};
  };
  const out = {mcp: agg(mcp, x => ({tool: x.tool || ''})), llm: agg(llm, () => ({}))};
  Object.defineProperty(out, 'mcpList', {value: mcp.map(x => ({bytes: x.bytes, ts: x.ts, tool: x.tool || ''})), enumerable: false});
  return out;
}

/* How many tokens each MCP answer put into the model's context — the number the
   "верхний предел ответа MCP" question is about.
   Measured, not guessed, wherever the logs allow it: an agent's next model turn after
   a batch of tool calls carries prompt_tokens = previous prompt + previous completion +
   what the tools returned (+ a few tokens of wrapping). So
       tokens(batch) = prompt(next) − prompt(prev) − completion(prev).
   Turns are grouped by the agent that made them (the sub-agent the call ran under, or
   the orchestrator), and "next" must be a turn of the same growing conversation —
   prompt(next) ≥ prompt(prev) + completion(prev) — which skips the orchestrator's
   side conversations (reformulation, safety check, structured output). A batch of
   several calls is split in proportion to their bytes. A split that implies an absurd
   bytes-per-token ratio means the attribution went wrong (something else landed in the
   context too) and is dropped; those calls fall back to the byte estimate in the UI. */
const BYTES_PER_TOKEN_SANE = [1.2, 8];
function mcpBudget(evs, rcs){
  const sizes = mcpSizeList(rcs).map(x => Object.assign({used: false}, x));
  const calls = evs.filter(e => e.kind === 'mcp' || (e.kind === 'mcpwrap' && e.phase === 'in'));
  const sameTool = (a, b) => !!a && !!b && (a === b || a.slice(-b.length) === b || b.slice(-a.length) === a);
  const bytesOf = new Map();
  calls.forEach(c => {
    let best = null, bd = Infinity;
    sizes.forEach(x => {
      if(x.used || (x.tool && !sameTool(x.tool, c.name))) return;
      const d = Math.abs(x.ts - c.ts);
      if(d < bd){ bd = d; best = x; }
    });
    if(best && bd < 30000){ best.used = true; bytesOf.set(c, best.bytes); }
  });

  const groups = new Map();
  evs.forEach(e => {
    if(!(e.kind === 'llm' && e.usage && e.usage.prompt_tokens) && calls.indexOf(e) < 0) return;
    const g = e.under || '';
    if(!groups.has(g)) groups.set(g, []);
    groups.get(g).push(e);
  });

  const outCalls = [], batches = [], convs = [];
  groups.forEach((list, agent) => {
    list.sort((a, b) => a.ts - b.ts);
    const turns = list.filter(e => e.kind === 'llm');
    const nCalls = list.length - turns.length;
    const conv = {agent: agent, calls: nCalls, base: null,
                  peak: turns.reduce((m, e) => Math.max(m, e.usage.prompt_tokens || 0), 0) || null};
    const ci = convs.length;
    convs.push(conv);
    for(let i = 0; i < list.length; i++){
      if(list[i].kind === 'llm') continue;
      let j = i;
      while(j < list.length && list[j].kind !== 'llm') j++;
      const batch = list.slice(i, j);
      let prev = null;
      for(let k = i - 1; k >= 0; k--) if(list[k].kind === 'llm'){ prev = list[k]; break; }
      const floor = prev ? prev.usage.prompt_tokens + (prev.usage.completion_tokens || 0) : Infinity;
      const next = prev ? list.slice(j).find(e => e.kind === 'llm' && e.usage.prompt_tokens >= floor) : null;
      if(prev && conv.base == null) conv.base = prev.usage.prompt_tokens;
      let bytes = batch.map(c => bytesOf.has(c) ? bytesOf.get(c) : null);
      // a call whose size record is missing takes the average of its siblings of the same
      // tool in this batch (or of the whole batch) — only for splitting the measured total
      const known = bytes.filter(b => b != null);
      const split = bytes.map((b, k) => {
        if(b != null) return b;
        const same = batch.map((c, q) => c.name === batch[k].name ? bytes[q] : null).filter(v => v != null);
        const pool = same.length ? same : known;
        return pool.length ? pool.reduce((a, v) => a + v, 0) / pool.length : null;
      });
      const allBytes = bytes.every(b => b != null);
      const canSplit = split.every(b => b != null);
      const sumBytes = bytes.reduce((a, b) => a + (b || 0), 0);
      const sumSplit = split.reduce((a, b) => a + (b || 0), 0);
      let tokens = next ? next.usage.prompt_tokens - floor : null;
      if(tokens != null && tokens <= 0) tokens = null;
      if(tokens != null && canSplit && sumSplit > 0){
        const r = sumSplit / tokens;
        if(r < BYTES_PER_TOKEN_SANE[0] || r > BYTES_PER_TOKEN_SANE[1]) tokens = null;
        else if(allBytes) batches.push({bytes: sumBytes, tokens: tokens});   // calibration: exact sizes only
      }
      batch.forEach((c, k) => {
        let t = null;
        if(tokens != null){
          if(batch.length === 1) t = tokens;
          else if(canSplit && sumSplit > 0) t = Math.round(tokens * split[k] / sumSplit);
        }
        outCalls.push({tool: c.name || '?', agent: agent, bytes: bytes[k], tokens: t, ts: c.ts, conv: ci});
      });
      i = j - 1;
    }
  });
  return {calls: outCalls, batches: batches, convs: convs};
}

/* verdict + counters over a scoped slice of events/records — run once for the whole
   trace and again per user request, so each request gets its own findings and stats */
function summarize(evs, rcs, ctx){
  // an adapter record is the richest sighting of a call, but not the only one: a server
  // reached through the gateway is seen by langflow alone, and that is still a call
  const mcpCalls = evs.filter(e => e.kind === 'mcp' || (e.kind === 'mcpwrap' && e.phase === 'in'));
  const ragHits = evs.filter(e => e.kind === 'rag' && e.chunks != null);
  const subCalls = evs.filter(e => e.kind === 'subagent' && e.phase === 'in');
  const coreCalls = evs.filter(e => e.kind === 'core');
  const routeEvs = evs.filter(e => e.kind === 'route');
  const rejects = evs.filter(e => e.kind === 'reject');
  const coreDetailed = coreCalls.filter(e => e.detailed);
  const calledSubs = Array.from(new Set(subCalls.map(e => e.name)));
  const calledMcp = Array.from(new Set(mcpCalls.map(e => e.name)));
  const plan = ctx.plan, allAvailable = ctx.allAvailable || [];
  const finalAnswer = ctx.finalAnswer, delivered = ctx.delivered;
  const errs = ctx.errs || [];
  const errTotal = errs.reduce((a, g) => a + g.count, 0);
  const tokEvs = evs.filter(e => e.kind === 'llm' && tokensOf(e) > 0);
  const maxEv = tokEvs.reduce((m, e) => (!m || tokensOf(e) > tokensOf(m)) ? e : m, null);

  const findings = [];
  if(!ctx.userQ) findings.push({level: 'note', text: 'Текст запроса пользователя в этих файлах не найден — возможно, не хватает более ранней страницы выгрузки.'});
  // when the request was turned away at the door, that is the headline: everything below
  // is only describing what did not happen as a consequence
  if(rejects.length){
    const r0 = rejects[rejects.length - 1];
    const why = r0.why
      ? ' — ' + escText(String(r0.why).replace(/\s+/g, ' ').trim().slice(0, 300)) : '';
    findings.push({level: 'warn', text: r0.broke
      ? 'langflow ответил ошибкой: <code>' + escText(r0.meta) + '</code>' + why + '.'
      : 'Запрос отклонён на входе: <code>' + escText(r0.meta) + '</code>' + why + '. Флоу не запускался.'});
  }
  if(routeEvs.length){
    const named = Array.from(new Set(routeEvs.filter(e => e.name).map(e => e.name)));
    const broke = routeEvs.filter(e => !e.name);
    if(named.length > 1 || broke.length){
      findings.push({level: 'warn', text: 'Оркестратор менял маршрут: ' +
        named.map(n => '<code>' + n + '</code>').join(' → ') +
        (broke.length ? ' — предыдущий флоу вернул ошибку.' : '.')});
    } else if(named.length){
      findings.push({level: 'ok', text: 'Оркестратор направил запрос в <code>' + named[0] + '</code>.'});
    }
  }
  if(!mcpCalls.length){
    const rej = rejects.length ? rejects[rejects.length - 1] : null;
    findings.push({level: 'warn', text: rej
      ? (rej.broke ? 'Инструменты не вызывались — запуск оборвался ошибкой раньше.'
                   : 'Инструменты не вызывались — до них дело не дошло, запрос отклонён на входе.')
      : 'Ни одного результативного вызова MCP-инструмента. Агент не дошёл до данных — смотрите маршрутизацию, а не адаптер.'});
  } else {
    findings.push({level: 'ok', text: 'Вызовов MCP-инструментов: <b>' + mcpCalls.length + '</b> (' + calledMcp.map(n => '<code>' + n + '</code>').join(', ') + ').'});
  }
  if(plan){
    const planned = (plan.steps || []).reduce((a, s) => a.concat(s.tools || []), []);
    const missed = planned.filter(t => calledSubs.indexOf(t) < 0);
    if(missed.length){
      findings.push({level: 'warn', text: 'Планировщик назначил ' + planned.map(t => '<code>' + t + '</code>').join(', ') +
        ', но так и не вызваны: ' + missed.map(t => '<code>' + t + '</code>').join(', ') + '.'});
    }
  }
  if(coreCalls.length){
    const svcList = ns => Array.from(new Set(ns.map(e => e.name))).map(s => '<code>' + s + '</code>').join(', ');
    if(coreDetailed.length){
      findings.push({level: 'ok', text: 'Обращений MCP в core-сервисы: <b>' + coreCalls.length +
        '</b>, из них с логами самих сервисов — <b>' + coreDetailed.length + '</b> (' + svcList(coreDetailed) + ').'});
    } else {
      // the analyst is one Kibana query away from seeing the other half of every call
      findings.push({level: 'note', text: 'MCP ходил в core-сервисы (' + svcList(coreCalls) +
        '), но их собственных логов в выгрузке нет' +
        (ctx.userCode ? ' — выгрузите их из ELK core по <code>userCode: "' + ctx.userCode + '"</code>' : '') + '.'});
    }
  }
  if(ragHits.length){
    findings.push({level: 'ok', text: 'RAG отработал: получено чанков — <b>' + ragHits.map(e => e.chunks).join(', ') + '</b>.'});
  } else {
    findings.push({level: 'note', text: 'В RAG агент не ходил.'});
  }
  if(allAvailable.length && calledMcp.length){
    const unused = allAvailable.length - calledMcp.length;
    if(unused > 0) findings.push({level: 'note', text: 'Инструментов было доступно <b>' + allAvailable.length + '</b>, задействован <b>' + calledMcp.length + '</b>.'});
  }
  if(finalAnswer && REFUSAL.some(re => re.test(finalAnswer))){
    findings.push({level: 'warn', text: 'В финальном ответе есть признаки отказа («нет данных», «к сожалению») — пользователь, скорее всего, ушёл ни с чем.'});
  }
  if(errTotal){
    findings.push({level: 'warn', text: 'Записей уровня ERROR/WARN: <b>' + errTotal +
      '</b> в <b>' + errs.length + '</b> различных видах — вынесены в отдельный раздел ниже.'});
  }
  if(delivered) findings.push({level: 'ok', text: ctx.answerVia
    ? 'Ответ отдан вызывающей системе в ответе на запрос (' + escText(ctx.answerVia) + ').'
    : 'Ответ доставлен в чат.'});
  else if(finalAnswer) findings.push({level: 'note', text: 'Подтверждения доставки в bot-conversation-api нет.'});

  return {
    findings: findings,
    calledMcp: calledMcp, calledSubs: calledSubs,
    plannedSubs: plan ? (plan.steps || []).reduce((a, s) => a.concat(s.tools || []), []) : [],
    stats: {
      records: rcs.length,
      mcp: mcpCalls.length,
      core: coreCalls.length,
      rag: ragHits.reduce((a, e) => a + e.chunks, 0),
      llm: evs.filter(e => e.kind === 'llm').length,
      subs: subCalls.length,
      seconds: ctx.seconds,
      tokens: tokEvs.reduce((a, e) => a + tokensOf(e), 0),
      tokIn: tokEvs.reduce((a, e) => a + (e.usage.prompt_tokens || 0), 0),
      tokOut: tokEvs.reduce((a, e) => a + (e.usage.completion_tokens || 0), 0),
      tokTurns: tokEvs.length,
      sizes: extractSizes(rcs),
      tokMax: maxEv ? {tokens: tokensOf(maxEv), tokIn: maxEv.usage.prompt_tokens || 0,
                       tokOut: maxEv.usage.completion_tokens || 0, title: maxEv.title || '',
                       model: maxEv.model || '', rel: maxEv.rel, ts: maxEv.ts} : null
    }
  };
}

function buildOne(traceId, recs){
  const t0 = recs.length ? recs[0].ts : 0;
  const t1 = recs.length ? recs[recs.length - 1].ts : 0;
  const meta = {traceId: traceId, from: recs[0] && recs[0].t, to: recs[recs.length-1] && recs[recs.length-1].t,
                durationMs: t1 - t0};
  const events = [];
  const availableTools = new Map();
  const toolKind = new Map();   // tool name -> {mcp, server}: MCP tool or flow component
  const offered = [];           // tool sets handed to individual model turns
  const spans = [];   // sub-agent [Request..Response] windows, for nesting
  let plan = null, finalAnswer = null, delivered = false, userQ = null, answerMsgId = null;
  let reformQ = null;   // the rephrased question, in case the raw one never got logged
  const userQs = [];
  const userEvOf = new Map();   // question text -> its timeline event, for re-dating
  const seenMsgIds = new Map();

  // pass 1: request/response timing per LLM messageId (start = first sighting, end = "Answer is ready")
  recs.forEach(r => {
    const ids = r.msg.match(/messageId[=:]\s*'?"?([0-9a-fA-F\-]{16,})/g);
    if(!ids) return;
    ids.forEach(chunk => {
      const m = /([0-9a-fA-F\-]{16,})$/.exec(chunk);
      if(!m) return;
      const id = m[1];
      const cur = seenMsgIds.get(id) || {start: r.ts, end: r.ts};
      cur.start = Math.min(cur.start, r.ts);
      cur.end = Math.max(cur.end, r.ts);
      seenMsgIds.set(id, cur);
    });
  });

  // langflow logs a model turn as a Request/Response pair with no shared id, and the
  // calls are sequential, so the pending Request is simply the previous one.
  const askPending = [];
  const askLlmPhase = msg => msg.lastIndexOf('[ASK LLM]', 0) === 0;
  const askLlmTurn = (msg, r) => {
    const a = extractAskLlm(msg);
    if(!a) return null;
    if(a.phase === 'Request'){ askPending.push(r.ts); return null; }
    const start = askPending.length ? askPending.shift() : null;
    if(start != null) a.span = {start: start, end: r.ts};
    return a;
  };

  // MCP calls made over the http transport stand in two records — the Request states the
  // arguments, the Response the result — with nothing tying the two together. Pair them
  // per tool in order of arrival: with several calls of one tool in flight at once that
  // is a pairing by position, so a row's duration is one of the burst's, not provably its.
  const mcpHttpPending = new Map();
  const httpCalls = [];
  const sysCount = new Map();

  recs.forEach(r => {
    const msg = r.msg, app = r.app;

    // --- user question. The same question is reported by several services (merge
    // those), but a genuinely new question text starts a new segment of the trace.
    let u = extractUser(msg, app, r.raw);
    // "Run outputs" only stands in for a missing access log. A flow that calls sub-flows
    // logs one such line per sub-flow, each carrying the internal string that sub-flow was
    // handed — once the real question is known, none of those is a question.
    if(u && u.fallback && userQ) u = null;
    if(u && u.ctx) meta.ctx = Object.assign(meta.ctx || {}, u.ctx);
    if(u && u.text && u.text.trim()){
      const text = u.text.trim();
      const same = userQs.find(q => q.text.trim() === text);
      if(same){
        Object.keys(u).forEach(k => { if(!same[k] && u[k] && k !== 'ts') same[k] = u[k]; });
        if(u.via){ const ev = userEvOf.get(text); if(ev && !ev.meta) ev.meta = u.via; }
        // several services echo the question, some of them only after the answer is out;
        // the earliest sighting is the one closest to when it was actually asked
        if(!u.atStart && r.ts < same.ts){
          same.ts = r.ts;
          const ev = userEvOf.get(text);
          if(ev) ev.ts = r.ts;
        }
      } else {
        // a question recovered from the run summary is dated by the record that closes
        // the run, so put it where it actually happened — at the head of the trace
        const ts = (u.atStart && !userQs.length) ? t0 : r.ts;
        u.ts = ts;
        userQs.push(u);
        if(!userQ) userQ = u;
        const ev = {ts: ts, kind: 'user', depth: 0, chip: 'Запрос', chipClass: 'c-user',
                    title: 'Сообщение пользователя', quote: text, app: app,
                    meta: u.via || (u.atStart ? 'восстановлено из итогов запуска — точное время неизвестно' : ''),
                    qIndex: userQs.length - 1};
        userEvOf.set(text, ev);
        events.push(ev);
      }
    }
    // system_id and the channel travel as plain fields (systemId, systemID, system_id,
    // baggage.clientChannel) on records of many services — count them, the owner wins
    if(r.raw){
      ['systemId', 'systemID', 'system_id', 'system_code'].forEach(k => {
        const v = String(r.raw[k] == null ? '' : r.raw[k]).replace(/;.*$/, '').trim();
        if(v && !/^(unknown|null|none|-|\(empty\))$/i.test(v) && /^[\w.\-]+$/.test(v)) sysCount.set(v, (sysCount.get(v) || 0) + 1);
      });
      const bc = r.raw['baggage.clientChannel'] || r.raw.clientChannel;
      if(bc && /^[A-Z][A-Z0-9_]+$/.test(bc)){ meta.ctx = meta.ctx || {}; if(!meta.ctx.sourceChannel) meta.ctx.sourceChannel = bc; }
    }
    // …or inside the message: clientChannel='UAI_CHAT', 'source_channel_id': 'AIAD_CHAT'
    if(!(meta.ctx && meta.ctx.sourceChannel) && msg.indexOf('hannel') >= 0){
      const ch = /clientChannel='([A-Z][A-Z0-9_]+)'|['"]source_channel_id['"]\s*:\s*['"]([A-Z][A-Z0-9_]+)['"]/.exec(msg);
      if(ch){ meta.ctx = meta.ctx || {}; meta.ctx.sourceChannel = ch[1] || ch[2]; }
    }
    const ctx = (app === 'alfagen-strategy-api' && msg.indexOf('Incoming request') >= 0) ? extractContext(msg) : null;
    // the async entry point names the client by pin only
    if(app.indexOf('comod-adapter') >= 0 && msg.indexOf('Inbound COMOD request received') === 0){
      const pin = /xpin=([A-Z0-9]{4,})/.exec(msg);
      if(pin){ meta.ctx = meta.ctx || {}; if(!meta.ctx.cus) meta.ctx.cus = pin[1]; }
    }
    if(ctx) meta.ctx = Object.assign(meta.ctx || {}, ctx);

    // --- available MCP tools
    const av = extractAvailableTools(msg);
    if(av && !availableTools.has(av.server)) availableTools.set(av.server, av.tools);

    // --- what each tool actually is, and which tools a given model turn was given
    const kinds = extractToolKinds(msg);
    if(kinds) kinds.forEach(k => {
      const prev = toolKind.get(k.name);
      if(!prev) toolKind.set(k.name, k);
      else if(!prev.server && k.server) prev.server = k.server;
    });
    const off = extractOfferedTools(msg);
    if(off) offered.push({ts: r.ts, messageId: off.messageId, tools: off.tools, partial: off.partial});

    // --- LLM turns. Three services log the same turn in three shapes; which of them
    // is present depends on the stack, so read all three and dedupe by content later.
    const src = app === 'alfagen-java-functions-service' ? 'java' :
                askLlmPhase(msg) ? 'ask' :
                msg.indexOf('Rest response from LLM:') >= 0 ? 'rest' : null;
    if(src){
      const turn = src === 'ask' ? askLlmTurn(msg, r) :
                   src === 'rest' ? extractRestLlm(msg) : extractLlmTurn(msg);
      if(turn){
        const cls = classifyTurn(turn);
        const span = src === 'ask' ? turn.span : seenMsgIds.get(turn.messageId);
        const ev = {ts: r.ts, kind: 'llm', depth: 0, chip: 'Модель', chipClass: 'c-llm',
                    title: cls.role, tag: cls.tag, app: app, model: turn.model,
                    usage: turn.usage, finish: turn.finish, messageId: turn.messageId,
                    startTs: span ? span.start : r.ts, ms: span ? (span.end - span.start) : null,
                    src: src, content: turn.content,
                    contentKey: turnKey(turn.content), empty: !String(turn.content || '').trim()};

        if(cls.tag === 'plan'){
          plan = cls.data;
          ev.planData = cls.data;
          const tools = (cls.data.steps || []).reduce((acc, s) => acc.concat(s.tools || []), []);
          ev.planTools = tools;
          ev.meta = 'route=' + (cls.data.route || '?') + (tools.length ? ' · инструменты: ' + tools.join(', ') : '');
          ev.quote = cls.data.reason || '';
          ev.payload = turn.content;
        } else if(cls.tag === 'reform'){
          ev.quote = cls.data.query || '';
          ev.meta = cls.data.decision || '';
          ev.payload = turn.content;
          if(!reformQ && cls.data.query) reformQ = String(cls.data.query).trim();
        } else if(cls.tag === 'guard'){
          const ok = cls.data.approved;
          ev.meta = (ok ? 'пропущено' : 'ЗАБЛОКИРОВАНО') +
                    ' · is_safe=' + cls.data.is_safe + ' · is_relevant=' + cls.data.is_relevant;
          ev.quote = cls.data.comment || '';
          ev.payload = turn.content;
          if(!ok) ev.bad = true;
        } else if(cls.tag === 'call'){
          ev.calls = turn.toolCalls.map(tc => ({name: tc.name, args: tc.args}));
          ev.meta = 'вызывает: ' + ev.calls.map(c => c.name).join(', ');
          ev.depth = 1;
        } else {
          ev.quote = turn.content;
          ev.payload = turn.content.length > 400 ? turn.content : null;
        }
        // langflow does not log the tool calls themselves — a turn with no text is the
        // model handing back tool calls, and the [TOOL] records right after are them
        if(src === 'ask' && ev.empty){
          ev.title = 'Решение вызвать инструмент'; ev.tag = 'call'; ev.depth = 1;
          ev.meta = 'ответ без текста — далее идут вызовы инструментов';
        }
        events.push(ev);
      }
    }

    // --- sub-agent boundaries
    const sa = extractSubAgent(msg);
    if(sa){
      if(sa.mcp != null && !toolKind.has(sa.name)) toolKind.set(sa.name, {name: sa.name, mcp: sa.mcp, server: sa.server || null});
      if(sa.phase === 'Request'){
        // provisional: the call has started, but nothing here says when it ends
        spans.push({name: sa.name, start: r.ts, end: Infinity, runId: sa.runId, open: true});
        events.push({ts: r.ts, kind: 'subagent', phase: 'in', depth: 1, chip: 'Саб-агент', chipClass: 'c-sub',
                     title: 'Вызов ', name: sa.name, app: app,
                     meta: 'вход', payload: sa.body, dedupeKey: 'sub-req:' + sa.name + ':' + sa.runId});
      } else {
        // The Response carries the true window. Trust it over pairing by name: the same
        // sub-agent is called several times in parallel, run ids are sometimes eaten by
        // masking, and a Request record does not always make it into the dump — matching
        // the two by position lands a Request on somebody else's Response and stretches
        // the window over half the trace.
        let sp = spans.filter(s => s.open && s.name === sa.name &&
                                   (sa.runId && s.runId === sa.runId)).pop() ||
                 spans.filter(s => s.open && s.name === sa.name &&
                                   (sa.startTs == null || Math.abs(s.start - sa.startTs) < 1500)).pop();
        if(sa.startTs != null && sa.endTs != null){
          if(sp){ sp.start = sa.startTs; sp.end = sa.endTs; sp.open = false; }
          else spans.push({name: sa.name, start: sa.startTs, end: sa.endTs, runId: sa.runId, open: false});
        } else if(sp){
          sp.end = r.ts; sp.open = false;
        }
        const saFailed = /error|fail/i.test(String(sa.status || ''));
        events.push({ts: r.ts, kind: 'subagent', phase: 'out', depth: 1, chip: 'Саб-агент',
                     chipClass: saFailed ? 'c-err' : 'c-sub',
                     title: 'Ответ ', name: sa.name, app: app, ms: sa.ms,
                     startTs: sa.startTs != null ? sa.startTs : (sp ? sp.start : null),
                     meta: 'статус: ' + (sa.status || '—'),
                     payload: saFailed ? null : sa.body, error: saFailed ? sa.body : null,
                     dedupeKey: 'sub-res:' + sa.name + ':' + sa.runId});
      }
    }

    // --- MCP
    if(app.indexOf('mcp-server') >= 0 || msg.indexOf('MCP_METHOD') >= 0){
      const mc = extractMcp(msg);
      if(mc){
        // Until now a tool that failed left no row at all: the adapter writes RESULT only
        // on success, and every branch below wanted one. The row that says nothing came
        // back is the one worth having.
        if(mc.failed && mc.tool){
          events.push({ts: r.ts, kind: 'mcp', depth: 2, chip: 'MCP', chipClass: 'c-err',
                       title: 'Инструмент ', name: mc.tool, app: app, ms: mc.ms,
                       status: mc.statusCode, params: mc.params, error: msg,
                       meta: ['вызов не удался', mc.code,
                              mc.statusCode ? 'HTTP ' + mc.statusCode : null,
                              mc.retryable ? 'повтор возможен: ' + mc.retryable : null,
                              mc.ms != null ? Math.round(mc.ms) + ' мс' : null].filter(Boolean).join(' · '),
                       dedupeKey: 'mcpfail:' + mc.tool + ':' + r.ts});
        } else if(mc.isCall && mc.result){
          events.push({ts: r.ts, kind: 'mcp', depth: 2, chip: 'MCP', chipClass: 'c-mcp',
                       title: 'Инструмент ', name: mc.tool, app: app,
                       ms: mc.ms, upstreamMs: mc.upstreamMs, status: mc.status,
                       params: mc.params, result: mc.result,
                       meta: (mc.ms != null ? Math.round(mc.ms) + ' мс' : '') +
                             (mc.upstreamMs != null ? ' · апстрим ' + Math.round(mc.upstreamMs) + ' мс' : ''),
                       dedupeKey: 'mcp:' + mc.tool + ':' + r.ts});
        } else if(mc.isHandshake){
          events.push({ts: r.ts, kind: 'sys', depth: 2, chip: 'MCP', chipClass: 'c-sys',
                       title: 'Протокол ', name: mc.method, app: app, minor: true,
                       meta: (mc.ms != null ? Math.round(mc.ms) + ' мс' : '') +
                             (mc.status ? ' · HTTP ' + mc.status : '')});
        }
      }
    }

    // --- MCP through the java gateway, as langflow's transport logged it
    const mh = extractMcpHttp(msg);
    if(mh && !mh.protocol && mh.name){
      if(mh.phase === 'Request'){
        if(!mcpHttpPending.has(mh.name)) mcpHttpPending.set(mh.name, []);
        mcpHttpPending.get(mh.name).push({ts: r.ts, args: mh.args});
      } else {
        const q = mcpHttpPending.get(mh.name);
        const req = (q && q.length) ? q.shift() : null;
        const ms = req ? (r.ts - req.ts) : null;
        httpCalls.push({ts: r.ts, kind: 'mcpwrap', phase: 'in', depth: 2, chip: 'MCP',
                        chipClass: mh.isError ? 'c-err' : 'c-mcp',
                        title: 'Инструмент ', name: mh.name, app: app,
                        startTs: req ? req.ts : r.ts, ms: ms,
                        params: req ? req.args : null,
                        result: mh.isError ? null : mh.result,
                        error: mh.isError ? mh.result : null,
                        meta: [ms != null ? Math.round(ms) + ' мс' : null,
                               req ? argPreview(req.args) : null,
                               'через MCP-шлюз',
                               mh.isError ? 'инструмент вернул ошибку' : null].filter(Boolean).join(' · ')});
      }
    }

    // --- RAG
    const rg = extractRag(msg);
    if(rg){
      if(rg.kind === 'request'){
        events.push({ts: r.ts, kind: 'rag', depth: 2, chip: 'RAG', chipClass: 'c-rag',
                     title: 'Запрос в ARAG', app: app,
                     meta: 'system_id=' + rg.systemId + ' · фильтры: ' + (rg.filters || '—'),
                     dedupeKey: 'rag-req:' + r.ts});
      } else if(rg.kind === 'response'){
        events.push({ts: r.ts, kind: 'rag', depth: 2, chip: 'RAG', chipClass: 'c-rag',
                     title: 'Получено чанков: ' + rg.chunks, app: app, chunks: rg.chunks,
                     dedupeKey: 'rag-res:' + r.ts});
      } else if(rg.kind === 'gateway' && rg.query){
        events.push({ts: r.ts, kind: 'rag', depth: 2, chip: 'RAG', chipClass: 'c-rag',
                     title: 'Поиск по базе знаний', app: app, quote: rg.query,
                     dedupeKey: 'rag-gw:' + r.ts});
      }
    }

    // --- final answer + delivery
    const fa = extractFinalAnswer(msg, app);
    if(fa && fa.ctx) meta.ctx = Object.assign(meta.ctx || {}, fa.ctx);
    if(fa && fa.messageId) meta.messageId = meta.messageId || fa.messageId;
    if(fa && fa.text && fa.text.trim()){
      const faParts = answerParts(fa.text.trim());
      finalAnswer = humanizeAnswer(fa.text.trim()).trim();
      if(fa.messageId) answerMsgId = fa.messageId;
      if(fa.delivered){ delivered = true; meta.answerVia = fa.via || null; }
      events.push({ts: r.ts, kind: 'answer', depth: 0, chip: 'Ответ', chipClass: 'c-ans',
                   title: 'Ответ отдан в сессию', parts: faParts, quote: finalAnswer, app: app, full: true,
                   meta: fa.via || '', deliveredHere: !!fa.delivered});
    }
    const dl = extractDelivery(msg);
    if(dl){
      // the async stack reports a send for every intermediate bubble too — only the
      // one carrying the final answer's messageId is the delivery we care about
      if(dl.kind === 'sent' && dl.messageId && dl.messageId !== answerMsgId){ /* intermediate */ }
      else if(dl.afterAnswer && delivered){ /* already confirmed for this answer */ }
      else if(dl.kind === 'sent'){
        delivered = true;
        meta.userId = dl.userId || meta.userId;
        meta.messageId = meta.messageId || dl.messageId || null;
        events.push({ts: r.ts, kind: 'answer', depth: 0, chip: 'Доставка', chipClass: 'c-ans',
                     title: 'Ответ отправлен пользователю', app: app,
                     meta: dl.userId ? 'userId ' + dl.userId : ''});
      }
    }

    // --- a run that ended at the http layer: 401/403 turned away at the door, or a 500
    // the flow died with. Either way it is the story of the trace, and the access log
    // carries it at level INFO, where the error section below never looks.
    const acc = extractAccess(msg, app);
    if(acc && acc.phase === 'Response' && acc.code >= 400){
      const det = safeJson(acc.body);
      let detail = det && (det.detail || det.message || det.error);
      // langflow reports its own failure as a json string nested inside `detail`
      if(typeof detail === 'string' && detail.trim().charAt(0) === '{'){
        const inner = safeJson(detail);
        if(inner && inner.message) detail = inner.message;
      }
      if(typeof detail !== 'string') detail = null;
      // 4xx never reached the graph; 5xx means it ran and fell over inside
      const broke = acc.code >= 500;
      events.push({ts: r.ts, kind: 'reject', depth: 0, chip: broke ? 'Сбой' : 'Отказ',
                   chipClass: 'c-err', app: app, broke: broke, code: acc.code,
                   title: broke ? 'langflow ответил ошибкой' : 'Запрос отклонён на входе в langflow',
                   meta: acc.method + ' ' + acc.path + ' → ' + acc.code,
                   // not `detail`: that name makes the chronicle add a "что делал сервис"
                   // fold repeating the quote it already shows
                   quote: detail || acc.body || '', why: detail});
    }

    // --- errors
    // python services say WARNING where java says WARN, and langflow lowercases its levels
    const lvl = String(r.level || '').toUpperCase();
    if(lvl === 'ERROR' || lvl === 'FATAL' || lvl.lastIndexOf('WARN', 0) === 0 ||
       (r.raw.exception && r.raw.exception !== '(empty)' && r.raw.exception !== '-')){
      events.push({ts: r.ts, kind: 'error', depth: 0, chip: lvl || 'СБОЙ', chipClass: 'c-err',
                   title: r.logger || app, app: app, quote: msg.slice(0, 600),
                   payload: (r.raw.exception && r.raw.exception !== '(empty)') ? r.raw.exception : null});
    }
  });
  // most frequent first — the flow's own system_id; sub-flows (prompter, finskill…) follow
  meta.systemIds = Array.from(sysCount.entries()).sort((a, b) => b[1] - a[1]).map(e => e[0]);

  // ---- one row per MCP call, whichever of langflow's two logs saw it ----------------
  // The component wrapper ([TOOL]) and the http transport ([MCP -> {http}]) describe the
  // same call from two sides. Where the wrapper spoke, its record is already in the
  // timeline; the transport copy earns a row only where it did not — which is how a call
  // to a server behind the java gateway becomes visible at all.
  const wrapperSeen = events.filter(e => e.kind === 'subagent' || e.kind === 'mcpwrap');
  httpCalls.forEach(h => {
    const twin = wrapperSeen.some(e => e.name === h.name && Math.abs(e.ts - h.ts) < 2000);
    if(!twin) events.push(h);
  });

  // ---- how the request reached a flow ------------------------------------------------
  // A message from a third-party client lands on the orchestrator, which classifies it,
  // picks one agent flow and forwards it there; if that flow answers with an error, the
  // queue keeper hands the message back and the orchestrator picks another. The agent's
  // own logs say nothing about any of this — it is all in the orchestrator's routing
  // lines, one fragment per line, so collect the fragments into the attempt they describe.
  // langflow closes every run with a job line, and writes the reason next to it when the
  // run failed. The queue keeper names that same job when it hands the message back, so
  // the two meet and the reroute row can say what actually broke.
  const alfiJobs = new Map();
  const jobOf = id => {
    let j = alfiJobs.get(id);
    if(!j){ j = {id: id, ts: null, status: null, ms: null, flow: null, error: null, shown: false}; alfiJobs.set(id, j); }
    return j;
  };
  let att = null;
  const flushRoute = () => {
    if(att && (att.agent || att.final)){
      const bits = [];
      if(att.candidate || att.final) bits.push('маршрут ' + (att.candidate || '?') + ' → ' + (att.final || att.agent));
      if(att.domain) bits.push('домен ' + att.domain);
      if(att.reason) bits.push('причина ' + att.reason);
      if(att.url) bits.push('flow ' + att.url);
      if(att.failed) bits.push('после сбоя ' + att.failed);
      if(att.predicts) bits.push('классификатор: ' + att.predicts);
      events.push({ts: att.endTs != null ? att.endTs : att.ts, startTs: att.ts,
                   ms: att.endTs != null ? (att.endTs - att.ts) : null,
                   kind: 'route', depth: 0, chip: 'Роутер', chipClass: 'c-route',
                   title: att.failed ? 'Перемаршрутизация в ' : 'Маршрутизация в ',
                   name: att.agent || att.final, app: att.app, meta: bits.join(' · ')});
    }
    att = null;
  };
  recs.forEach(r => {
    if(r.app.indexOf('agent-orchestrator') >= 0){
      const rt = extractRoute(r.msg);
      if(!rt) return;
      if(!att) att = {ts: r.ts, app: r.app};
      if(rt.kind === 'send') att.agent = rt.agent;
      else if(rt.kind === 'post'){
        // the same client makes both calls: the classifier, then the flow itself
        const path = /\/api\/v\d+\/[\w.-]*/.exec(rt.url);
        if(path) att.url = path[0];
        else att.predicts = (att.predicts || 0) + 1;
      }
      else if(rt.kind === 'decision'){
        att.candidate = rt.data.candidate; att.final = rt.data.final;
        att.reason = rt.data.reason || att.reason; att.mode = rt.data.mode;
      }
      else if(rt.kind === 'heuristic'){ if(!att.domain) att.domain = rt.data.domain; }
      // the redirect line names the flow that failed and the one taking over; it is
      // written before the heuristic re-states the old domain, so it claims the field
      else if(rt.kind === 'redirect'){
        att.failed = rt.data.failed_agent; att.domain = rt.data.domain || att.domain;
        att.agent = att.agent || rt.data.agent;
      }
      else if(rt.kind === 'norm' && rt.domains) att.domains = rt.domains;
      if(rt.kind === 'end'){ att.endTs = r.ts; flushRoute(); }
      return;
    }
    const jf = /^\[ALFI\] Job finished \| job_id=([\w-]+) \| flow_id=([\w-]+) \| status=(\w+)(?: \| duration_ms=(\d+))?/.exec(r.msg);
    if(jf){
      const j = jobOf(jf[1]);
      j.ts = r.ts; j.flow = jf[2]; j.status = jf[3]; j.ms = jf[4] ? +jf[4] : null;
      return;
    }
    const je = /^Error during Alfi flow run for job_id ([\w-]+):\s*([\s\S]+)$/.exec(r.msg);
    if(je){ jobOf(je[1]).error = je[2]; return; }

    // the queue keeper is the one that notices a flow answered with an error
    if(r.msg.lastIndexOf('AI Flow error will be rerouted by Orchestrator', 0) === 0){
      const fid = /agentError='([^']+)'/.exec(r.msg);
      const cnt = /rerouteCount='(\d+)'/.exec(r.msg);
      const prev = /previousJobId='([^']+)'/.exec(r.msg);
      const job = prev && alfiJobs.get(prev[1]);
      if(job) job.shown = true;
      events.push({ts: r.ts, kind: 'route', depth: 0, chip: 'Роутер', chipClass: 'c-err',
                   title: 'Флоу вернул ошибку — запрос уходит в другой агент', app: r.app,
                   meta: [fid ? 'flow ' + fid[1] : null,
                          job && job.ms != null ? 'флоу работал ' + Math.round(job.ms) + ' мс' : null,
                          cnt ? 'перемаршрутизация №' + cnt[1] : null].filter(Boolean).join(' · '),
                   error: job ? job.error : null});
    }
  });
  flushRoute();
  // a run that died with nobody to hand the message on to still owes an explanation
  alfiJobs.forEach(j => {
    if(j.status !== 'failed' || j.shown || j.ts == null) return;
    events.push({ts: j.ts, kind: 'route', depth: 0, chip: 'Флоу', chipClass: 'c-err',
                 title: 'Флоу завершился ошибкой', app: 'alfagen-langflow',
                 meta: [j.flow ? 'flow ' + j.flow : null,
                        j.ms != null ? Math.round(j.ms) + ' мс' : null].filter(Boolean).join(' · '),
                 error: j.error});
  });

  // ---- core services behind the MCP calls ------------------------------------------
  // The adapter logs the hop it makes (upstream_request: service + endpoint) and nothing
  // about what happened on the other side. When the core service's own dump is loaded
  // too, the hundreds of TRACE lines it writes per request fold into a single row —
  // status, time, the stored procedures and the HTTP calls it made — hung under the tool
  // call it served. A hop whose service dump is missing still gets a muted row: it names
  // where the tool went, which is the first thing to ask when a tool comes back empty.
  const CORE_SLACK = 300;   // the two dumps are two clocks; let them disagree a little
  const toolWindows = events.filter(e => e.kind === 'mcp' && e.name)
    .map(e => ({name: e.name, start: e.ts - (e.ms || 0), end: e.ts}));
  // The tightest window that holds the whole core request. Tools run in parallel and
  // their windows nest, so a request that outlives a candidate tool belongs to the longer
  // call running alongside it, never to that one.
  const hostToolOf = (start, end) => {
    let best = null;
    const fit = (a, b) => toolWindows.forEach(w => {
      if(a < w.start - CORE_SLACK || b > w.end + CORE_SLACK) return;
      if(!best || (w.end - w.start) < (best.end - best.start)) best = w;
    });
    fit(start, end);
    if(!best) fit(start, start);   // the tool's own record never made it into the dump
    return best ? best.name : null;
  };

  const bucket = (m, k) => { let v = m.get(k); if(!v){ v = {n: 0, done: 0, ms: 0}; m.set(k, v); } return v; };
  const coreReqs = new Map();
  recs.forEach(r => {
    const c = coreRecord(r.raw);
    if(!c) return;
    const key = c.req || (c.svc + '|' + (c.path || ''));
    let g = coreReqs.get(key);
    if(!g){
      g = {svc: c.svc, path: c.path, start: r.ts, end: r.ts, n: 0, method: null, status: null,
           ms: null, query: null, llm: 0, err: 0, errLines: [], levels: {},
           sp: new Map(), cmd: new Map(), http: new Map()};
      coreReqs.set(key, g);
    }
    const raw = r.raw, lvl = String(r.level || '').toUpperCase();
    g.n++;
    if(r.ts < g.start) g.start = r.ts;
    if(r.ts > g.end) g.end = r.ts;
    if(!g.path && c.path) g.path = c.path;
    g.levels[lvl] = (g.levels[lvl] || 0) + 1;
    if(lvl === 'ERROR' || lvl === 'FATAL' || lvl.lastIndexOf('WARN', 0) === 0){
      g.err++;
      if(g.errLines.length < 6) g.errLines.push(lvl + ' ' + c.cat.split('.').pop() + ': ' + r.msg.slice(0, 400));
    }
    // the middleware line closes the request and states how it went
    if(/RequestStatusLoggingMiddleware$/.test(c.cat)){
      g.method = raw['data.httpMethod'] || g.method;
      g.status = raw['data.statusCode'] || raw['data.StatusCode'] || g.status;
      const took = spanMs(raw['data.elapsed']);
      if(took != null) g.ms = took;
    }
    // a db command is logged twice — the text about to run, then the time it took. Count
    // the second; the first is the fallback for a request the dump cuts in half.
    const sp = raw.spName || raw['data.storedProcedureName'];
    if(sp){
      const v = bucket(g.sp, sp), took = spanMs(raw['data.elapsed']);
      v.n++;
      if(took != null){ v.done++; v.ms += took; }
    }
    const cmd = raw['data.commandName'];
    if(cmd){
      const v = bucket(g.cmd, cmd), took = spanMs(raw['data.elapsedMs'] || raw['data.elapsed']);
      v.n++;
      if(took != null){ v.done++; v.ms += took; }
    }
    // an outgoing call is logged twice too — absolute url first, then relative; the
    // absolute form is the one worth counting
    const out = /^Запрос\s+([A-Z]+)\s+(https?:\/\/\S+)/.exec(r.msg);
    if(out) bucket(g.http, out[1] + ' ' + out[2].split('?')[0]).n++;
    if(/LlmClient$/.test(c.cat) && r.msg.indexOf('получен ответ') >= 0) g.llm++;
    if(!g.query && raw['data.query']) g.query = String(raw['data.query']);
  });

  // The adapter logs three kinds of hop: the call it made, a retry after a bad answer,
  // and the failure it gave up on. The last two carry what the service actually said —
  // the one thing worth reading when a tool comes back empty.
  const HOP_EVENT = {upstream_request: 1, upstream_retry: 1, upstream_server_error: 1};
  const upstreamBody = raw => {
    const inline = firstJsonAfter(String(raw.message == null ? '' : raw.message), 'upstream_response_body:');
    if(inline) return inline;
    // the collector flattens the body into upstream_response_body.<field> columns
    const flat = {};
    Object.keys(raw).forEach(k => {
      if(k.lastIndexOf('upstream_response_body.', 0) === 0) flat[k.slice(23)] = raw[k];
    });
    return Object.keys(flat).length ? JSON.stringify(flat, null, 2) : null;
  };
  const hops = recs.filter(r => HOP_EVENT[r.raw.event])
    .map(r => ({ts: r.ts, svc: r.raw.service || r.raw['X-External-System-Code'] || '',
                ep: r.raw.endpoint || '', method: r.raw.http_method || '', app: r.app,
                taken: false, retry: r.raw.event === 'upstream_retry',
                failed: r.raw.event !== 'upstream_request',
                status: r.raw.upstream_status || null,
                error: r.raw.event === 'upstream_request' ? null : upstreamBody(r.raw)}))
    .filter(h => h.svc);
  const coreList = Array.from(coreReqs.values()).sort((a, b) => a.start - b.start);
  // pair a request with the hop that started it: same service and endpoint, the latest
  // one that fired before the service wrote its first line
  coreList.forEach(g => {
    let best = null;
    hops.forEach(h => {
      if(h.taken || h.svc !== g.svc) return;
      if(g.path && h.ep && h.ep !== g.path) return;
      if(h.ts > g.start + 500 || h.ts < g.start - 30000) return;
      if(!best || h.ts > best.ts) best = h;
    });
    if(best){
      best.taken = true;
      g.method = g.method || best.method;
      if(best.error){ g.hopError = best.error; g.hopStatus = best.status; }
    }
  });

  const listOf = m => Array.from(m.entries())
    .map(p => ({name: p[0], n: p[1].done || p[1].n, ms: p[1].ms}))
    .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name))
    .map(x => x.name + (x.n > 1 ? ' ×' + x.n : '') + (x.ms ? ' · ' + Math.round(x.ms) + ' мс' : ''))
    .join('\n  ');
  const totalOf = m => Array.from(m.values()).reduce((a, v) => a + (v.done || v.n), 0);

  coreList.forEach(g => {
    const took = g.ms != null ? g.ms : (g.end - g.start);
    const spN = totalOf(g.sp), httpN = totalOf(g.http);
    const bits = [];
    if(g.path) bits.push((g.method || 'HTTP') + ' ' + g.path + (g.status ? ' → ' + g.status : ''));
    bits.push(took >= 1000 ? (took / 1000).toFixed(2) + ' с' : Math.round(took) + ' мс');
    if(spN) bits.push('процедур БД: ' + spN);
    if(httpN) bits.push('HTTP-вызовов: ' + httpN);
    if(g.llm) bits.push('обращений к LLM: ' + g.llm);
    if(g.err) bits.push('ошибок: ' + g.err);
    if(g.hopStatus) bits.push('апстрим вернул ' + g.hopStatus);
    const detail = [];
    if(g.query) detail.push('запрос: ' + g.query);
    if(g.cmd.size) detail.push('команды:\n  ' + listOf(g.cmd));
    if(g.sp.size) detail.push('процедуры БД:\n  ' + listOf(g.sp));
    if(g.http.size) detail.push('HTTP-вызовы:\n  ' + listOf(g.http));
    detail.push('записей в логе: ' + g.n + ' (' +
      Object.keys(g.levels).map(k => k + ' ' + g.levels[k]).join(', ') + ')');
    const failed = (+g.status >= 400) || g.err > 0 || !!g.hopError;
    const errText = [g.hopError, g.errLines.join('\n')].filter(Boolean).join('\n\n');
    const hostTool = hostToolOf(g.start, g.end);
    events.push({ts: g.start, kind: 'core', depth: hostTool ? 3 : 2, chip: 'Core',
                 chipClass: failed ? 'c-err' : 'c-core',
                 title: 'Запрос в ', name: g.svc, app: g.svc, detailed: true,
                 startTs: g.start, ms: took, under: hostTool,
                 meta: bits.join(' · '), detail: detail.join('\n'),
                 error: errText || null});
  });

  // hops with no service dump behind them: one row per tool, service and endpoint
  const thinHops = new Map();
  hops.forEach(h => {
    if(h.taken) return;
    const under = hostToolOf(h.ts, h.ts);
    const key = (under || '') + '|' + h.svc + '|' + h.ep;
    let t = thinHops.get(key);
    if(!t){ t = {ts: h.ts, svc: h.svc, ep: h.ep, method: h.method, under: under,
                 app: h.app, n: 0, retries: 0, failed: false, status: null, error: null};
            thinHops.set(key, t); }
    // a retry and the give-up line are the same call again, not new ones
    if(h.retry) t.retries++;
    else if(h.failed) t.failed = true;
    else t.n++;
    if(h.status) t.status = h.status;
    if(h.error && !t.error) t.error = h.error;
    if(h.ts < t.ts) t.ts = h.ts;
  });
  thinHops.forEach(t => events.push({
    ts: t.ts, kind: 'core', depth: t.under ? 3 : 2, chip: 'Core',
    chipClass: t.failed ? 'c-err' : 'c-core', minor: !t.failed,
    title: 'Запрос в ', name: t.svc, app: t.app || 'mcp', under: t.under,
    meta: [(t.method || 'HTTP') + ' ' + t.ep + (t.n > 1 ? ' ×' + t.n : ''),
           t.status ? 'ответ ' + t.status : null,
           t.retries ? 'повторов: ' + t.retries : null,
           t.failed ? 'сервис вернул ошибку' : 'логов сервиса в выгрузке нет'].filter(Boolean).join(' · '),
    error: t.error
  }));

  // A call whose Response never reached these files has no known end. Left open it would
  // run to infinity and adopt the whole rest of the trace — the answer and the delivery
  // included — so give it no window at all instead of a guessed one.
  spans.forEach(s => { if(s.end === Infinity) s.end = s.start; });

  // dedupe repeated langflow/MCP emissions
  // The same model turn can be logged by all three services at once. Keep the richest
  // copy: java-functions carries tool calls and round-trip timing, the REST mirror
  // carries tool calls and tokens, langflow's [ASK LLM] carries the least. Copies are
  // only ever dropped in favour of a *different*, better source — two turns logged
  // twice by the same service are two real turns.
  const SRC_RANK = {java: 0, rest: 1, ask: 2};
  const llmTurns = events.filter(e => e.kind === 'llm');
  // masking can still make two copies of one turn read differently past the first few
  // hundred characters; an identical prompt/completion/total token triple settles it
  const sameUsage = (a, b) => {
    const x = a.usage || {}, y = b.usage || {};
    return x.total_tokens > 0 && x.total_tokens === y.total_tokens &&
           x.prompt_tokens === y.prompt_tokens && x.completion_tokens === y.completion_tokens;
  };
  const twinOf = (o, e) => o !== e && SRC_RANK[o.src] < SRC_RANK[e.src] &&
    Math.abs(o.ts - e.ts) < 60000 && (o.contentKey === e.contentKey || sameUsage(o, e));
  // the kept copy inherits token counts from a dropped twin when it logged none itself
  llmTurns.forEach(e => {
    if(e.usage && e.usage.total_tokens) return;
    const w = llmTurns.find(o => twinOf(e, o) && o.usage && o.usage.total_tokens);
    if(w) e.usage = Object.assign({}, w.usage);
  });
  const seenKeys = new Set();
  let clean = events.filter(e => {
    if(e.kind === 'llm' && llmTurns.some(o => twinOf(o, e))) return false;
    if(!e.dedupeKey) return true;
    if(seenKeys.has(e.dedupeKey)) return false;
    seenKeys.add(e.dedupeKey);
    return true;
  });
  clean.sort((a, b) => a.ts - b.ts || a.depth - b.depth);

  const allAvailable = Array.from(new Set([].concat.apply([], Array.from(availableTools.values()))));

  // langflow exposes MCP tools as ordinary tools; re-label those so they don't pose as
  // sub-agents. The tool cache is not always in the dump, so a name also counts as MCP
  // when langflow named its server or the adapter logged a call under the same name.
  const adapterTools = new Set(clean.filter(e => e.kind === 'mcp' && e.name).map(e => e.name));
  const isMcpName = n => allAvailable.indexOf(n) >= 0 || adapterTools.has(n) ||
                         !!(toolKind.get(n) && toolKind.get(n).mcp);
  clean.forEach(e => {
    if(e.kind === 'subagent' && isMcpName(e.name)){
      e.kind = 'mcpwrap'; e.chip = 'MCP'; e.chipClass = 'c-mcp'; e.depth = 2;
    }
  });
  // an MCP tool is not a host: its window must not adopt the calls that ran during it
  for(let i = spans.length - 1; i >= 0; i--) if(isMcpName(spans[i].name)) spans.splice(i, 1);

  // pull errors out of the narrative and group them by signature
  const errorGroups = new Map();
  clean = clean.filter(e => {
    if(e.kind !== 'error') return true;
    const sig = (e.title || '') + '|' + (e.quote || '')
      .replace(/\*MASKED_[A-Z_]+\*/g, '\u00b7')
      .replace(/[0-9a-f\u00b7\-]{8,}/gi, '\u00b7').slice(0, 90);
    const g = errorGroups.get(sig);
    if(g){ g.count++; g.last = e.ts; g.tsList.push(e.ts); }
    else errorGroups.set(sig, {count: 1, first: e.ts, last: e.ts, level: e.chip,
                              logger: e.title, sample: e.quote || '', app: e.app, tsList: [e.ts]});
    return false;
  });

  // collapse MCP handshake chatter into one row per burst
  const handshakes = clean.filter(e => e.kind === 'sys');
  clean = clean.filter(e => e.kind !== 'sys');
  const bursts = [];
  handshakes.forEach(e => {
    const host = spans.find(s => e.ts >= s.start && e.ts <= s.end);
    const key = host ? host.name : '\u2014';
    let b = bursts.find(x => x.key === key && e.ts - x.last < 20000);
    if(!b){ b = {key: key, under: host ? host.name : null, ts: e.ts, last: e.ts, methods: {}, n: 0}; bursts.push(b); }
    b.last = e.ts; b.n++;
    b.methods[e.name] = (b.methods[e.name] || 0) + 1;
  });
  bursts.forEach(b => clean.push({
    ts: b.ts, kind: 'sys', depth: 2, chip: 'MCP', chipClass: 'c-sys', minor: true,
    title: 'Рукопожатие с сервером', under: b.under,
    meta: Object.keys(b.methods).map(k => k + ' ×' + b.methods[k]).join(' · ')
  }));

  // one MCP call surfaces twice: once as a LangFlow tool wrapper, once from the
  // adapter. Keep the adapter record (it carries params + result) and fold the
  // wrapper's round-trip time into it.
  // One tool is often called several times over, so the wrapper belongs to the nearest
  // adapter record, not the first one that shares its name — and it says its round trip
  // once. Without both, one row collects every sibling's timing.
  const wrapped = new Set();
  clean.forEach(w => {
    if(w.kind !== 'mcpwrap') return;
    let hit = null;
    clean.forEach(e => {
      if(e.kind !== 'mcp' || e.name !== w.name) return;
      const d = Math.abs(e.ts - w.ts);
      if(d >= 8000 || (hit && d >= Math.abs(hit.ts - w.ts))) return;
      hit = e;
    });
    if(!hit) return;
    wrapped.add(w);
    if(w.phase === 'out' && w.ms != null && hit.wrapMs == null){
      hit.wrapMs = w.ms;
      hit.meta = (hit.meta ? hit.meta + ' · ' : '') + 'через LangFlow ' + Math.round(w.ms) + ' мс';
    }
  });
  clean = clean.filter(e => !wrapped.has(e));

  // nest by time containment: what happened inside a sub-agent belongs under it
  clean.forEach(e => {
    const host = spans.find(s => e.ts >= s.start && e.ts <= s.end);
    if(host && e.kind !== 'subagent' && !e.under) e.under = host.name;
    if(e.kind === 'llm') e.depth = host ? 2 : (e.calls ? 1 : 0);
  });
  clean.sort((a, b) => a.ts - b.ts || a.depth - b.depth);

  // The raw question is the last message in every prompt, so it is the first thing
  // Kibana's ~5 KB cut removes. What survives is the rephrasing turn — show that, said
  // plainly, instead of claiming the request is missing from the dump.
  if(!userQ && reformQ){
    userQ = {text: reformQ, ts: t0, reformulated: true};
    userQs.push(userQ);
    clean.push({ts: t0, kind: 'user', depth: 0, chip: 'Запрос', chipClass: 'c-user',
                title: 'Запрос пользователя — после переформулировки', quote: reformQ,
                meta: 'исходный текст сообщения в выгрузку не попал', qIndex: 0});
    clean.sort((a, b) => a.ts - b.ts || a.depth - b.depth);
  }

  // No hand-off record in the dump — but the answer the user saw is an assembly, and
  // the last model turn that produced one is it. Only a fallback: a real hand-off
  // record always wins, because it proves the text left the service.
  if(!finalAnswer){
    for(let i = clean.length - 1; i >= 0; i--){
      const e = clean[i];
      if(e.kind !== 'llm' || !e.content || !/"type"\s*:\s*"assembly"/.test(e.content)) continue;
      const text = humanizeAnswer(e.content.trim()).trim();
      if(!text) break;
      finalAnswer = text;
      const evParts = answerParts(e.content.trim());
      clean.push({ts: e.ts, kind: 'answer', depth: 0, chip: 'Ответ', chipClass: 'c-ans',
                  title: 'Ответ собран моделью', parts: evParts, quote: finalAnswer, app: e.app, full: true,
                  meta: 'записи об отдаче ответа в канал в выгрузке нет'});
      clean.sort((a, b) => a.ts - b.ts || a.depth - b.depth);
      break;
    }
  }

  const mcpCalls = clean.filter(e => e.kind === 'mcp');
  const ragHits = clean.filter(e => e.kind === 'rag' && e.chunks != null);
  const subCalls = clean.filter(e => e.kind === 'subagent' && e.phase === 'in');
  const calledSubs = Array.from(new Set(subCalls.map(e => e.name)));
  const calledMcp = Array.from(new Set(mcpCalls.map(e => e.name)));

  // the real conversation ends at the last meaningful event; stray stream-close
  // warnings minutes later must not stretch the scale
  const STORY = {user: 1, llm: 1, subagent: 1, mcp: 1, mcpwrap: 1, rag: 1, answer: 1, core: 1,
                 route: 1, reject: 1};
  const storyEvents = clean.filter(e => STORY[e.kind]);
  const tEnd = storyEvents.length ? storyEvents[storyEvents.length - 1].ts : t1;
  meta.durationMs = Math.max(tEnd - t0, 1);
  meta.spanMs = t1 - t0;
  clean.forEach(e => { e.rel = (e.ts - t0) / 1000; });
  clean = clean.filter(e => e.ts <= tEnd + 1000);

  // the parts behind the answer that actually shipped, for the rich rendering upstairs
  const answerEv = clean.filter(e => e.kind === 'answer' && e.parts).pop();
  const answerEvParts = answerEv ? answerEv.parts : null;

  const errs = Array.from(errorGroups.values()).sort((a, b) => b.count - a.count);
  const errTotal = errs.reduce((a, g) => a + g.count, 0);

  // ---- inventory: sub-agents apart from MCP tools, plus attribution "кто кого вызвал".
  // Nesting by time containment already gave every event its host sub-agent (e.under);
  // that host is the caller. Events without a host belong to the root agent.
  const ROOT_AGENT = 'Основной агент';
  const plannedNames = plan ? (plan.steps || []).reduce((a, s) => a.concat(s.tools || []), []) : [];
  const serverOf = new Map();
  availableTools.forEach((tools, srv) => tools.forEach(t => { if(!serverOf.has(t)) serverOf.set(t, srv); }));
  // without the tool cache the server is only named on the call itself
  toolKind.forEach((k, n) => { if(k.mcp && k.server && !serverOf.has(n)) serverOf.set(n, k.server); });

  const subInv = new Map();
  const subOf = name => {
    let s = subInv.get(name);
    if(!s){ s = {name: name, calls: 0, ms: 0, planned: false, tools: new Map()}; subInv.set(name, s); }
    return s;
  };
  // a planned name that is really an MCP tool belongs to the MCP list, not here
  plannedNames.forEach(n => { if(allAvailable.indexOf(n) < 0) subOf(n).planned = true; });
  const rootTools = new Map();
  clean.forEach(e => {
    if(e.kind !== 'subagent') return;
    const s = subOf(e.name);
    if(e.phase !== 'in'){ if(e.ms != null) s.ms += e.ms; return; }
    s.calls++;
    // calling a sub-agent is itself a tool call, so it counts for whoever made it
    const bag = e.under ? subOf(e.under).tools : rootTools;
    bag.set(e.name, (bag.get(e.name) || 0) + 1);
  });

  const mcpInv = new Map();
  const mcpOf = name => {
    let t = mcpInv.get(name);
    if(!t){
      t = {name: name, server: serverOf.get(name) || null, calls: 0, ms: 0,
           planned: plannedNames.indexOf(name) >= 0, apps: [], callers: new Map(), offeredTo: []};
      mcpInv.set(name, t);
    }
    return t;
  };
  allAvailable.forEach(t => mcpOf(t));
  clean.forEach(e => {
    if(!e.name || (e.kind !== 'mcp' && e.kind !== 'mcpwrap')) return;
    const t = mcpOf(e.name);
    // adapter record: the call itself, with its own timing and server app;
    // a LangFlow wrapper survives only when no adapter record matched it — then its
    // Request is the call and its Response carries the round-trip time
    if(e.kind === 'mcpwrap' && e.phase !== 'in'){ if(e.ms != null) t.ms += e.ms; return; }
    t.calls++;
    if(e.ms != null) t.ms += e.ms;
    if(e.kind === 'mcp' && e.app && t.apps.indexOf(e.app) < 0) t.apps.push(e.app);
    const who = e.under || ROOT_AGENT;
    t.callers.set(who, (t.callers.get(who) || 0) + 1);
    const bag = e.under ? subOf(e.under).tools : rootTools;
    bag.set(e.name, (bag.get(e.name) || 0) + 1);
  });

  // ---- what each agent HAD on hand, not just what it used. A tool list belongs to the
  // agent inside whose window its model turn started; the same list is logged twice
  // (JSON and Java toString), so one messageId counts once.
  const turnTools = new Map();
  offered.forEach(o => {
    const key = o.messageId || ('ts:' + o.ts);
    let rec = turnTools.get(key);
    if(!rec){ rec = {ts: o.ts, messageId: o.messageId, tools: [], partial: true}; turnTools.set(key, rec); }
    // the two shapes truncate at different points, so take the union of both
    o.tools.forEach(t => { if(rec.tools.indexOf(t) < 0) rec.tools.push(t); });
    if(!o.partial) rec.partial = false;
    if(o.ts < rec.ts) rec.ts = o.ts;
  });

  const offeredBy = new Map();
  turnTools.forEach(o => {
    const span = o.messageId && seenMsgIds.get(o.messageId);
    const ts = span ? span.start : o.ts;
    const host = spans.find(s => ts >= s.start && ts <= s.end);
    const who = host ? host.name : ROOT_AGENT;
    let rec = offeredBy.get(who);
    if(!rec){ rec = {turns: 0, tools: [], partial: false}; offeredBy.set(who, rec); }
    rec.turns++;
    if(o.partial) rec.partial = true;
    o.tools.forEach(t => { if(rec.tools.indexOf(t) < 0) rec.tools.push(t); });
  });

  // is this name an MCP tool or another agent? langflow's own binding log decides;
  // otherwise fall back to what we saw the name behave as
  const kindOf = name => {
    const k = toolKind.get(name);
    if(k) return k.mcp ? 'mcp' : 'sub';
    if(mcpInv.has(name)) return 'mcp';
    if(subInv.has(name) || plannedNames.indexOf(name) >= 0) return 'sub';
    return null;
  };
  offeredBy.forEach((rec, who) => rec.tools.forEach(n => {
    if(kindOf(n) !== 'mcp') return;
    const t = mcpOf(n);   // a tool offered but missing from the cache still belongs in the list
    if(!t.server){ const k = toolKind.get(n); if(k && k.server) t.server = k.server; }
    if(t.offeredTo.indexOf(who) < 0) t.offeredTo.push(who);
  }));

  const countList = m => Array.from(m.entries()).map(p => ({name: p[0], count: p[1]}))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  // one chip per tool the agent had or used: kind for the styling, count for "×N"
  const toolsetOf = (who, called) => {
    const rec = offeredBy.get(who);
    const names = (rec ? rec.tools.slice() : []);
    Array.from(called.keys()).forEach(n => { if(names.indexOf(n) < 0) names.push(n); });
    const rank = {mcp: 0, sub: 2};
    return names.map(n => ({name: n, kind: kindOf(n), count: called.get(n) || 0}))
      .sort((a, b) => b.count - a.count ||
        (rank[a.kind] == null ? 1 : rank[a.kind]) - (rank[b.kind] == null ? 1 : rank[b.kind]) ||
        a.name.localeCompare(b.name));
  };
  const agentInfo = (name, called, extra) => {
    const off = offeredBy.get(name);
    return Object.assign({
      name: name, tools: countList(called), toolset: toolsetOf(name, called),
      known: !!off, turns: off ? off.turns : 0, partial: !!(off && off.partial)
    }, extra);
  };

  const subAgents = Array.from(subInv.values()).map(s =>
    agentInfo(s.name, s.tools, {calls: s.calls, ms: s.ms || null, planned: s.planned})
  ).sort((a, b) => (b.calls > 0) - (a.calls > 0) || b.calls - a.calls || a.name.localeCompare(b.name));
  const mainAgent = (rootTools.size || offeredBy.has(ROOT_AGENT))
    ? agentInfo(ROOT_AGENT, rootTools, {}) : null;

  const mcpGroups = [];
  Array.from(mcpInv.values()).forEach(t => {
    // no tool cache in the dump means no server name — fall back to the adapter that
    // actually served the calls, which is the same thing under a different label
    const key = t.server || (t.apps.length === 1 ? t.apps[0] : 'сервер не определён');
    let g = mcpGroups.find(x => x.server === key);
    if(!g){ g = {server: key, apps: [], tools: []}; mcpGroups.push(g); }
    t.apps.forEach(a => { if(g.apps.indexOf(a) < 0) g.apps.push(a); });
    g.tools.push({name: t.name, calls: t.calls, ms: t.ms || null, planned: t.planned,
                  callers: countList(t.callers), offeredTo: t.offeredTo || []});
  });
  mcpGroups.forEach(g => g.tools.sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name)));
  mcpGroups.sort((a, b) => b.tools.filter(t => t.calls).length - a.tools.filter(t => t.calls).length);

  // ---- verdict + stats: once for the whole trace ("Все"), once per user request
  const segOf = ts => {
    let idx = 0;
    for(let i = 0; i < userQs.length; i++){ if(ts >= userQs[i].ts) idx = i; else break; }
    return idx;
  };
  // the core dump is filtered by this code, not by traceId — name it in the findings
  const userCodeRec = recs.find(r => r.raw['X-External-User-Code'] || r.raw.userCode);
  const userCode = userCodeRec ? (userCodeRec.raw['X-External-User-Code'] || userCodeRec.raw.userCode) : null;
  const agg = summarize(clean, recs, {userQ: userQ, plan: plan, finalAnswer: finalAnswer,
    delivered: delivered, allAvailable: allAvailable, errs: errs, userCode: userCode,
    answerVia: meta.answerVia, seconds: meta.durationMs / 1000});

  const segments = userQs.map((q, i) => {
    const segEvents = clean.filter(e => segOf(e.ts) === i);
    const segRecs = recs.filter(r => segOf(r.ts) === i);
    const planEv = segEvents.filter(e => e.tag === 'plan').pop();
    const ansEv = segEvents.filter(e => e.kind === 'answer' && e.quote).pop();
    const segAnswer = ansEv ? ansEv.quote : null;
    const segParts = ansEv ? ansEv.parts : null;
    // the async stack proves delivery with a channel record; a synchronous endpoint
    // proves it by having answered the call at all
    const segDelivered = segEvents.some(e => e.kind === 'answer' &&
      (e.deliveredHere || /отправлен пользователю/.test(e.title || '')));
    const segErrs = errs.map(g => Object.assign({}, g, {count: g.tsList.filter(ts => segOf(ts) === i).length}))
                        .filter(g => g.count > 0);
    const segEnd = segEvents.length ? segEvents[segEvents.length - 1].ts : q.ts;
    const view = summarize(segEvents, segRecs, {userQ: q, plan: planEv ? planEv.planData : null,
      finalAnswer: segAnswer, delivered: segDelivered, allAvailable: allAvailable,
      errs: segErrs, userCode: userCode, answerVia: meta.answerVia,
      seconds: Math.max((segEnd - q.ts) / 1000, 0)});
    return {index: i, question: q, findings: view.findings, stats: view.stats,
            finalAnswer: segAnswer, answerParts: segParts, delivered: segDelivered};
  });

  const linked = linkedOf(recs, clean);
  if(linked.length){
    const note = {level: 'note', text: 'Трейс собран из <b>' + (linked.length + 1) + '</b> traceId: кроме основного, ' +
      linked.map(l => '<code>' + escText(l.traceId) + '</code> — ' + escText(l.what) + ' (' + l.count + ' зап.)').join('; ') +
      '. Эти звенья логируются под своими traceId, связаны по ' +
      Array.from(new Set(linked.map(l => l.why === 'flow' ? 'session_id запуска флоу' : 'messageId вызова модели'))).join(' и ') + '.'};
    agg.findings.unshift(note);
    segments.forEach(sg => sg.findings.unshift(note));
  }

  return {
    traceId: traceId, meta: meta, records: recs, events: clean,
    quality: extractQuality(recs),
    userQ: userQ, userQs: userQs, plan: plan, finalAnswer: finalAnswer, answerParts: answerEvParts, delivered: delivered,
    availableTools: allAvailable, calledMcp: calledMcp, calledSubs: calledSubs,
    plannedSubs: plannedNames,
    subAgents: subAgents, mainAgent: mainAgent, mcpGroups: mcpGroups,
    findings: agg.findings, errors: errs, errorTotal: errTotal,
    stats: agg.stats, segments: segments,
    budget: mcpBudget(clean, recs),
    linked: linked
  };
}
