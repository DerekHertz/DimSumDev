import {createHash} from 'node:crypto';

// Append-only membership for one run, independent of the scrolling/correlation ledgers.
// Fixed 8 KiB, released with the run; collisions/saturation can only make an unknown
// observation uncorrelated, never revive a retired identity. No IDs or payloads retained.
export function createToolReplayFilter(bytes=8192){
 const bits=new Uint8Array(bytes);
 return {seen(id){
  const hash=createHash('sha256').update(id).digest();let seen=true;
  for(let i=0;i<4;i++){
   const bit=hash.readUInt32BE(i*4)%(bits.length*8),byte=bit>>>3,mask=1<<(bit&7);
   if(!(bits[byte]&mask))seen=false;
   bits[byte]|=mask;
  }
  return seen;
 }};
}
