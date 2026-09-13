import { inflateRawSync } from 'node:zlib';
import { libraryError, libraryPath, normalizeEntries, REFERENCE_LIBRARY_LIMITS } from './library-files.js';

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index; for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1; return value >>> 0;
});
export function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
const invalid = message => libraryError('library-invalid-zip', message);
const unsupported = message => libraryError('library-unsupported-archive', message);
function extraFields(bytes) {
  for (let offset = 0; offset < bytes.length;) {
    if (offset + 4 > bytes.length) throw invalid('Truncated ZIP extra field.');
    const id = bytes.readUInt16LE(offset), size = bytes.readUInt16LE(offset + 2); offset += 4;
    if (offset + size > bytes.length) throw invalid('Truncated ZIP extra payload.');
    if ([0x0001, 0x000d, 0x756e, 0x7075].includes(id)) throw unsupported('ZIP64, Unix links and alternative Unicode path extra fields are not supported.');
    offset += size;
  }
}
function fileName(bytes, flags) {
  if (!(flags & 0x800) && bytes.some(byte => byte > 127)) throw unsupported('Non-ASCII ZIP names require the UTF-8 flag.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw invalid('ZIP name is not valid UTF-8.'); }
}

/** ZIP only: store/deflate, UTF-8 or ASCII names, bounded full CRC verification. */
export function readZip(bytes, limits = REFERENCE_LIBRARY_LIMITS) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > limits.maxArchiveBytes) throw invalid('ZIP is missing or exceeds its compressed-byte limit.');
  let end = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65557); offset--) {
    if (bytes.readUInt32LE(offset) === 0x06054b50 && offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length) { end = offset; break; }
  }
  if (end < 0) throw invalid('ZIP end-of-directory was not found.');
  const count = bytes.readUInt16LE(end + 10), size = bytes.readUInt32LE(end + 12), start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count !== bytes.readUInt16LE(end + 8)
    || count === 65535 || size === 0xffffffff || start === 0xffffffff) throw unsupported('Multi-disk and ZIP64 archives are not supported.');
  if (count > limits.maxFiles || start + size !== end || !count) throw invalid('ZIP directory count or extent is invalid.');
  const files = [], directories = [], ranges = [];
  let position = start, total = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) throw invalid('Invalid central directory entry.');
    const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10);
    const crc = bytes.readUInt32LE(position + 16), compressed = bytes.readUInt32LE(position + 20), expanded = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28), extraLength = bytes.readUInt16LE(position + 30), commentLength = bytes.readUInt16LE(position + 32);
    const attributes = bytes.readUInt32LE(position + 38), local = bytes.readUInt32LE(position + 42);
    const entryEnd = position + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > end || !nameLength) throw invalid('Truncated ZIP central entry.');
    if ((flags & ~0x080e) || (method !== 0 && method !== 8)) throw unsupported('Encrypted ZIPs and compression methods other than store/deflate are not supported.');
    if (bytes.readUInt16LE(position + 34)) throw unsupported('Multi-disk ZIP is not supported.');
    const unixType = (attributes >>> 16) & 0xf000;
    if ((unixType && unixType !== 0x8000 && unixType !== 0x4000) || (attributes & 0x400)) throw unsupported('Links and non-regular ZIP entries are rejected.');
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength), name = fileName(nameBytes, flags);
    const directory = name.endsWith('/');
    const relative = libraryPath(directory ? name.slice(0, -1) : name);
    if ((unixType === 0x4000 || (attributes & 0x10)) && !directory) throw invalid('Directory attributes conflict with the entry name.');
    extraFields(bytes.subarray(position + 46 + nameLength, position + 46 + nameLength + extraLength));
    if (expanded > limits.maxFileBytes || (total += expanded) > limits.maxTotalBytes
      || expanded > Math.max(1, compressed) * limits.maxCompressionRatio) throw libraryError('library-import-limit', 'ZIP expansion exceeds file, total, or compression-ratio limits.');
    if (local + 30 > start || bytes.readUInt32LE(local) !== 0x04034b50) throw invalid('ZIP local entry is outside its data region.');
    const localNameLength = bytes.readUInt16LE(local + 26), localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength, dataEnd = dataStart + compressed;
    if (dataEnd > start || localNameLength !== nameLength || !bytes.subarray(local + 30, local + 30 + localNameLength).equals(nameBytes)
      || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw invalid('ZIP local and central metadata disagree.');
    extraFields(bytes.subarray(local + 30 + localNameLength, dataStart));
    let rangeEnd = dataEnd;
    if (flags & 8) {
      const descriptor = dataEnd + (dataEnd + 4 <= start && bytes.readUInt32LE(dataEnd) === 0x08074b50 ? 4 : 0);
      if (descriptor + 12 > start || bytes.readUInt32LE(descriptor) !== crc || bytes.readUInt32LE(descriptor + 4) !== compressed
        || bytes.readUInt32LE(descriptor + 8) !== expanded) throw invalid('Invalid ZIP data descriptor.');
      rangeEnd = descriptor + 12;
    } else if (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== expanded) {
      throw invalid('ZIP local sizes or CRC disagree.');
    }
    if (ranges.some(([begin, finish]) => local < finish && rangeEnd > begin)) throw invalid('ZIP data entries overlap.');
    ranges.push([local, rangeEnd]);
    let content;
    try { content = method === 0 ? Buffer.from(bytes.subarray(dataStart, dataEnd)) : inflateRawSync(bytes.subarray(dataStart, dataEnd), { maxOutputLength: Math.max(1, expanded) }); }
    catch { throw invalid('ZIP deflate data is corrupt or exceeds its declared size.'); }
    if (content.length !== expanded || crc32(content) !== crc || (directory && content.length)) throw invalid('ZIP content size or CRC is invalid.');
    if (directory) directories.push(relative); else files.push({ path: relative, bytes: content });
    position = entryEnd;
  }
  if (position !== end) throw invalid('Unexpected central directory bytes.');
  return normalizeEntries(files, directories, limits);
}
