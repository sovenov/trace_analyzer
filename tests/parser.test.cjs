const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {TextDecoder, TextEncoder} = require('node:util');

const root = path.resolve(__dirname, '..');
const source = ['parser.js', 'contracts.js'].map(f => fs.readFileSync(path.join(root, 'js', f), 'utf8')).join('\n');
const epoch = Date.parse('2026-11-09T12:00:00Z');
const iso = ms => new Date(epoch + ms).toISOString();
function record(ms, message, fields = {}){
  return Object.assign({'@timestamp': iso(ms), traceId: 'a'.repeat(32),
    app_id: 'alfagen-langflow', level: 'INFO', message}, fields);
}
function analyze(logs){
  const api = vm.createContext({TextDecoder, TextEncoder});
  vm.runInContext(source, api);
  const built = api.buildTraces([{name: 'sample.json', logs: api.normalizeFile(logs).logs}]);
  return {api, built, trace: built.traces[0]};
}
function model(ms, id, content, fields = {}){
  return record(ms, '[AlfaGen API] Response', Object.assign({message_id: id, model: 'model',
    response_body: JSON.stringify(content), prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    operation_start_time: iso(ms - 50), operation_finish_time: iso(ms), operation_duration_ms: 50}, fields));
}
function mcp(ms, phase, span, tool, body, fields = {}){
  return record(ms, '[MCP] ' + phase, Object.assign({span_id: span, operation: tool,
    [phase === 'Request' ? 'body' : 'response_body']: JSON.stringify(body)}, fields));
}
function request(ms, span, n){
  return mcp(ms, 'Request', span, 'lookup', {method: 'tools/call', params: {name: 'lookup', arguments: {n}}});
}
function response(ms, span, text, fields){
  return mcp(ms, 'Response', span, 'lookup', {content: [{type: 'text', text}]}, fields);
}
function alfi(ms, id, children, fields = {}){
  const envelope = {job_id: 'job', event_id: id, session_id: 'flow-session', data: {
    event_type: 'add_message', comod_message_id: 'message',
    metadata: {firstName: 'Test', channelApp: 'TEST'}, value: {type: 'assembly', children}}};
  return record(ms, 'Alfi delivery: sent add_message for job_id=job via kafka', Object.assign({
    'extra.delivery_status': 'sent', 'extra.alfi_payload_json': JSON.stringify(envelope)}, fields));
}
const textNode = text => ({type: 'message', body: {text}});
const toolEvents = trace => trace.events.filter(e => e.kind === 'mcp' || (e.kind === 'mcpwrap' && e.phase === 'in'));

test('structured model response works without Java/REST mirrors and keeps tool arguments, timing and usage', () => {
  const {trace} = analyze([model(100, 'turn', {role: 'assistant', content: 'Reason', tool_calls: [
    {function: {name: 'lookup', arguments: '{"n":2}'}}
  ]})]);
  const e = trace.events.find(e => e.kind === 'llm');
  assert.equal(trace.stats.llm, 1);
  assert.equal(trace.stats.tokens, 120);
  assert.equal(e.calls[0].args, '{"n":2}');
  assert.equal(e.startTs, epoch + 50);
  assert.equal(e.ms, 50);
});

test('complete integration response replaces a truncated mirror with stale usage by messageId', () => {
  const mirror = record(90, 'Answer is ready with messageId=turn: payload { usage { total_tokens { value: 999 } } }',
    {app_id: 'alfagen-java-functions-service'});
  const {trace} = analyze([mirror, model(100, 'turn', {role: 'assistant', content: 'Complete answer'})]);
  assert.equal(trace.stats.llm, 1);
  assert.equal(trace.stats.tokens, 120);
  assert.equal(trace.events.find(e => e.kind === 'llm').content, 'Complete answer');
});

test('identical text from different model calls is not merged across sources', () => {
  const rest = record(80, '[messageId=other] Rest response from LLM: ' + JSON.stringify({
    choices: [{message: {content: 'Same'}}], usage: {prompt_tokens: 100, completion_tokens: 20, total_tokens: 120}
  }), {app_id: 'alfagen-llm-integration-service'});
  const {trace} = analyze([rest, model(100, 'first', {role: 'assistant', content: 'Same'}),
    model(120, 'second', {role: 'assistant', content: 'Same'})]);
  assert.equal(trace.stats.llm, 3);
  assert.equal(trace.stats.tokens, 360);
});

test('integration response retains provider finish_reason and ignores non-model payloads', () => {
  const rest = record(90, '[messageId=turn] Rest response from LLM: ' + JSON.stringify({
    choices: [{message: {content: 'Partial'}, finish_reason: 'length'}]
  }), {app_id: 'alfagen-llm-integration-service'});
  const {trace} = analyze([rest, model(100, 'turn', {role: 'assistant', content: 'Complete'}),
    record(200, '[AlfaGen API] Response', {status_code: 500, response_body: '{"detail":"Unavailable"}'})]);
  assert.equal(trace.stats.llm, 1);
  assert.equal(trace.events.find(e => e.kind === 'llm').finish, 'length');
});

