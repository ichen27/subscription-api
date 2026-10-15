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
    $('example').textContent = `curl ${status.localBaseUrl}/chat/completions \\\n  -H "Authorization: Bearer $GATEWAY_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"chatgpt","messages":[{"role":"user","content":"Hello"}]}'`;
    notice('');
  } catch (error) { notice(error.message, true); }
  finally { $('refresh').disabled = false; }
}
async function copy(value, message) {
  try { await navigator.clipboard.writeText(value); notice(message); }
  catch { notice('Clipboard access was unavailable. Select and copy the endpoint field manually.', true); }
}
$('refresh').addEventListener('click', refresh);
$('copy-url').addEventListener('click', () => { if (loadedStatus) copy(loadedStatus.baseUrl, 'HTTPS base URL copied. Remote clients also need Cloudflare Access authentication.'); });
$('copy-local').addEventListener('click', () => { if (loadedStatus) copy(loadedStatus.localBaseUrl, 'Local base URL copied.'); });
$('copy-key').addEventListener('click', async () => {
  try { const result = await request('/api/key', { method: 'POST', body: '{}' }); await copy(result.key, 'Gateway key copied. Paste it into your own app’s API-key setting.'); }
  catch (error) { notice(error.message, true); }
});
$('auth-form').addEventListener('submit', event => { event.preventDefault(); localKey = $('local-key').value.trim(); $('local-key').value = ''; refresh(); });
$('cancel').addEventListener('click', () => controller?.abort());
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (controller) return;
  controller = new AbortController();
  $('send').disabled = true; $('cancel').hidden = false;
  $('response-wrap').hidden = false;
  const model = $('provider').value;
  $('response-provider').textContent = model === 'chatgpt' ? 'CHATGPT' : 'CLAUDE';
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
