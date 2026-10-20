const overlaps=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
// Screen-space placement: cull rather than move labels onto another resident's target.
export function placeToolBubbles(rows,{width,height,blocked=[]}){
 const placed=[],occupied=[...blocked];
 const sorted=[...rows].sort((a,b)=>(Number(!!b.waiting)*2+Number(!!b.focused))-(Number(!!a.waiting)*2+Number(!!a.focused)));
 for(const row of sorted){
  const compact=row.height<56,w=compact?48:232,h=compact?44:48,rect={x:row.x-w/2,y:row.y-h-8,width:w,height:h};
  if(rect.x<4||rect.y<4||rect.x+w>width-4||rect.y+h>height-4||occupied.some(box=>overlaps(rect,box)))continue;
  placed.push({...row,...rect,compact});occupied.push({...rect,x:rect.x-6,width:rect.width+12});
 }
 return placed;
}
