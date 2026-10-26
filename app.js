const $ = s => document.querySelector(s);
const toast = msg => { const el=$('#toast'); el.textContent=msg; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),3600); };
const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const busy = (btn,on,label) => { if(on){btn.dataset.old=btn.textContent;btn.textContent=label||'Procesando…';btn.disabled=true;} else {btn.textContent=btn.dataset.old||btn.textContent;btn.disabled=false;} };
document.querySelectorAll('.nav').forEach(b=>b.addEventListener('click',()=>{document.querySelectorAll('.nav,.tab').forEach(x=>x.classList.remove('active'));b.classList.add('active');$('#'+b.dataset.tab).classList.add('active');$('#pageTitle').textContent=b.textContent.trim().replace(/^[⌕▣◖]\s*/,'');}));
fetch('/api/health').then(r=>r.json()).then(d=>{$('#status').textContent=d.claudeConfigured?'Servidor listo · Claude conectado':'Servidor listo';}).catch(()=>{$('#status').textContent='Servidor no disponible';});

$('#nicheForm').addEventListener('submit',async e=>{
 e.preventDefault();const btn=e.submitter;busy(btn,true,'Buscando…');$('#nicheResults').textContent='Generando ideas…';
 try{const data=Object.fromEntries(new FormData(e.currentTarget));const r=await fetch('/api/niches',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const d=await r.json();if(!r.ok)throw Error(d.error||'Error al buscar');$('#nicheResults').innerHTML=`<p class="muted">Fuente: ${escapeHtml(d.source)} · Sin datos de tendencias en tiempo real</p><div class="resultgrid">${d.niches.map(n=>`<article class="resultcard"><h3>${escapeHtml(n.niche)}</h3><span class="tag">Competencia: ${escapeHtml(n.competition)}</span><p><b>Audiencia:</b> ${escapeHtml(n.audience)}</p><p>${escapeHtml(n.whyItCouldWork)}</p>${(n.videoIdeas||[]).map(i=>`<div class="idea">↗ ${escapeHtml(i)}</div>`).join('')}</article>`).join('')}</div>`;}
 catch(err){$('#nicheResults').textContent=err.message;toast('No se pudo completar la búsqueda');}finally{busy(btn,false);}
});

$('#makeSrt').addEventListener('click',async e=>{
 const btn=e.currentTarget;busy(btn,true,'Creando SRT…');
 try{let words=JSON.parse($('#wordTimes').value);if(!Array.isArray(words))throw Error('El JSON debe ser una lista de palabras con start y end.');const r=await fetch('/api/subtitles',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({words})});const d=await r.json();if(!r.ok)throw Error(d.error);$('#srtResult').innerHTML=`<b>${d.cues} bloques de subtítulos listos</b><pre class="codebox" id="srtText">${escapeHtml(d.srt)}</pre><div class="actions"><button class="primary" id="downloadSrt">Descargar archivo .srt</button><button class="secondary" id="copySrt">Copiar SRT</button></div>`;$('#downloadSrt').onclick=()=>downloadText(d.srt,'subtitulos.srt','text/plain');$('#copySrt').onclick=()=>navigator.clipboard.writeText(d.srt).then(()=>toast('SRT copiado')).catch(()=>toast('No se pudo copiar'));toast('Subtítulos generados');}
 catch(err){$('#srtResult').textContent=err.message;toast('Revisa el formato JSON');}finally{busy(btn,false);}
});
function downloadText(text,name,type){const a=document.createElement('a');const url=URL.createObjectURL(new Blob([text],{type}));a.href=url;a.download=name;a.click();URL.revokeObjectURL(url);}
$('#copyScript').addEventListener('click',()=>{const text=$('#shortScript').value||$('#shortIdea').value;if(!text)return toast('Primero escribe una idea o guion');navigator.clipboard.writeText(text).then(()=>toast('Guion copiado')).catch(()=>toast('No se pudo copiar'));});

$('#clipForm').addEventListener('submit',async e=>{
 e.preventDefault();const btn=e.submitter;busy(btn,true,'Analizando audio y cortando…');$('#clipResults').textContent='Procesando en el servidor. No cierres esta pestaña; los videos grandes pueden tardar.';
 try{const fd=new FormData(e.currentTarget);const r=await fetch('/api/clips',{method:'POST',body:fd});const d=await r.json();if(!r.ok)throw Error(d.error||'Error procesando video');$('#clipResults').innerHTML=`<h3>${escapeHtml(d.message)}</h3><p class="muted">Método: ${escapeHtml(d.method)} · Duración original: ${d.totalDuration.toFixed(1)} s</p><p>${escapeHtml(d.explanation)}</p><div class="resultgrid">${d.clips.map(c=>`<article class="resultcard"><h3>${escapeHtml(c.name)}</h3><p>Inicio: ${c.start.toFixed(1)} s</p><a class="download" href="${escapeHtml(c.url)}">↓ Descargar clip</a></article>`).join('')}</div>`;toast('¡Terminó! Tus clips están listos.');}
 catch(err){$('#clipResults').textContent=err.message;toast('El procesamiento terminó con un error');}finally{busy(btn,false);}
});