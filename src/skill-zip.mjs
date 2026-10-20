import { inflateRawSync } from 'node:zlib';
import { ApiError } from './errors.mjs';
import { skillPath, validateSkillFiles } from './review-config.mjs';
const invalid = () => new ApiError(400, 'invalid_skill_archive', 'Upload a ZIP containing at most 1 MB of text files, including SKILL.md. Links, encrypted files and ZIP64 are unsupported.');
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
// Parse bounded ZIP data in memory. No archive paths are ever given to an extractor.
export function skillZip(encoded) {
  try {
    if (typeof encoded !== 'string' || encoded.length > 1_600_000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw invalid();
    const zip = Buffer.from(encoded, 'base64');
    let end = -1;
    for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--)
      if (zip.readUInt32LE(i) === 0x06054b50 && i + 22 + zip.readUInt16LE(i + 20) === zip.length) { end = i; break; }
    if (end < 0 || zip.readUInt16LE(end+4) || zip.readUInt16LE(end+6)) throw invalid();
    const count = zip.readUInt16LE(end+10), size = zip.readUInt32LE(end+12), start = zip.readUInt32LE(end+16);
    if (!count || count > 100 || count !== zip.readUInt16LE(end+8) || start + size !== end) throw invalid();
    const decoder = new TextDecoder('utf-8', {fatal:true}), entries = [], names = new Set(), spans = [];
    let at = start, total = 0;
    for (let i=0;i<count;i++) {
      if (at+46 > end || zip.readUInt32LE(at) !== 0x02014b50) throw invalid();
      const flags = zip.readUInt16LE(at+8), method = zip.readUInt16LE(at+10), crc = zip.readUInt32LE(at+16);
      const compressed = zip.readUInt32LE(at+20), expanded = zip.readUInt32LE(at+24), length = zip.readUInt16LE(at+28);
      const next = at+46+length+zip.readUInt16LE(at+30)+zip.readUInt16LE(at+32), offset = zip.readUInt32LE(at+42);
      const mode = (zip.readUInt32LE(at+38) >>> 16) & 0xf000;
      if (next > end || flags & ~0x808 || ![0,8].includes(method) || ![0,0x4000,0x8000].includes(mode) || zip.readUInt16LE(at+34)) throw invalid();
      const name = decoder.decode(zip.subarray(at+46,at+46+length));
      const directory = name.endsWith('/'); skillPath(directory ? name.slice(0,-1) : name);
      if (names.has(name) || (mode === 0x4000 && !directory)) throw invalid(); names.add(name);
      total += expanded; if (total > 1_000_000 || (directory && expanded)) throw invalid();
      if (offset+30 > start || zip.readUInt32LE(offset) !== 0x04034b50 || zip.readUInt16LE(offset+6) !== flags || zip.readUInt16LE(offset+8) !== method) throw invalid();
      const localLength = zip.readUInt16LE(offset+26), data = offset+30+localLength+zip.readUInt16LE(offset+28), stop = data+compressed;
      if (data > start || stop > start || decoder.decode(zip.subarray(offset+30,offset+30+localLength)) !== name || spans.some(([a,b]) => offset < b && stop > a)) throw invalid();
      spans.push([offset,stop]);
      const packed = zip.subarray(data,stop), bytes = method === 0 ? packed : inflateRawSync(packed,{maxOutputLength:Math.max(1,expanded)});
      if (bytes.length !== expanded || crc32(bytes) !== crc) throw invalid();
      if (!directory) entries.push([name,decoder.decode(bytes)]);
      at = next;
    }
    if (at !== end) throw invalid();
    const prefix = entries.some(([name]) => name === 'SKILL.md') ? '' : entries[0]?.[0].split('/')[0] + '/';
    const files = Object.create(null);
    for (const [name,content] of entries) {
      if (!name.startsWith(prefix)) throw invalid();
      const relative = name.slice(prefix.length); skillPath(relative); files[relative] = content;
    }
    validateSkillFiles(files); return files;
  } catch { throw invalid(); }
}
