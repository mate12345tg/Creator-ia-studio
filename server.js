const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const app = express();
const upload = multer({ dest: path.join(os.tmpdir(), 'creator-ai-uploads'), limits: { fileSize: 1024 * 1024 * 1024 } });
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args);
    let out = '', err = '';
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => err += d.toString());
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolve({ out, err }) : reject(new Error(err.slice(-1800) || `${cmd} failed`)));
  });
}
function clean(s) { return String(s || '').replace(/[^\w.-]/g, '_').slice(0, 70) || 'clip'; }

app.get('/api/health', (_, res) => res.json({ ok: true, ffmpeg: true, claudeConfigured: Boolean(process.env.CLAUDE_API_KEY) }));

// Claude is optional. The fallback deliberately labels ideas as brainstorms, not live trend data.
app.post('/api/niches', async (req, res) => {
  const { topic = 'gaming', platform = 'YouTube Shorts', language = 'Spanish' } = req.body || {};
  if (process.env.CLAUDE_API_KEY) {
    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': process.env.CLAUDE_API_KEY, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-3-5-haiku-latest', max_tokens: 1200,
          messages: [{ role: 'user', content: `In ${language}, brainstorm 8 content niches related to "${topic}" for ${platform}. Do not claim live trend data. Return JSON array of objects with niche, audience, competition (Low/Medium/High), 3 videoIdeas, and whyItCouldWork. Be realistic and concise.` }]
        })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error?.message || 'Claude API error');
      const raw = (data.content || []).map(x => x.text || '').join('').replace(/```json|```/g, '').trim();
      const parsed = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1));
      return res.json({ source: 'Claude', liveData: false, niches: parsed });
    } catch (e) { return res.status(502).json({ error: `Claude no pudo generar resultados: ${e.message}` }); }
  }
  const ideas = [
    ['Errores y trucos', 'Jugadores que quieren mejorar', 'Medium', ['3 errores que te hacen perder','Un ajuste que casi nadie usa','Qué hacer en el final de partida'], 'Ideas fáciles de convertir en series cortas.'],
    ['Historias y curiosidades', 'Fans casuales y competitivos', 'Medium', ['El origen de una mecánica','Un dato que parece falso','Cómo cambió el juego'], 'Los ganchos de curiosidad favorecen la retención.'],
    ['Retos y experimentos', 'Audiencia que busca entretenimiento', 'High', ['Ganar usando una sola estrategia','Probé el consejo más raro','Qué pasa si no haces X'], 'Formato repetible y fácil de serializar.'],
    ['Tutoriales rápidos', 'Principiantes', 'Medium', ['Un tip en 20 segundos','Cómo corregir un fallo común','Antes y después de un ajuste'], 'Resuelve un problema concreto por video.'],
    ['Comparativas', 'Usuarios que eligen equipo o ajustes', 'Medium', ['A vs B en una partida','¿Vale la pena este ajuste?','La opción que conviene según tu estilo'], 'Invita a comentarios y debates.'],
    ['Noticias explicadas', 'Fans que quieren contexto', 'High', ['Qué cambió y por qué importa','La actualización en 30 segundos','Lo que debes probar hoy'], 'Útil si verificas cada noticia antes de publicar.']
  ].map(([n,a,c,i,w]) => ({ niche: `${topic}: ${n}`, audience:a, competition:c, videoIdeas:i, whyItCouldWork:w }));
  res.json({ source: 'Plantilla de ideas', liveData: false, note: 'No son tendencias en tiempo real. Conecta Claude para generar propuestas personalizadas.', niches: ideas });
});

// Build an SRT from timed word data: [{word,start,end}] seconds.
app.post('/api/subtitles', (req, res) => {
  const words = req.body?.words;
  if (!Array.isArray(words) || !words.length) return res.status(400).json({ error: 'Envía palabras con start y end en segundos.' });
  const stamp = s => { s = Math.max(0, Number(s) || 0); const ms = Math.round(s * 1000); return `${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms%3600000/60000)).padStart(2,'0')}:${String(Math.floor(ms%60000/1000)).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`; };
  const cues = []; let line = [], start = null, end = 0;
  for (const w of words) {
    if (typeof w.word !== 'string' || !Number.isFinite(Number(w.start)) || !Number.isFinite(Number(w.end))) continue;
    if (start !== null && (line.length >= 5 || Number(w.start) - start > 2.4)) {
      cues.push({ start, end, text: line.join(' ') }); line = []; start = null;
    }
    if (start === null) start = Number(w.start);
    line.push(w.word); end = Number(w.end);
  }
  if (line.length) cues.push({ start, end, text: line.join(' ') });
  const srt = cues.map((c,i) => `${i+1}\n${stamp(c.start)} --> ${stamp(c.end)}\n${c.text}`).join('\n\n');
  res.json({ srt, cues: cues.length });
});

