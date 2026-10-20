const $ = id => document.getElementById(id);
let config;
function notice(text, error = false) { $('notice').textContent = text; $('notice').className = error ? 'error' : ''; }
async function request(action = 'config', body) {
  const response = await fetch('/api/review/' + action, { method: body === undefined ? 'GET' : 'POST', headers: {'content-type':'application/json'}, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Request failed.');
  return result;
}
function clearKey() { $('new-key').value = ''; $('one-time-key').hidden = true; }
async function mutate(action, body) {
  clearKey();
  const result = await request(action,body);
  if (result.key) { $('new-key').value = result.key; $('one-time-key').hidden = false; }
  await refresh(); notice(result.key ? 'Saved. Copy the new project key above before leaving.' : 'Saved.');
}
async function perform(work, button) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try { await work(); } catch (error) { notice(error.message,true); }
  finally { if (button) button.disabled = false; }
}
function selected(id) { return Array.from($(id).selectedOptions, o => o.value); }
function options(id, values, labels) {
  const previous = selected(id);
  $(id).replaceChildren(...values.map((value,index) => new Option(labels[index],value,false,previous.includes(value))));
}
function button(text, action) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'secondary'; b.textContent = text;
  b.addEventListener('click', () => perform(action,b)); return b;
}
function card(title, detail, buttons) {
  const article = document.createElement('article'); article.className = 'review-item';
  const h = document.createElement('h3'), p = document.createElement('p'), actions = document.createElement('div');
  h.textContent = title; p.textContent = detail; actions.className = 'review-actions'; actions.append(...buttons); article.append(h,p,actions); return article;
}
function fill(type, value) {
  clearKey(); const form = $(type+'-form'); form.reset();
  for (const [key,v] of Object.entries(value)) {
    const field = form.elements.namedItem(key); if (!field || key === 'githubToken') continue;
    if (field.multiple) Array.from(field.options).forEach(option => {option.selected = v.includes(option.value);});
    else field.value = v;
  }
  $(type+'-name').readOnly = true; $(type+'-title').textContent = 'Edit '+type;
  if (type === 'project') $('project-token').placeholder = value.hasGitHubToken ? 'Token set; leave blank to keep' : 'No token set';
  $(type+'-form').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function reset(type) {
  $(type+'-form').reset(); $(type+'-name').readOnly = false; $(type+'-title').textContent = 'Create '+type;
  if (type === 'project') $('project-token').placeholder = '';
}
function remove(type,id) {
  if (!window.confirm(`Delete ${type.slice(0,-1)} “${id}”?`)) return;
  return mutate(type+'/delete',{[type === 'skills' ? 'id' : 'name']:id});
}
async function refresh() {
  config = await request(); $('settings').hidden = false;
  options('agent-skills',config.skills.map(s=>s.id),config.skills.map(s=>s.name));
  options('project-agents',config.agents.map(a=>a.name),config.agents.map(a=>a.name));
  $('agents-list').replaceChildren(...config.agents.map(a=>card(a.name,`${a.description} · ${a.model} · ${a.effort}. Projects: ${config.projects.filter(p=>p.allowedAgents.includes(a.name)).map(p=>p.name).join(', ') || 'none'}`,[button('Edit',()=>fill('agent',a)),button('Delete',()=>remove('agents',a.name))])));
  $('skills-list').replaceChildren(...config.skills.map(s=>card(s.name,`${s.id} · ${s.description} · Updated ${new Date(s.updatedAt).toLocaleString()}`,[button('Replace',()=>{$('skill-id').value=s.id;$('skill-text').value='';$('skill-zip').value='';}),button('Delete',()=>remove('skills',s.id))])));
  $('projects-list').replaceChildren(...config.projects.map(p=>card(p.name,`${p.repository} · Token ${p.hasGitHubToken?'set':'not set'} · Agents: ${p.allowedAgents.join(', ') || 'none'}`,[button('Edit',()=>fill('project',p)),button('Rotate key',()=>{if(window.confirm(`Revoke the current key for “${p.name}” and create a new one? Update CI afterward.`))return mutate('projects/rotate-key',{name:p.name});}),button('Delete',()=>remove('projects',p.name))])));
  for (const type of ['agents','skills','projects']) if (!config[type].length) $(type+'-list').textContent = 'None yet. Use the form to add one.';
}
for (const tab of document.querySelectorAll('[data-tab]')) tab.addEventListener('click',()=>{
  clearKey();
  for (const other of document.querySelectorAll('[data-tab]')) {const active=other===tab;other.setAttribute('aria-pressed',String(active));other.className=active?'':'secondary';}
  for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden=panel.dataset.panel!==tab.dataset.tab;
});
for (const b of document.querySelectorAll('[data-reset]')) b.addEventListener('click',()=>reset(b.dataset.reset));
$('agent-form').addEventListener('submit',event=>{
  event.preventDefault(); perform(async()=>{const data=Object.fromEntries(new FormData(event.target));data.skills=selected('agent-skills');data.timeLimitSeconds=Number(data.timeLimitSeconds);data.maxToolSteps=Number(data.maxToolSteps);await mutate('agents',data);reset('agent');},event.submitter);
});
$('project-form').addEventListener('submit',event=>{
  event.preventDefault(); perform(async()=>{const data=Object.fromEntries(new FormData(event.target));data.allowedAgents=selected('project-agents');if($('clear-token').checked)data.githubToken='';else if(!data.githubToken)delete data.githubToken;await mutate('projects',data);reset('project');},event.submitter);
});
$('skill-form').addEventListener('submit',event=>{
  event.preventDefault(); perform(async()=>{
    const file=$('skill-zip').files[0], data={id:$('skill-id').value};
    if(file){if(file.size>1_200_000)throw new Error('ZIP must be at most 1.2 MB compressed and 1 MB expanded.');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));data.zip=btoa(binary);}
    else data.files={'SKILL.md':$('skill-text').value};
    await mutate('skills',data);event.target.reset();
  },event.submitter);
});
$('reload').addEventListener('click',event=>perform(async()=>{clearKey();await refresh();notice('Refreshed.');},event.target));
$('dismiss-key').addEventListener('click',clearKey);
$('copy-key').addEventListener('click',event=>perform(async()=>{await navigator.clipboard.writeText($('new-key').value);notice('Project key copied.');},event.target));
window.addEventListener('pagehide',clearKey);
perform(refresh);
