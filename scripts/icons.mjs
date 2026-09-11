import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function rgbFromOklch(L,C,h) {
  const a=C*Math.cos(h*Math.PI/180), b=C*Math.sin(h*Math.PI/180);
  const l=(L+.3963377774*a+.2158037573*b)**3, m=(L-.1055613458*a-.0638541728*b)**3, s=(L-.0894841775*a-1.291485548*b)**3;
  return [4.0767416621*l-3.3077115913*m+.2309699292*s,-1.2684380046*l+2.6097574011*m-.3413193965*s,-.0041960863*l-.7034186147*m+1.707614701*s]
    .map(v=>Math.round(255*Math.max(0,Math.min(1,v<=.0031308?12.92*v:1.055*v**(1/2.4)-.055))));
}
function crc32(buffer) { let crc=0xffffffff;for(const byte of buffer){crc^=byte;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0; }
function chunk(type,data) {const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([name,data])));return Buffer.concat([length,name,data,crc]);}
function distance(x,y,x1,y1,x2,y2) {const dx=x2-x1,dy=y2-y1,t=Math.max(0,Math.min(1,((x-x1)*dx+(y-y1)*dy)/(dx*dx+dy*dy)));return Math.hypot(x-x1-t*dx,y-y1-t*dy);}
function makeIcon(size) {
  const color=rgbFromOklch(.53,.17,35), raw=Buffer.alloc(size*(1+size*4));
  const lines=[[8,7,16,7],[16,7,20,11],[20,11,20,21],[20,21,8,21],[8,21,8,7],[16,7,16,12],[16,12,20,12],[14,13,14,18],[11,16,14,19],[14,19,17,16]];
  for(let y=0;y<size;y++)for(let x=0;x<size;x++) {
    const values=[0,0,0,0];
    for(let sy=0;sy<4;sy++)for(let sx=0;sx<4;sx++) {
      const px=(x+(sx+.5)/4)*28/size,py=(y+(sy+.5)/4)*28/size;
      const cx=Math.max(7,Math.min(21,px)),cy=Math.max(7,Math.min(21,py));
      if(Math.hypot(px-cx,py-cy)>7)continue;
      const white=lines.some(line=>distance(px,py,...line)<.8);
      for(let c=0;c<3;c++)values[c]+=white?255:color[c];values[3]++;
    }
    const offset=y*(1+size*4)+1+x*4;
    for(let c=0;c<3;c++)raw[offset+c]=values[3]?Math.round(values[c]/values[3]):0;
    raw[offset+3]=Math.round(values[3]*255/16);
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(raw)),chunk('IEND',Buffer.alloc(0))]);
}
export async function writeIcons(directory) {await mkdir(directory,{recursive:true});for(const size of [16,32,48,128])await writeFile(join(directory,`${size}.png`),makeIcon(size));}
