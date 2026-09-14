<script lang="ts">
  import type { OfficePerson } from './office-store.svelte.js';
  import { officeMapRooms, projectFloor, memberLabel, initials } from './office-map.js';
  let { people, displayName, selected, onselect, selfUid }: {people: readonly OfficePerson[]; selfUid?: string; displayName: (uid:string)=>string; selected:string|null; onselect:(uid:string)=>void}=$props();
  let animateZoom=$state(false);
  let rotation=$state(0), zoom=$state(1), panX=$state(0),panY=$state(0);
  let svg:SVGSVGElement;let drag:{id:number;x:number;y:number;px:number;py:number;r:number;rotate:boolean;moved:boolean}|null=null;let moving=$state(false), suppressClick=false;
  const rooms=$derived(officeMapRooms(people,selfUid));const columns=$derived(Math.max(3,Math.ceil(Math.sqrt(rooms.length*1.4))));
  const rows=$derived(Math.max(1,Math.ceil(rooms.length/columns)));
  const width=$derived((columns-1)*255+185), height=$derived((rows-1)*225+165);
  const point=(x:number,y:number,z=0)=>{
    const p=projectFloor(x-width/2+345,y-height/2+195,rotation,z);
    const center=projectFloor(345,195,rotation);
    return [p[0]-center[0]+500,p[1]-center[1]+300];
  };
  const placed=$derived(rooms.map((room,i)=>({...room,x:(i%columns)*255,y:Math.floor(i/columns)*225,w:185,h:165})).sort((a,b)=>point(a.x,a.y)[1]-point(b.x,b.y)[1]));
  const polygon=(v:number[][])=>v.map(p=>p.join(',')).join(' ');
  function reset(){animateZoom=true;rotation=0;zoom=Math.min(1,850/((width+height)*.78),470/((width+height)*.39+40));panX=0;panY=0;}
  let fitted=false;
  $effect(()=>{if(rooms.length>1&&!fitted){fitted=true;reset();}});
  function localPoint(clientX:number,clientY:number){
    const matrix=svg.getScreenCTM();
    return matrix ? new DOMPoint(clientX,clientY).matrixTransform(matrix.inverse()) : {x:500,y:330};
  }
  function zoomAt(value:number,x=500,y=330,smooth=true){
    const next=Math.min(3,Math.max(.03,value));
    animateZoom=smooth;
    panX=x-500-(x-500-panX)*next/zoom;
    panY=y-330-(y-330-panY)*next/zoom;
    zoom=next;
  }
  let gestureActive=false, gestureZoom=1;
  function wheel(e:WheelEvent){
    e.preventDefault();
    if(gestureActive)return;
    const unit=e.deltaMode===1?16:e.deltaMode===2?svg.clientHeight:1;
    if(e.ctrlKey || e.metaKey){
      const p=localPoint(e.clientX,e.clientY);
      zoomAt(zoom*Math.exp(-Math.max(-250,Math.min(250,e.deltaY*unit))*.002),p.x,p.y);
    }else{
      animateZoom=false;
      const scale=svg.getScreenCTM()?.a||1;
      panX-=(e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX)*unit/scale;
      panY-=(e.shiftKey && !e.deltaX ? 0 : e.deltaY)*unit/scale;
    }
  }
  // WebKit uses native GestureEvents for Mac trackpad pinch. Chromium uses
  // Ctrl+wheel. Keep both paths scoped to the map, with no double application.
  $effect(()=>{
    const element=svg;
    if(!element)return;
    const begin=(event:Event)=>{event.preventDefault();gestureActive=true;gestureZoom=zoom;animateZoom=false;};
    const change=(event:Event)=>{
      event.preventDefault();
      const e=event as Event & {scale:number;clientX:number;clientY:number};
      if(!gestureActive || !Number.isFinite(e.scale))return;
      const p=Number.isFinite(e.clientX)&&Number.isFinite(e.clientY)?localPoint(e.clientX,e.clientY):{x:500,y:330};
      zoomAt(gestureZoom*e.scale,p.x,p.y,false);
    };
    const end=(event:Event)=>{event.preventDefault();gestureActive=false;};
    element.addEventListener('wheel',wheel,{passive:false});
    element.addEventListener('gesturestart',begin,{passive:false});
    element.addEventListener('gesturechange',change,{passive:false});
    element.addEventListener('gestureend',end,{passive:false});
    return ()=>{element.removeEventListener('wheel',wheel);element.removeEventListener('gesturestart',begin);element.removeEventListener('gesturechange',change);element.removeEventListener('gestureend',end);gestureActive=false;};
  });
  function start(e:PointerEvent){if(e.button!==0)return;animateZoom=false;suppressClick=false;drag={id:e.pointerId,x:e.clientX,y:e.clientY,px:panX,py:panY,r:rotation,rotate:e.metaKey||e.ctrlKey,moved:false};}
  function move(e:PointerEvent){if(!drag||drag.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(!drag.moved&&Math.hypot(dx,dy)<5)return;drag.moved=true;moving=true;suppressClick=true;svg.setPointerCapture(e.pointerId);if(drag.rotate)rotation=drag.r+dx*.35;else{const scale=svg.getScreenCTM()?.a||1;panX=drag.px+dx/scale;panY=drag.py+dy/scale;}}
  function end(e:PointerEvent){if(drag?.id!==e.pointerId)return;drag=null;moving=false;if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);}
  function key(e:KeyboardEvent){if(e.target!==svg)return;const steps:Record<string,()=>void>={ArrowLeft:()=>panX-=30,ArrowRight:()=>panX+=30,ArrowUp:()=>panY-=30,ArrowDown:()=>panY+=30,'[':()=>rotation-=15,']':()=>rotation+=15,Home:reset};if(steps[e.key]){e.preventDefault();steps[e.key]();}}
