import { createFile } from 'mp4box';
import fs from 'node:fs';

const buf = fs.readFileSync(new URL('./fixtures/test-hevc.mp4', import.meta.url));
const file = createFile(true);
const SC = Buffer.from([0, 0, 0, 1]);
const chunks = [];

file.onReady = (info) => {
  const v = info.videoTracks[0];
  const moov = file.boxes.find((b) => b.type === 'moov');
  const trak = moov.boxes.find((b) => b.type === 'trak');
  const stsd = trak.boxes.find((b)=>b.type==='mdia').boxes.find((b)=>b.type==='minf').boxes.find((b)=>b.type==='stbl').boxes.find((b)=>b.type==='stsd');
  const hvcC = stsd.entries[0].hvcC;
  // 写参数集
  for (const arr of hvcC.nalu_arrays) {
    if (![32,33,34].includes(arr.nalu_type)) continue;
    for (let i=0;i<arr.length;i++) chunks.push(SC, Buffer.from(arr[i].data));
  }
  file.setExtractionOptions(v.id, undefined, { nbSamples: 30 });
  file.start();
};
file.onSamples = (id, user, samples) => {
  for (const s of samples) {
    const d = s.data; let p = 0;
    while (p + 4 <= d.length) {
      const len = (d[p]<<24)|(d[p+1]<<16)|(d[p+2]<<8)|d[p+3]; p += 4;
      if (len <= 0 || p+len > d.length) break;
      chunks.push(SC, Buffer.from(d.subarray(p, p+len)));
      p += len;
    }
  }
};
for (let i=0;i<buf.length;i+=256*1024){const c=buf.subarray(i,Math.min(i+256*1024,buf.length));const ab=c.buffer.slice(c.byteOffset,c.byteOffset+c.byteLength);file.appendBuffer(Object.assign(ab,{fileStart:i}));}
file.appendBuffer(Object.assign(new ArrayBuffer(0),{fileStart:buf.length}), true);

setTimeout(() => {
  const out = Buffer.concat(chunks);
  fs.writeFileSync(new URL('./fixtures/test.hevc', import.meta.url), out);
  console.log('Annex-B 流已生成:', out.length, '字节, NALU 数约', chunks.length/2);
  process.exit(0);
}, 1000);
