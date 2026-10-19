import {gunzip} from 'node:zlib';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {possibleInjection} from './review-agents.mjs';
import {ApiError} from './errors.mjs';
const unzip=promisify(gunzip);
export const ARCHIVE_LIMITS=Object.freeze({compressed:200_000_000,expanded:500_000_000,entries:100_000,timeoutMs:60_000});
const unsafe=()=>new ApiError(422,'unsafe_repository_archive','The repository archive contains unsupported or unsafe entries.');
const oversized=()=>new ApiError(413,'repository_too_large','The repository exceeds the archive limits.');
const decoder=new TextDecoder('utf-8',{fatal:true});
function name(bytes){const end=bytes.indexOf(0);return decoder.decode(end<0?bytes:bytes.subarray(0,end));}
function number(bytes){const value=name(bytes).trim();if(!/^[0-7]*$/.test(value))throw unsafe();const n=parseInt(value||'0',8);if(!Number.isSafeInteger(n))throw unsafe();return n;}
function safePath(value){if(!value||value.length>4096||value.startsWith('/')||/[\\\x00-\x1f]/.test(value)||value.split('/').some(p=>p==='..'||p==='.'||!p))throw unsafe();return value;}
function pax(bytes){
  const out=Object.create(null);let at=0;
  while(at<bytes.length){const space=bytes.indexOf(32,at);if(space<0)throw unsafe();const raw=bytes.subarray(at,space).toString('ascii');if(!/^[1-9][0-9]*$/.test(raw))throw unsafe();const size=Number(raw),end=at+size;if(end>bytes.length||end<=space+1||bytes[end-1]!==10)throw unsafe();const line=decoder.decode(bytes.subarray(space+1,end-1)),split=line.indexOf('=');if(split<1)throw unsafe();const key=line.slice(0,split);if(Object.hasOwn(out,key))throw unsafe();out[key]=line.slice(split+1);at=end;}
  return out;
}
export async function extractRepository(compressed,destination,limits=ARCHIVE_LIMITS){
  if(compressed.length>limits.compressed)throw oversized();
  let tar;
  try{tar=await unzip(compressed,{maxOutputLength:limits.expanded});}catch(error){if(error.code==='ERR_BUFFER_TOO_LARGE')throw oversized();throw unsafe();}
  let at=0,entries=0,total=0,root,pending={},ended=false,scanned=0,possiblePromptInjection=false;
  const paths=new Set();
  await mkdir(destination,{recursive:true,mode:0o755});
  try{
    while(at+512<=tar.length){
      const header=tar.subarray(at,at+512);at+=512;
      if(header.every(b=>b===0)){if(at+512>tar.length||!tar.subarray(at).every(b=>b===0))throw unsafe();ended=true;break;}
      if(++entries>limits.entries)throw oversized();
      let checksum=0;for(let i=0;i<512;i++)checksum+=i>=148&&i<156?32:header[i];if(checksum!==number(header.subarray(148,156)))throw unsafe();
      const size=number(header.subarray(124,136)),type=String.fromCharCode(header[156]||48);
      if(size>limits.expanded||at+Math.ceil(size/512)*512>tar.length)throw unsafe();
      const bytes=tar.subarray(at,at+size);at+=Math.ceil(size/512)*512;
      if(['g','x','L'].includes(type)){
        if(size>64_000)throw unsafe();
        if(type==='L'){if(Object.keys(pending).length)throw unsafe();pending={path:name(bytes).replace(/\n$/,'')};}
        else {const attributes=pax(bytes);if(type==='g'){if(Object.keys(attributes).some(k=>!['comment','mtime','atime','ctime'].includes(k)))throw unsafe();}else {if(Object.keys(pending).length)throw unsafe();pending=attributes;}}
        continue;
      }
      if(!['0','5'].includes(type)||pending.linkpath!==undefined||pending.size!==undefined&&Number(pending.size)!==size)throw unsafe();
      const prefix=name(header.subarray(345,500)),raw=pending.path??(prefix?prefix+'/':'')+name(header.subarray(0,100));pending={};
      const full=safePath(raw.replace(/\/$/,'')),parts=full.split('/');
      if(root===undefined)root=parts[0];if(parts[0]!==root)throw unsafe();
      const relative=parts.slice(1).join('/');if(!relative){if(type!=='5')throw unsafe();continue;}
      if(paths.has(relative))throw unsafe();paths.add(relative);
      const target=path.join(destination,relative);
      if(type==='5'){if(size)throw unsafe();await mkdir(target,{recursive:true,mode:0o755});}
      else {if(scanned<10_000_000&&size<=2_000_000){scanned+=size;possiblePromptInjection ||= possibleInjection(bytes.toString('utf8'));}total+=size;if(total>limits.expanded)throw oversized();await mkdir(path.dirname(target),{recursive:true,mode:0o755});await writeFile(target,bytes,{flag:'wx',mode:0o444});}
    }
    if(!ended||Object.keys(pending).length||!root)throw unsafe();
  }catch(error){if(error instanceof ApiError)throw error;throw unsafe();}
  return {entries,bytes:total,possiblePromptInjection};
}
export async function downloadRepository(repository,commit,token,destination,{signal,fetcher=fetch,limits=ARCHIVE_LIMITS}={}){
  const timeout=AbortSignal.timeout(limits.timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout;
  try{
    let url=new URL(`https://api.github.com/repos/${repository}/tarball/${commit}`);
    let response=await fetcher(url,{redirect:'manual',signal:combined,headers:{accept:'application/vnd.github+json','x-github-api-version':'2022-11-28',...(token?{authorization:'Bearer '+token}:{})}});
    if(response.status===404||response.status===401||response.status===403)throw new ApiError(422,'commit_not_found','The commit does not exist or the project token cannot read it.');
    if([301,302,303,307,308].includes(response.status)){
      const location=response.headers.get('location');await response.body?.cancel();
      url=new URL(location);
      if(url.protocol!=='https:'||url.hostname!=='codeload.github.com'||url.port||url.username||url.password)throw new Error('Unexpected redirect');
      // GitHub's signed redirect is sufficient; never forward the project token.
      response=await fetcher(url,{redirect:'error',signal:combined,headers:{accept:'application/gzip'}});
    }
    if(response.status===404)throw new ApiError(422,'commit_not_found','The commit does not exist or the project token cannot read it.');
    if(!response.ok)throw new Error('Download failed');
    if(Number(response.headers.get('content-length'))>limits.compressed){await response.body?.cancel();throw oversized();}
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>limits.compressed)throw oversized();chunks.push(chunk);}
    if(combined.aborted)throw new Error('Aborted');
    return await extractRepository(Buffer.concat(chunks),destination,limits);
  }catch(error){
    if(signal?.aborted)throw new ApiError(499,'cancelled','Review cancelled.');
    if(error instanceof ApiError)throw error;
    throw new ApiError(502,'repository_download_failed','The repository download failed or timed out.');
  }
}