</script>
<div class="floor-plan" data-testid="office-floor-plan">
  <div class="floor-summary"><span>{people.filter(p=>p.connectivity==='online').length} reachable</span><span>{rooms.filter(r=>r.owner.room).length} {rooms.filter(r=>r.owner.room).length===1?"room":"rooms"}</span><span>{people.length} people · One office</span></div>
  <svg bind:this={svg} viewBox="0 0 1000 680" role="application" tabindex="0" aria-label="Office floor. Drag or scroll to pan. Control-scroll or pinch to zoom. Command/Ctrl-drag to rotate. Arrow keys pan, brackets rotate, Home resets." class:moving onpointerdown={start} onpointermove={move} onpointerup={end} onpointercancel={end} onlostpointercapture={()=>{drag=null;moving=false}} onkeydown={key}>
    <defs><pattern id="office-dots" width="20" height="20" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r=".7" fill="#c3d7c015"/></pattern></defs><rect width="1000" height="680" fill="url(#office-dots)"/>
    <g class="floor-transform" class:smooth={animateZoom} style:transform={`translate(${500*(1-zoom)+panX}px,${330*(1-zoom)+panY}px) scale(${zoom})`} data-testid="floor-transform">
      <polygon points={polygon([point(-20,-20,-9),point(width+20,-20,-9),point(width+20,height+20,-9),point(-20,height+20,-9)])} class="foundation"/>
      {#each placed as r (r.id)}
        {@const door=point(r.x+r.w*.7,r.y+r.h)}{@const cx=r.x+r.w/2}{@const cy=r.y+r.h/2}{@const a=point(r.x,r.y)}{@const b=point(r.x+r.w,r.y)}{@const c=point(r.x+r.w,r.y+r.h)}{@const d=point(r.x,r.y+r.h)}
        {@const name=point(cx,cy+48)}{@const state=point(cx,cy-54,16)}
        <g role="button" tabindex="0" aria-label={`${memberLabel(r.owner.personUid,displayName)}: ${r.owner.connectivity}, ${r.owner.willingness}, ${r.members.length} ${r.owner.room?'in room':'in office'}`} aria-pressed={selected===r.owner.personUid} class:chosen={selected===r.owner.personUid} onclick={()=>{if(!suppressClick)onselect(r.owner.personUid);suppressClick=false}} onkeydown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();onselect(r.owner.personUid)}}}>
          <polygon points={polygon([point(r.x,r.y,18),point(r.x+r.w,r.y,18),b,a])} class="wall"/>
          <polygon points={polygon([point(r.x,r.y,18),point(r.x,r.y+r.h,18),d,a])} class="wall"/>
          <polygon points={polygon([a,b,c,d])} class="room-floor"/>
          {#each [22,44,66,88,110,132,154] as line}<path d={`M${point(r.x+5,r.y+line).join(',')}L${point(r.x+r.w-5,r.y+line).join(',')}`} stroke="#afc2b709"/>{/each}
          <path d={`M${door[0]-10},${door[1]-5}l20,10`} stroke={r.owner.connectivity==='online' ? r.owner.willingness==='open' ? '#b4dcca' : '#d7b988' : '#7a8480'} stroke-width="3"/>
          <polygon points={polygon([b,c,point(r.x+r.w,r.y+r.h,-8),point(r.x+r.w,r.y,-8)])} class="edge"/>
          <polygon points={polygon([d,c,point(r.x+r.w,r.y+r.h,-8),point(r.x,r.y+r.h,-8)])} class="edge"/>
          <polygon points={polygon([point(cx-30,cy-20,3),point(cx+30,cy-20,3),point(cx+30,cy+20,3),point(cx-30,cy+20,3)])} class="table"/>
          {#each r.members.slice(0,3) as uid,i (uid)}
            {@const av=point(cx+(i-(Math.min(r.members.length,3)-1)/2)*42,cy-10,25)}
            <ellipse cx={av[0]} cy={av[1]+25} rx="16" ry="5" class="shadow"/>
            <circle cx={av[0]} cy={av[1]} r="22" fill="none" stroke="#c5dcc438"/>
            <circle cx={av[0]} cy={av[1]} r="17" class="avatar" style:fill={["#465047","#55474c","#3e4b52"][Array.from(uid).reduce((n,c)=>n+c.charCodeAt(0),0)%3]}/>
            <text x={av[0]} y={av[1]+4} text-anchor="middle" class="initials">{initials(memberLabel(uid,displayName))}</text>
          {/each}
          
          <text x={state[0]} y={state[1]} text-anchor="middle" class="state" class:open={r.owner.connectivity==='online' && r.owner.willingness==='open'} class:knock={r.owner.connectivity==='online' && r.owner.willingness==='knock'}>{r.owner.presenceUnknown?'Not sharing availability':r.owner.connectivity!=='online'?'Away':r.owner.willingness==='open'?'○ Open':r.owner.willingness==='dnd'?'− Focusing':'◦ Knock first'}</text>
          <text x={name[0]} y={name[1]} text-anchor="middle" class="room-name">{r.owner.room ? 'Conversation' : displayName(r.owner.personUid)==='You' ? 'Your office' : memberLabel(r.owner.personUid,displayName).slice(0,21)+'’s office'}</text>
          <text x={name[0]} y={name[1]+17} text-anchor="middle" class="room-sub">{r.members.map(uid=>memberLabel(uid,displayName)).join(' · ')}</text>
        </g>
      {/each}
    </g>
  </svg>
  <div class="floor-caption"><strong>Different rooms. Same team.</strong><span>Scroll to pan · Ctrl-scroll or pinch to zoom · ⌘/Ctrl-drag to rotate</span></div>
  <div class="map-tools" aria-label="Floor controls">

    <button aria-label="Zoom out" onclick={()=>zoomAt(zoom/1.2)}>−</button><button aria-label="Zoom in" onclick={()=>zoomAt(zoom*1.2)}>+</button><button onclick={reset}>Fit all</button>
  </div>
</div>
<style>
.floor-plan{position:relative;min-height:450px;height:100%;overflow:hidden;background:radial-gradient(ellipse at 20% 40%,var(--meet-glow,#57736522),transparent 55%),radial-gradient(ellipse at 85% 40%,#67545e16,transparent 55%),var(--v4-ground,#141817);border-radius:12px;border:1px solid var(--v4-hairline,#ffffff16)}svg{width:100%;height:100%;min-height:450px;touch-action:none;cursor:grab;user-select:none}.moving,.moving g[role=button]{cursor:grabbing}.foundation{fill:#0a111040;stroke:var(--v4-hairline,#75908445)}.room-floor{fill:#202e27;stroke:#748d7e;stroke-width:1}.wall{fill:#afc2b70c;stroke:#adbfaf55}.edge{fill:var(--v4-ground,#1b2621);stroke:#91aa9a45}.table{fill:#b4c6bb0a;stroke:#b6cdb82e}.shadow{fill:#0003}.avatar{fill:#34483d;stroke:var(--v4-text-3,#adc2b5)}.initials{fill:var(--v4-text-1,#edf4ef);font-size:11px}.room-name{fill:var(--v4-text-1,#edf4ef);font-size:13px}.room-sub,.state{fill:var(--v4-text-2,#b3c4b9);font-size:10px}.state{font-size:11px}.state.open{fill:#b9dfca}.state.knock{fill:#e0c59d}g[role=button]{cursor:pointer;outline:none}g[role=button]:hover .room-floor,g[role=button]:focus-visible .room-floor,.chosen .room-floor{stroke:var(--v4-text-1,#d1e9dc);stroke-width:2;fill:var(--meet-active-floor,#355043)}.floor-summary{position:absolute;top:22px;left:24px;display:flex;gap:18px;font-size:12px;color:var(--v4-text-2,#b3c4b9);pointer-events:none}.floor-caption{position:absolute;bottom:70px;left:24px;display:flex;flex-direction:column;gap:8px;pointer-events:none}.floor-caption strong{font-size:19px;font-weight:400}.floor-caption span{font-size:11px;color:var(--v4-text-3,#8f9c93)}.map-tools{position:absolute;bottom:20px;right:20px;left:20px;display:flex;justify-content:flex-end;gap:5px;flex-wrap:wrap}.map-tools button{font:inherit;font-size:11px;background:var(--v4-popover-strong,#242d28);color:var(--v4-text-1,#eef3ef);border:1px solid var(--v4-hairline,#ffffff20);border-radius:7px;padding:8px 10px;cursor:pointer}.map-tools button[aria-pressed=true]{box-shadow:inset 0 -2px currentColor}.map-tools button:disabled{opacity:.4}.map-tools button:focus-visible,svg:focus-visible{outline:2px solid currentColor;outline-offset:3px}@media(max-width:650px){.floor-caption{bottom:106px}.map-tools{justify-content:center}.floor-summary{gap:8px;font-size:11px}}
.floor-plan{border:0;border-radius:0;min-height:0}svg{min-height:0;position:absolute;inset:0}.floor-caption{bottom:28px;max-width:60%}.floor-caption strong{font-size:22px}.map-tools{left:auto}.foundation{stroke:#75908430}.floor-summary{font-variant-numeric:tabular-nums}.floor-transform{transform-origin:0 0}.floor-transform.smooth{transition:transform 160ms cubic-bezier(.2,.75,.25,1)}@media(prefers-reduced-motion:reduce){.floor-transform.smooth{transition:none}}</style>
