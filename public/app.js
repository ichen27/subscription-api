const $ = id => document.getElementById(id);
let localKey = '', controller, loadedStatus;
function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; }
async function request(path, options = {}) {
  const headers = { ...options.headers };
  if (localKey) headers.authorization = 'Bearer ' + localKey;
  if (options.body) headers['content-type'] = 'application/json';
  const response = await fetch(path, { ...options, headers });
  if (response.status === 401) $('local-auth').hidden = false;
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message || 'Request failed.');
  return data;
}
function selectedModel() {
  return $('model').value === 'custom' ? $('provider').value + '/' + $('custom-model').value.trim() : $('model').value;
}
function updateSelection() {
  const custom = $('model').value === 'custom';
  $('custom-model-wrap').hidden = !custom;
  $('custom-model').required = custom;
  const model = selectedModel();
  $('selected-model').textContent = model;
  $('save-model').disabled = !model.includes('/') || (custom && !$('custom-model').value.trim());
  if (loadedStatus) {
    const body = JSON.stringify({ model, messages: [{ role: 'user', content: 'Hello' }] });
    const quotedBody = "'" + body.replaceAll("'", "'\\''") + "'";
    $('example').textContent = [
      `curl ${loadedStatus.localBaseUrl}/chat/completions`,
      '  -H "Authorization: Bearer $GATEWAY_KEY"',
      "  -H 'Content-Type: application/json'",
      `  -d ${quotedBody}`,
    ].join(' \\\n');
  }
}
function renderModels(preserve = false) {
  if (!loadedStatus) return;
  const provider = $('provider').value;
  const previous = preserve ? $('model').value : provider;
  $('model').replaceChildren(...loadedStatus.models.filter(model => model.provider === provider).map(model => new Option(model.label, model.id)), new Option('Custom model ID…', 'custom'));
  $('model').value = [...$('model').options].some(option => option.value === previous) ? previous : provider;
  $('model').disabled = false;
  $('custom-model').placeholder = provider === 'chatgpt' ? 'e.g. gpt-6.1-sol' : 'e.g. claude-opus-4-8';
  $('send').disabled = Boolean(controller);
  updateSelection();
}
async function refresh() {
  $('refresh').disabled = true;
  try {
    const status = await request('/api/status');
    loadedStatus = status;
    $('claude-login-command').textContent = status.loginCommands.claude;
    $('claude-login-hint').textContent = status.claudeAutomation ? 'Renew the automation login on the Mac mini, replace its private credential file, then refresh:' : 'Sign in on the Mac mini, then refresh:';
    $('local-auth').hidden = true;
    for (const provider of status.providers) {
      const badge = $(provider.id + '-state');
      badge.textContent = provider.connected ? 'Connected' : provider.state === 'unavailable' ? 'Unavailable' : 'Sign-in required';
      badge.className = 'badge ' + (provider.connected ? 'connected' : 'warning');
      $(provider.id + '-login').hidden = provider.connected;
      $(provider.id + '-model').textContent = status.upstreamModels[provider.id];
    }
    $('base-url').value = status.baseUrl;
    $('local-url').value = status.localBaseUrl;
    renderModels(true);
    notice('');
  } catch (error) { notice(error.message, true); }
  finally { $('refresh').disabled = false; }
}
async function copy(value, message) {
  try { await navigator.clipboard.writeText(value); notice(message); }
  catch { notice('Clipboard access was unavailable. Select and copy the endpoint field manually.', true); }
}
$('refresh').addEventListener('click', refresh);
$('provider').addEventListener('change', () => renderModels());
$('model').addEventListener('change', updateSelection);
$('custom-model').addEventListener('input', updateSelection);
$('save-model').addEventListener('click', async () => {
  const provider = $('provider').value, model = selectedModel().slice(provider.length + 1);
  $('save-model').disabled = true;
  try {
    const result = await request('/api/models/default', { method: 'POST', body: JSON.stringify({ provider, model }) });
    loadedStatus = { ...loadedStatus, ...result };
    $(provider + '-model').textContent = result.upstreamModels[provider];
    renderModels(true);
    notice(`Default saved: ${provider} now uses ${model}. Existing requests keep their selected model.`);
  } catch (error) { notice(error.message, true); }
  finally { updateSelection(); }
});
$('copy-url').addEventListener('click', () => { if (loadedStatus) copy(loadedStatus.baseUrl, 'HTTPS base URL copied. For scripts, use a private tunnel or a configured machine-authenticated route.'); });
$('copy-local').addEventListener('click', () => { if (loadedStatus) copy(loadedStatus.localBaseUrl, 'Local base URL copied.'); });
$('copy-key').addEventListener('click', async () => {
  try { const result = await request('/api/key', { method: 'POST', body: '{}' }); await copy(result.key, 'Gateway key copied. Paste it into your own app’s API-key setting.'); }
  catch (error) { notice(error.message, true); }
});
$('auth-form').addEventListener('submit', event => { event.preventDefault(); localKey = $('local-key').value.trim(); $('local-key').value = ''; refresh(); });
$('cancel').addEventListener('click', () => controller?.abort());
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (controller || !loadedStatus) return;
  controller = new AbortController();
  $('send').disabled = true; $('cancel').hidden = false;
  $('response-wrap').hidden = false;
  const model = selectedModel();
  $('response-provider').textContent = model;
  $('response').textContent = 'Waiting for your provider…';
  const start = Date.now();
  const timer = setInterval(() => { $('elapsed').textContent = `${Math.round((Date.now() - start) / 1000)}s`; }, 1000);
  try {
    const result = await request('/api/chat', { method: 'POST', signal: controller.signal,
      body: JSON.stringify({ model, messages: [{ role: 'user', content: $('prompt').value }] }) });
    $('response').textContent = result.choices[0].message.content;
  } catch (error) { $('response').textContent = error.name === 'AbortError' ? 'Request cancelled.' : error.message; }
  finally {
    clearInterval(timer); controller = undefined;
    $('elapsed').textContent = `${((Date.now() - start) / 1000).toFixed(1)}s`;
    $('send').disabled = false; $('cancel').hidden = true;
  }
});
refresh();