// Detect high-energy sections using FFmpeg's audio RMS/volume windows, then export selected clips.
// No speech transcription and no subtitles are created here.
app.post('/api/clips', upload.single('video'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Sube un video primero.' });
  const duration = Math.max(5, Math.min(90, Number(req.body.clipDuration) || 30));
  const count = Math.max(1, Math.min(8, Number(req.body.count) || 3));
  const useClaude = req.body.useClaude === 'true';
  const script = String(req.body.script || '').slice(0, 12000);
  const base = path.join(os.tmpdir(), 'creator-ai-' + Date.now());
  fs.mkdirSync(base, { recursive: true });
  try {
    const probe = await run('ffprobe', ['-v','error','-show_entries','format=duration','-of','default=noprint_wrappers=1:nokey=1',file.path]);
    const total = Number(probe.out.trim());
    if (!Number.isFinite(total) || total < 2) throw new Error('No se pudo leer la duración del video.');
    // 1-second RMS loudness samples; score favors energetic moments, avoiding duplicate windows.
    const { err } = await run('ffmpeg', ['-hide_banner','-i',file.path,'-vn','-af','aresample=8000,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level','-f','null','-']);
    const samples = [...err.matchAll(/pts_time:([0-9.]+)[\s\S]{0,180}?lavfi\.astats\.Overall\.RMS_level=(-?[0-9.]+)/g)]
      .map(m => ({ t: Number(m[1]), db: Number(m[2]) })).filter(x => Number.isFinite(x.t) && Number.isFinite(x.db) && x.db > -75);
    const step = Math.max(1, duration / 3);
    let candidates = [];
    for (let t = 0; t + duration <= total; t += Math.max(1, duration / 4)) {
      const inWindow = samples.filter(s => s.t >= t && s.t < t + duration);
      const score = inWindow.length ? inWindow.reduce((a,b) => a + b.db, 0) / inWindow.length : -100;
      candidates.push({ start: t, score });
    }
    candidates.sort((a,b) => b.score - a.score);
    const chosen = [];
    for (const c of candidates) {
      if (chosen.every(x => Math.abs(x.start - c.start) >= step)) chosen.push(c);
      if (chosen.length >= count) break;
    }
    if (!chosen.length) chosen.push({ start: 0, score: null });
    let explanation = 'Selección automática por energía de audio.';
    if (useClaude && process.env.CLAUDE_API_KEY && script.trim()) {
      try {
        const resp = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST', headers:{'content-type':'application/json','x-api-key':process.env.CLAUDE_API_KEY,'anthropic-version':'2023-06-01'},
          body: JSON.stringify({ model:'claude-3-5-haiku-latest', max_tokens:500, messages:[{role:'user',content:`Guion/contexto del video:\n${script}\nDuración total ${total.toFixed(1)} s. Ventanas detectadas (inicio y score de volumen): ${chosen.map(x=>`${x.start.toFixed(1)}s score ${x.score}`).join(', ')}. Sugiere brevemente cómo priorizarlas según el guion; no inventes marcas de tiempo nuevas.`}]})
        });
        const d = await resp.json(); if (resp.ok) explanation = (d.content || []).map(x=>x.text||'').join(' ').slice(0,1200) || explanation;
      } catch (_) {}
    } else if (useClaude) explanation = 'Claude no está configurado o falta el guion; se usaron los picos de volumen.';
    const clips = [];
    for (let i=0;i<chosen.length;i++) {
      const c = chosen[i], out = path.join(base, `clip-${i+1}.mp4`);
      const length = Math.min(duration, total - c.start);
      await run('ffmpeg', ['-y','-ss',String(c.start),'-i',file.path,'-t',String(length),'-vf','scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2','-c:v','libx264','-preset','veryfast','-crf','23','-c:a','aac','-b:a','128k','-movflags','+faststart',out]);
      clips.push({ name:`clip-${i+1}.mp4`, start:c.start, score:c.score, url:`/api/download/${path.basename(base)}/${path.basename(out)}` });
    }
    // Keep outputs in temp folder for downloads; clean original upload.
    res.json({ message:`Listo: ${clips.length} clip(s) generados sin subtítulos.`, totalDuration:total, method:'picos de volumen', explanation, clips });
  } catch(e) {
    res.status(500).json({ error:`No se pudieron crear los clips: ${e.message}` });
  } finally { fs.unlink(file.path, ()=>{}); }
});

app.get('/api/download/:folder/:file', (req,res) => {
  const folder = req.params.folder, file = req.params.file;
  if (!/^creator-ai-\d+$/.test(folder) || !/^clip-\d+\.mp4$/.test(file)) return res.sendStatus(400);
  const p = path.join(os.tmpdir(), folder, file);
  if (!fs.existsSync(p)) return res.sendStatus(404);
  res.download(p, file);
});
const port = process.env.PORT || 3000;
app.listen(port, '0.0.0.0', () => console.log(`Creator AI Studio listening on ${port}`));
