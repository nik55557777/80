/**
 * Minimal ZIP writer (store method) used to package the plugin SDK for
 * download — no external dependencies.
 */
export function buildZipBlob(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const data = content instanceof Uint8Array ? content : enc.encode(content);
    const nameB = enc.encode(name);
    const crc = crc32(data);
    const local = new Uint8Array(30 + nameB.length);
    const dv = new DataView(local.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, data.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameB.length, true);
    local.set(nameB, 30);
    chunks.push(local, data);
    const c = new Uint8Array(46 + nameB.length);
    const cd = new DataView(c.buffer);
    cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
    cd.setUint16(28, nameB.length, true); cd.setUint32(42, offset, true);
    c.set(nameB, 46);
    central.push(c);
    offset += local.length + data.length;
  }
  const centralSize = central.reduce((a, b) => a + b.length, 0);
  const eocd = new Uint8Array(22);
  const ed = new DataView(eocd.buffer);
  ed.setUint32(0, 0x06054b50, true);
  ed.setUint16(8, files.length, true); ed.setUint16(10, files.length, true);
  ed.setUint32(12, centralSize, true); ed.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, eocd], { type: 'application/zip' });
}

let _t = null;
function crc32(buf) {
  if (!_t) {
    _t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; _t[i] = c >>> 0; }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = _t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export default { buildZipBlob };
