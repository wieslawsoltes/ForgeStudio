/** Dependency-free ZIP writer (STORE, UTF-8, CRC32). No network or build step. */
const table = new Uint32Array(256);
for (let i = 0; i < 256; i++) { let c=i; for(let j=0;j<8;j++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1; table[i]=c; }
export function crc32(bytes) { let c=0xffffffff; for (const b of bytes) c=table[(c^b)&255] ^ c>>>8; return (c^0xffffffff)>>>0; }
export function createZip(files) {
  const encoder = new TextEncoder(), local=[], central=[]; let offset=0;
  const now=new Date(), date=((now.getFullYear()-1980)<<9)|((now.getMonth()+1)<<5)|now.getDate(), time=(now.getHours()<<11)|(now.getMinutes()<<5)|(now.getSeconds()>>1);
  for (const [path,text] of Object.entries(files)) {
    const name=encoder.encode(path), data=encoder.encode(text), crc=crc32(data);
    const header=new Uint8Array(30+name.length), v=new DataView(header.buffer);
    v.setUint32(0,0x04034b50,true); v.setUint16(4,20,true); v.setUint16(6,0x800,true);
    v.setUint16(10,time,true); v.setUint16(12,date,true); v.setUint32(14,crc,true);
    v.setUint32(18,data.length,true); v.setUint32(22,data.length,true); v.setUint16(26,name.length,true); header.set(name,30);
    local.push(header,data);
    const entry=new Uint8Array(46+name.length), c=new DataView(entry.buffer);
    c.setUint32(0,0x02014b50,true); c.setUint16(4,20,true); c.setUint16(6,20,true); c.setUint16(8,0x800,true);
    c.setUint16(12,time,true); c.setUint16(14,date,true); c.setUint32(16,crc,true);
    c.setUint32(20,data.length,true); c.setUint32(24,data.length,true); c.setUint16(28,name.length,true); c.setUint32(42,offset,true);
    entry.set(name,46); central.push(entry); offset+=header.length+data.length;
  }
  const centralSize=central.reduce((s,b)=>s+b.length,0), end=new Uint8Array(22), e=new DataView(end.buffer);
  e.setUint32(0,0x06054b50,true); e.setUint16(8,central.length,true); e.setUint16(10,central.length,true); e.setUint32(12,centralSize,true); e.setUint32(16,offset,true);
  return new Blob([...local,...central,end],{type:'application/zip'});
}
export function download(name,data,type='application/octet-stream') {
  const blob=data instanceof Blob?data:new Blob([data],{type}), url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(url),30000);
}
