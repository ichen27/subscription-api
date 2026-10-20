import { ApiError } from './errors.mjs';
import { validateRequest, jsonSchemaOf } from './providers.mjs';
const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
export function authenticateProject(store, authorization) {
  if (!store) throw new ApiError(503, 'review_config_invalid', 'Review configuration is unavailable.');
  const project = store.authenticate(/^Bearer (.+)$/.exec(authorization || '')?.[1]);
  if (!project) throw new ApiError(401, 'unauthorized', 'A project review credential is required.');
  return project;
}
export function allowedAgents(store, project) {
  return store.view().agents.filter(a=>project.allowedAgents.includes(a.name)).map(({name,description,model,effort,timeLimitSeconds})=>({name,description,model,effort,timeLimitSeconds}));
}
export async function resolveReviewRequest(store, project, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(k=>!['agent','repository','commit','base','messages','response_format'].includes(k)))
    throw new ApiError(400,'unsupported_review_request','Send agent, repository, commit, optional base, messages and optional response_format only.');
  const selected=store.view().agents.find(a=>a.name===raw.agent);
  if (!selected) throw new ApiError(404,'unknown_agent','Review agent not found.');
  if (!project.allowedAgents.includes(raw.agent)) throw new ApiError(403,'agent_not_allowed','This project cannot use that agent.');
  if (raw.repository !== project.repository) throw new ApiError(403,'repository_mismatch','The repository must match this project.');
  if (!sha(raw.commit) || (raw.base !== undefined && !sha(raw.base))) throw new ApiError(400,'invalid_commit','Use full 40-character commit SHAs.');
  const body=validateRequest({model:'claude/'+selected.model,messages:raw.messages,...(raw.response_format===undefined?{}:{response_format:raw.response_format})},400_000,{responseFormat:true});
  const snapshot=await store.snapshot(project.name,raw.agent);
  if (snapshot.repository !== raw.repository) throw new ApiError(403,'repository_mismatch','The repository must match this project.');
  return {...snapshot,commit:raw.commit.toLowerCase(),...(raw.base ? {base:raw.base.toLowerCase()} : {}),messages:structuredClone(body.messages),schema:jsonSchemaOf(body)};
}
