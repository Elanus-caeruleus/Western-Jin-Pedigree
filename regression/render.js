const fs=require('fs');
function svgOf(v, title){
  const W=136,H=56; const b=v.bounds; const pad=120;
  let minX=b.minX-pad, maxX=b.maxX+pad, minY=b.minY-pad, maxY=b.maxY+pad+80;
  const o=[];
  o.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${minX} ${minY} ${maxX-minX} ${maxY-minY}" width="${(maxX-minX)*0.6}" height="${(maxY-minY)*0.6}" font-family="Noto Sans CJK SC"><rect x="${minX}" y="${minY}" width="100%" height="100%" fill="#f5f3ef"/>`);
  o.push(`<text x="${minX+10}" y="${minY+24}" font-size="20" fill="#900">${title||''}</text>`);
  v.lines.forEach(l=>o.push(`<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="${l.gray?'#bbb':'#888'}" stroke-width="1.6"/>`));
  v.pairLines.forEach(l=>o.push(`<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="#444" stroke-width="${l.style==='thin'?1.6:4.2}"/>`));
  (v.kinLines||[]).forEach(k=>{ if(k.kind==='cross')return; const t=k.top; o.push(`<path d="M${k.x1} ${k.yCard} V${t} H${k.x2} V${k.yCard}" stroke="#9a7b3f" fill="none" stroke-dasharray="6 4"/>`); o.push(`<text x="${(k.x1+k.x2)/2}" y="${t-3}" font-size="12" text-anchor="middle" fill="#7a5f2a">${k.label}</text>`)});
  v.cards.forEach(c=>{ const rx=c.gender==='F'?18:2; o.push(`<g opacity="${c.gray?0.45:1}"><rect x="${c.x-W/2}" y="${c.y-H/2}" width="${W}" height="${H}" rx="${rx}" fill="${c.fill||'#fff'}" stroke="#222" stroke-width="${c.selected?4:1.2}"/><text x="${c.x}" y="${c.y-4}" font-size="15" font-weight="700" text-anchor="middle" fill="${c.text||'#000'}">${c.name.replace(/[(（].*?[)）]/g,'')}</text><text x="${c.x}" y="${c.y+14}" font-size="10" text-anchor="middle" fill="${c.text||'#000'}">${(c.zi||'').slice(0,14)}</text></g>`)});
  v.icons.forEach(i=>o.push(`<circle cx="${i.x}" cy="${i.y}" r="9" fill="${i.fill}" stroke="#555"/>`));
  v.chips.forEach(c=>o.push(`<circle cx="${c.x}" cy="${c.y}" r="11" fill="#fff" stroke="#555"/><text x="${c.x}" y="${c.y+4}" font-size="11" text-anchor="middle">${c.label}</text>`));
  o.push('</svg>');
  return o.join('\n');
}
module.exports=svgOf;
