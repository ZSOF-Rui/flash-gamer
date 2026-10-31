'use strict';

const zlib = require('zlib');

// 4399 的部分加载壳把真正的游戏 SWF 以 DefineBinaryData 内嵌，再用 Loader 载入。
// 内嵌游戏自带同一套 4399 壳代码，发现 loaderInfo.loader 非空且页面不在 4399 域时，
// 会以 "No running in a loader."（不允许加壳运行）拒绝启动。Ruffle 播放外层时正好
// 命中该条件，画面停在加载页；把内嵌 SWF 抽出来作为顶层影片播放即可正常进入游戏。
const ANTI_LOADER_MARK = Buffer.from('No running in a loader', 'latin1');
const MIN_INNER_SIZE = 1024 * 1024;

function inflateBody(buf) {
  const sig = buf.subarray(0, 3).toString('latin1');
  if (sig === 'FWS') return buf.subarray(8);
  if (sig === 'CWS') {
    try { return zlib.inflateSync(buf.subarray(8)); } catch { return null; }
  }
  return null;
}

function validInnerSwf(data) {
  if (data.length < MIN_INNER_SIZE) return false;
  const sig = data.subarray(0, 3).toString('latin1');
  if (sig !== 'FWS' && sig !== 'CWS' && sig !== 'ZWS') return false;
  const declared = data.readUInt32LE(4);
  if (sig === 'FWS') return declared === data.length;
  return declared >= data.length - 8 && declared <= 1024 * 1024 * 1024;
}

function largestEmbeddedSwf(body) {
  if (!body || body.length < 9) return null;
  const nbits = body[0] >> 3;
  let pos = Math.ceil((5 + 4 * nbits) / 8) + 4;
  let best = null;
  while (pos + 2 <= body.length) {
    const header = body.readUInt16LE(pos);
    pos += 2;
    const code = header >> 6;
    let len = header & 0x3f;
    if (len === 0x3f) {
      if (pos + 4 > body.length) break;
      len = body.readUInt32LE(pos);
      pos += 4;
    }
    if (pos + len > body.length) break;
    if (code === 87 && len > 6 + MIN_INNER_SIZE) { // DefineBinaryData
      const data = body.subarray(pos + 6, pos + len);
      if (validInnerSwf(data) && (!best || data.length > best.length)) best = Buffer.from(data);
    }
    if (code === 0) break;
    pos += len;
  }
  return best;
}

function extractInnerSwf(buf) {
  if (!buf || buf.length < 16) return null;
  const sig = buf.subarray(0, 3).toString('latin1');
  if (sig !== 'FWS' && sig !== 'CWS') return null;
  const body = inflateBody(buf);
  if (!body || !body.includes(ANTI_LOADER_MARK)) return null;
  return largestEmbeddedSwf(body);
}

module.exports = { extractInnerSwf };