test('parallel calls of one MCP tool match reversed responses by span_id', () => {
  const {trace} = analyze([request(0, 'slow', 1), request(10, 'fast', 2),
    response(50, 'fast', 'two', {operation_duration_ms: 40}),
    response(100, 'slow', 'one', {operation_duration_ms: 100})]);
  const calls = toolEvents(trace);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(calls[0].params).n, 2);
  assert.equal(JSON.parse(calls[0].result).content[0].text, 'two');
  assert.equal(calls[0].ms, 40);
  assert.equal(JSON.parse(calls[1].params).n, 1);
  assert.equal(calls[1].startTs, epoch);
});

test('structured MCP response supplies arguments and results once alongside the old tool wrapper', () => {
  const header = JSON.stringify({run_id: 'run', metadata: {server_name: 'server'}});
  const {trace} = analyze([request(0, 'span', 1),
    record(1, '[TOOL] | Request | lookup | headers=' + header + ' | body={"n":1}'),
    response(100, 'span', 'data'),
    record(101, '[TOOL] | Response | lookup | headers=' + header + ' | body=data')]);
  assert.equal(trace.stats.mcp, 1);
  assert.equal(toolEvents(trace).length, 1);
  assert.equal(JSON.parse(toolEvents(trace)[0].params).n, 1);
  assert.ok(toolEvents(trace)[0].result.includes('data'));
});

test('MCP adapter and structured transport remain one call', () => {
  const {trace} = analyze([request(0, 'span', 1),
    record(90, 'TOOL: lookup, PARAMETERS: {"n":1}, DURATION_MS: 90, RESULT: {"value":1}',
      {app_id: 'test-mcp-server'}), response(100, 'span', 'data')]);
  assert.equal(trace.stats.mcp, 1);
  assert.equal(toolEvents(trace)[0].callKey, 'span');
});

test('old and structured MCP transport logs of the same call do not double its count', () => {
  const {trace} = analyze([request(0, 'span', 1),
    record(1, '[MCP -> {http}] | Request | lookup | body={"method":"tools/call","params":{"arguments":{"n":1}}}'),
    response(100, 'span', 'data'),
    record(101, '[MCP -> {http}] | Response | lookup | body={"content":[{"type":"text","text":"data"}]}')]);
  assert.equal(trace.stats.mcp, 1);
  assert.equal(toolEvents(trace)[0].callKey, 'span');
});

test('different simultaneous calls in old and structured transports remain separate', () => {
  const {trace} = analyze([
    record(0, '[MCP -> {http}] | Request | lookup | body={"method":"tools/call","params":{"arguments":{"n":1}}}', {span_id: 'old'}),
    request(1, 'new', 2),
    record(100, '[MCP -> {http}] | Response | lookup | body={"content":[{"type":"text","text":"old"}]}', {span_id: 'old'}),
    response(101, 'new', 'new')]);
  assert.equal(trace.stats.mcp, 2);
});

test('MCP protocol traffic is excluded; failed and incomplete tool calls remain visible', () => {
  const {trace} = analyze([mcp(0, 'Request', 'list', 'tools/list', {method: 'tools/list'}),
    mcp(1, 'Response', 'list', 'tools/list', {tools: []}), request(10, 'failed', 1),
    mcp(20, 'Response', 'failed', 'lookup', {isError: true, content: []}), request(30, 'pending', 2)]);
  const calls = toolEvents(trace);
  assert.equal(trace.stats.mcp, 2);
  assert.ok(calls[0].error);
  assert.equal(calls[0].result, null);
  assert.equal(JSON.parse(calls[1].params).n, 2);
  assert.equal(calls[1].ms, undefined);
  assert.equal(calls[1].result, undefined);
});

test('MCP diagnostics supply wire sizes and name matching without counting handshakes', () => {
  const diagnostic = (ms, span, bytes, body) => record(ms, '[MCP] ProtocolDiagnostic', {
    span_id: span, 'response_headers.content-length': String(bytes), body_prefix: JSON.stringify(body)});
  const {trace} = analyze([request(0, 'first', 1), request(10, 'second', 2),
    diagnostic(19, 'list', 900, {result: {tools: []}}),
    diagnostic(20, 'second', 200, {result: {content: [{type: 'text', text: 'second'}]}}),
    response(30, 'second', 'second'),
    diagnostic(40, 'first', 100, {result: {content: [{type: 'text', text: 'first'}]}}),
    response(50, 'first', 'first')]);
  assert.equal(trace.stats.sizes.mcp.n, 2);
  assert.equal(trace.stats.sizes.mcp.bytes, 300);
  assert.equal(trace.stats.sizes.mcp.max.tool, 'lookup');
  assert.equal(trace.budget.calls.find(c => c.ts === epoch + 30).bytes, 200);
  assert.equal(trace.budget.calls.find(c => c.ts === epoch + 50).bytes, 100);
});

