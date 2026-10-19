import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {extractRepository,downloadRepository,ARCHIVE_LIMITS} from '../src/repository-archive.mjs';
function archive(entries){const chunks=[];for(const {name,type='0',text=''}of entries){const data=Buffer.from(text),header=Buffer.alloc(512);header.write(name);header.write('0000644\0',100);header.write(data.length.toString(8).padStart(11,'0')+'\0',124);header.fill(32,148,156);header[156]=type.charCodeAt(0);let sum=0;for(const byte of header)sum+=byte;header.write(sum.toString(8).padStart(6,'0')+'\0 ',148);chunks.push(header,data,Buffer.alloc((512-data.length%512)%512));}return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]));}
async function directory(t){const root=await mkdtemp(path.join(os.tmpdir(),'review-archive-'));t.after(()=>rm(root,{recursive:true,force:true}));return root;}
test('extracts regular source files, strips one root, and rejects unsafe archive entries',async t=>{
  const root=await directory(t),good=archive([{name:'repo/',type:'5'},{name:'repo/src/index.js',text:'source'}]);
  assert.equal((await extractRepository(good,path.join(root,'good'))).bytes,6);assert.equal(await readFile(path.join(root,'good/src/index.js'),'utf8'),'source');
  for(const [i,entries]of [
    [{name:'../outside',text:'bad'}],[{name:'/absolute',text:'bad'}],[{name:'repo/../outside',text:'bad'}],
    [{name:'repo/link',type:'2'}],[{name:'repo/hard',type:'1'}],[{name:'repo/device',type:'3'}],
    [{name:'one/file'},{name:'two/file'}],[{name:'repo/duplicate'},{name:'repo/duplicate'}],
    [{name:'repo/parent',text:'file'},{name:'repo/parent/child'}],
  ].entries())await assert.rejects(extractRepository(archive(entries),path.join(root,String(i))),e=>e.code==='unsafe_repository_archive');
  await assert.rejects(extractRepository(good,path.join(root,'limit'),{...ARCHIVE_LIMITS,expanded:100}),e=>e.code==='repository_too_large');
});
test('host download sends token only to GitHub API and bounds redirects and body size',async t=>{
  const root=await directory(t),bytes=archive([{name:'repo/readme',text:'ok'}]),calls=[];
  const fetcher=async(url,options)=>{calls.push({url:String(url),...options});return calls.length===1?new Response(null,{status:302,headers:{location:'https://codeload.github.com/owner/repo/legacy.tar.gz/'+ 'a'.repeat(40)}}):new Response(bytes);};
  await downloadRepository('owner/repo','a'.repeat(40),'TEST_PRIVATE_TOKEN',path.join(root,'good'),{fetcher});
  assert.equal(calls[0].headers.authorization,'Bearer TEST_PRIVATE_TOKEN');assert.equal(calls[1].headers.authorization,undefined);assert.equal(calls[1].redirect,'error');
  for(const location of ['http://codeload.github.com/x','https://evil.test/x','https://user@codeload.github.com/x'])await assert.rejects(downloadRepository('owner/repo','a'.repeat(40),'secret',path.join(root,'bad'),{fetcher:async()=>new Response(null,{status:302,headers:{location}})}),e=>e.code==='repository_download_failed');
  await assert.rejects(downloadRepository('owner/repo','a'.repeat(40),undefined,path.join(root,'big'),{fetcher:async()=>new Response(bytes),limits:{...ARCHIVE_LIMITS,compressed:10}}),e=>e.code==='repository_too_large');
  await assert.rejects(downloadRepository('owner/repo','a'.repeat(40),undefined,path.join(root,'missing'),{fetcher:async()=>new Response(null,{status:404})}),e=>e.code==='commit_not_found');
});

test('archive extraction honors cancellation while writing source entries',async t=>{
  const root=await directory(t),controller=new AbortController();
  const compressed=archive(Array.from({length:1000},(_,i)=>({name:'repo/file-'+i,text:'source'})));
  const timer=setTimeout(()=>controller.abort(),10);
  await assert.rejects(extractRepository(compressed,root,ARCHIVE_LIMITS,controller.signal),e=>e.code==='cancelled');clearTimeout(timer);
});