test('Kafka answer includes widgets and status, without claiming delivery to the client', () => {
  const logs = [alfi(0, 'status', [{type: 'intermediate', body: {text: 'Working'}}]),
    alfi(100, 'answer', [textNode('Final answer'), {type: 'dialogSuggestion', body: {text: 'Next'}}]),
    alfi(101, 'answer', [textNode('Final answer'), {type: 'dialogSuggestion', body: {text: 'Next'}}])];
  const {trace, api} = analyze(logs);
  assert.equal(trace.finalAnswer, 'Final answer\n\nКнопки: Next');
  assert.equal(trace.answerParts.length, 2);
  assert.equal(trace.events.filter(e => e.kind === 'answer').length, 1);
  assert.equal(trace.events.filter(e => e.kind === 'status').length, 1);
  assert.equal(trace.meta.ctx.firstName, 'Test');
  assert.equal(trace.delivered, false);
  assert.ok(trace.findings.some(f => f.text.includes('Ответ опубликован в Kafka')));
  const contracts = api.extractContracts(trace.records);
  assert.equal(contracts.filter(c => c.method === 'Kafka').length, 2);
});

test('intermediate and failed Kafka publications do not create final answers', () => {
  const {trace} = analyze([alfi(0, 'status', [{type: 'intermediate', body: {text: 'Working'}}]),
    alfi(100, 'failed', [textNode('Unsent')], {'extra.delivery_status': 'failed'})]);
  assert.equal(trace.finalAnswer, null);
  assert.equal(trace.delivered, false);
});

test('structured RAG counts chunks once alongside the legacy response and exports as RAG', () => {
  const {trace, api} = analyze([record(0, '[ARAG Gateway] Request', {span_id: 'rag', path: '/chunks',
    body: JSON.stringify({system_id: 'test', query: 'Question', filters: {}})}),
    record(50, '[ARAG Gateway] Response', {span_id: 'rag', status_code: 200,
      response_body: '{"items_count":5}', operation_duration_ms: 50}),
    record(51, '[RAG Multidomains] Получено 5 чанков от ARAG')]);
  assert.equal(trace.stats.rag, 5);
  assert.equal(trace.events.find(e => e.kind === 'rag').quote, 'Question');
  const c = api.extractContracts(trace.records)[0];
  assert.equal(c.kind, 'rag');
  assert.equal(c.to, 'arag-gateway');
  assert.equal(c.status, 200);
});

test('structured access rejection is visible even at INFO level; queued response is not an answer', () => {
  const {trace} = analyze([record(0, '[ACCESS] Response', {method: 'POST', path: '/api/v1/run/flow',
    status_code: 403, response_body: '{"detail":"Denied"}'})]);
  assert.equal(trace.events.find(e => e.kind === 'reject').code, 403);
  assert.equal(trace.finalAnswer, null);
  const queued = analyze([record(0, '[ACCESS] Response', {status_code: 200,
    response_body: '{"job_id":"job","status":"queued"}'})]).trace;
  assert.equal(queued.finalAnswer, null);
  assert.equal(queued.delivered, false);
});

test('offered tools are recovered from a structured model request', () => {
  const {trace} = analyze([record(0, '[AlfaGen API] Request', {message_id: 'turn',
    body: JSON.stringify({tools: [{type: 'function', function: {name: 'unused', parameters: {}}}]})}),
    model(100, 'turn', {role: 'assistant', content: 'Done'})]);
  assert.equal(trace.mainAgent.known, true);
  assert.equal(trace.mainAgent.toolset[0].name, 'unused');
  assert.equal(trace.mainAgent.toolset[0].count, 0);
});

test('legacy ASK LLM and MCP transport keep their behavior', () => {
  const {trace} = analyze([record(0, '[ASK LLM] Request | model=old | body: {}'),
    record(50, "[ASK LLM] Response | model=old | body: {'generations': [{'content': 'Legacy'}], 'prompt_tokens': 10, 'completion_tokens': 2, 'total_tokens': 12}"),
    record(60, '[MCP -> {http}] | Request | lookup | body={"method":"tools/call","params":{"arguments":{"n":1}}}'),
    record(80, '[MCP -> {http}] | Response | lookup | body={"content":[{"type":"text","text":"Legacy result"}]}')]);
  assert.equal(trace.stats.llm, 1);
  assert.equal(trace.stats.tokens, 12);
  assert.equal(trace.stats.mcp, 1);
  assert.equal(JSON.parse(toolEvents(trace)[0].params).n, 1);
});
