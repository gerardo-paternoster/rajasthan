'use strict';
/* Tutto Rajasthan – app di viaggio offline-first.
   - Contenuti comuni: data/tappe.json (tenuto sul dispositivo dal service worker).
   - Dati personali: memoria locale del dispositivo; con un token, sincronizzati
     come file JSON in un repository GitHub privato (un file per sezione).
   - Meteo: Open-Meteo quando c'è rete, altrimenti le medie del periodo. */

// A ogni pubblicazione cambiare insieme questo valore e quello in versione.json.
const VERSIONE = '2026-11-24.4';
// Identificativo dell'app presso Google (non è un segreto). Se è vuoto, l'opzione Google Drive resta nascosta.
const GOOGLE_CLIENT_ID = '777574645730-brthmdcpkc3i0196vqqfbkqk3dicc8dt.apps.googleusercontent.com';
const CARTELLA_DRIVE = 'Tutto Rajasthan - dati';
// Ogni sezione è un file a sé: sincronizzazione (GitHub o Drive) e copia di sicurezza la includono da sole.
const SEZIONI = ['segni', 'diario', 'scadenze', 'bagagli', 'documenti', 'foto', 'simulatore'];
const LISTE = {
  scadenze: { nome: 'Scadenze', spunta: 'fatto', conData: true },
  bagagli: { nome: 'Bagagli', spunta: 'nello zaino', stati: ['posseduto', 'da comprare', 'da decidere'] },
  documenti: { nome: 'Documenti e salute', spunta: 'fatto', conData: true }
};
const FOTO = { situazioni: 'Situazioni', ricette: 'Ricette', fotocamera: 'Fotocamera', trucchi: 'Trucchi e regole' };

/* ---------- Memoria locale ---------- */
let memoriaOk = true;
const LS = {
  get(k, d) {
    try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); }
    catch (e) { return d; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; }
    catch (e) { memoriaOk = false; mostraAvvisoMemoria(); return false; }
  },
  del(k) { try { localStorage.removeItem(k); } catch (e) { /* niente */ } }
};
try { localStorage.setItem('rj.prova', '1'); localStorage.removeItem('rj.prova'); }
catch (e) { memoriaOk = false; }

const DB = {};        // DB[sezione] = { items: { id: voce } }
const modifiche = {}; // contatore delle modifiche per sezione, per capire se la sync è ancora valida
let inAttesa = LS.get('rj.attesa', {});
for (const s of SEZIONI) { DB[s] = LS.get('rj.d.' + s, { items: {} }); if (!DB[s].items) DB[s] = { items: {} }; modifiche[s] = 0; }

function salvaSezione(s) { LS.set('rj.d.' + s, DB[s]); }
function segnaAttesa(s, v) {
  if (v) inAttesa[s] = true; else delete inAttesa[s];
  LS.set('rj.attesa', inAttesa);
  aggiornaStato();
}
function voce(s, id) { const v = DB[s].items[id]; return v && !v.del ? v : null; }
function voci(s) { return Object.values(DB[s].items).filter((v) => !v.del); }
function scrivi(s, id, campi) {
  const prima = DB[s].items[id] || { id };
  DB[s].items[id] = Object.assign({}, prima, campi, { id, mod: Date.now(), del: false });
  modifiche[s]++;
  salvaSezione(s);
  segnaAttesa(s, true);
  programmaSync();
}
function elimina(s, id) {
  if (!DB[s].items[id]) return;
  DB[s].items[id] = { id, del: true, mod: Date.now() };
  modifiche[s]++;
  salvaSezione(s);
  segnaAttesa(s, true);
  programmaSync();
}
function nuovoId() { return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function perOrdine(a, b) { return (a.ord || 9999) - (b.ord || 9999) || String(a.titolo).localeCompare(String(b.titolo)); }

/* ---------- Utilità ---------- */
const $ = (sel, el) => (el || document).querySelector(sel);
function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function slug(t) {
  return String(t).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function dataDa(iso) { const p = iso.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
function isoDi(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
function oggiIso() { return isoDi(new Date()); }
function giorniTra(a, b) { return Math.round((dataDa(b) - dataDa(a)) / 86400000); }
const fmtGiorno = new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtLungo = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtBreve = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short' });
const fmtOra = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
function testoAParagrafi(t) { return esc(t).replace(/\n/g, '<br>'); }
function quantoManca(iso) { const g = giorniTra(oggiIso(), iso); return g === 0 ? 'oggi' : g === 1 ? 'domani' : g > 1 ? 'tra ' + g + ' giorni' : 'scaduta'; }

const ICO = {
  giu: '<svg class="giu" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  freccia: '<svg class="freccia" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>',
  penna: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l1-4.5L16.5 4a2.1 2.1 0 013 3L8 18.5z"/></svg>',
  piu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  campana: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 16.5V11a6 6 0 0112 0v5.5l1.5 2h-15z"/><path d="M10 21h4"/></svg>',
  bussola: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/></svg>'
};
function arco(colore, largo, classe) {
  return '<svg class="' + (classe || 'arco') + '" width="' + largo + '" height="' + Math.round(largo * 1.15) + '" viewBox="0 0 40 46" aria-hidden="true"><path fill="' + esc(colore) + '" d="M0 46V20C0 10 9 7 20 0c11 7 20 10 20 20v26z"/></svg>';
}
function suColore(hex) {
  const n = parseInt(String(hex).slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#161b3a' : '#ffffff';
}
function stileCitta(t) { return t ? ' style="--citta:' + esc(t.colore) + ';--su-citta:' + suColore(t.colore) + '"' : ''; }

/* ---------- Contenuti comuni ---------- */
let CONT = null;
async function caricaContenuti() {
  try {
    const r = await fetch('data/tappe.json');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    CONT = await r.json();
    LS.set('rj.contenuti', CONT);
  } catch (e) {
    CONT = LS.get('rj.contenuti', null);
  }
}
function tappa(id) { return CONT.tappe.find((t) => t.id === id); }
function giorniDi(id) { return CONT.giorni.filter((g) => g.tappe.indexOf(id) >= 0); }

/* ---------- Sole: alba e tramonto calcolati sul dispositivo (ora indiana) ---------- */
function sole(iso, lat, lon, alba) {
  const p = iso.split('-').map(Number), N = Math.round((Date.UTC(p[0], p[1] - 1, p[2]) - Date.UTC(p[0], 0, 0)) / 864e5);
  const R = Math.PI / 180, lh = lon / 15, t = N + ((alba ? 6 : 18) - lh) / 24, M = 0.9856 * t - 3.289;
  let L = (M + 1.916 * Math.sin(M * R) + 0.020 * Math.sin(2 * M * R) + 282.634) % 360; if (L < 0) L += 360;
  let RA = Math.atan(0.91764 * Math.tan(L * R)) / R; RA = ((RA % 360) + 360) % 360;
  RA += Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90; RA /= 15;
  const sd = 0.39782 * Math.sin(L * R), cd = Math.cos(Math.asin(sd));
  const cH = (Math.cos(90.833 * R) - sd * Math.sin(lat * R)) / (cd * Math.cos(lat * R));
  if (cH > 1 || cH < -1) return null;
  let H = Math.acos(cH) / R; if (alba) H = 360 - H; H /= 15;
  const loc = (((H + RA - 0.06571 * t - 6.622 - lh + 5.5) % 24) + 24) % 24;
  let h = Math.floor(loc), m = Math.round((loc - h) * 60); if (m === 60) { h++; m = 0; }
  return h + ':' + String(m).padStart(2, '0');
}

/* ---------- Meteo (Open-Meteo) ---------- */
let METEO = LS.get('rj.meteo', null);
let meteoInCorso = false;
function cielo(c) {
  if (c == null) return '';
  if (c === 0) return 'sereno';
  if (c <= 2) return 'poco nuvoloso';
  if (c === 3) return 'coperto';
  if (c === 45 || c === 48) return 'nebbia';
  if (c <= 57) return 'pioviggine';
  if (c <= 67) return 'pioggia';
  if (c <= 77) return 'neve';
  if (c <= 82) return 'rovesci';
  return 'temporale';
}
function aria(aqi) {
  if (aqi == null) return '';
  return aqi <= 50 ? 'buona' : aqi <= 100 ? 'discreta' : aqi <= 150 ? 'scadente' : aqi <= 200 ? 'insalubre' : aqi <= 300 ? 'molto insalubre' : 'pericolosa';
}
async function aggiornaMeteo(forza) {
  if (!CONT || meteoInCorso || !navigator.onLine) return;
  if (!forza && METEO && Date.now() - METEO.t < 3600e3) return;
  meteoInCorso = true;
  try {
    const lat = CONT.tappe.map((t) => t.lat).join(','), lon = CONT.tappe.map((t) => t.lon).join(',');
    const q = 'latitude=' + lat + '&longitude=' + lon + '&timezone=Asia%2FKolkata';
    const r = await fetch('https://api.open-meteo.com/v1/forecast?' + q + '&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min&forecast_days=16');
    if (!r.ok) throw new Error('meteo ' + r.status);
    let j = await r.json(); if (!Array.isArray(j)) j = [j];
    const per = {};
    CONT.tappe.forEach((t, i) => {
      const o = j[i]; if (!o) return;
      const giorni = {}; const d = o.daily || {};
      (d.time || []).forEach((g, k) => { giorni[g] = { min: d.temperature_2m_min && d.temperature_2m_min[k], max: d.temperature_2m_max && d.temperature_2m_max[k], c: d.weather_code && d.weather_code[k] }; });
      per[t.id] = { ora: o.current ? { t: o.current.temperature_2m, c: o.current.weather_code } : null, giorni };
    });
    try {
      const ra = await fetch('https://air-quality-api.open-meteo.com/v1/air-quality?' + q + '&current=us_aqi,pm2_5');
      if (ra.ok) { let a = await ra.json(); if (!Array.isArray(a)) a = [a]; CONT.tappe.forEach((t, i) => { if (per[t.id] && a[i] && a[i].current) per[t.id].aria = { aqi: a[i].current.us_aqi, pm: a[i].current.pm2_5 }; }); }
    } catch (e) { /* la qualità dell'aria è un di più */ }
    METEO = { t: Date.now(), per }; LS.set('rj.meteo', METEO);
    if (rotta.nome === 'tappa' || rotta.nome === 'viaggio') disegnaSePossibile();
  } catch (e) { /* senza meteo restano le medie del periodo */ }
  meteoInCorso = false;
}
function gradi(n) { return n == null ? '' : Math.round(n) + '°'; }

/* ---------- Grafici del meteo ---------- */
const T_MIN = 0, T_MAX = 32;
function pctT(t) { return Math.max(0, Math.min(100, (t - T_MIN) / (T_MAX - T_MIN) * 100)); }
function barraT(min, max, adesso) {
  return '<div class="scala-t" role="img" aria-label="Da ' + Math.round(min) + ' a ' + Math.round(max) + ' gradi"><span>' + gradi(min) + '</span><div class="traccia"><i style="left:' + pctT(min) + '%;width:' + (pctT(max) - pctT(min)) + '%"></i>' + (adesso != null ? '<b style="left:' + pctT(adesso) + '%" title="Adesso ' + gradi(adesso) + '"></b>' : '') + '</div><span>' + gradi(max) + '</span></div>';
}
function icoCielo(c) {
  const sole = '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>';
  const nuvola = '<path d="M7 18h10a4 4 0 00.6-7.96A5.5 5.5 0 007 10.7 3.7 3.7 0 007 18z"/>';
  const nuvolaAlta = '<path d="M7 15h10a4 4 0 00.6-7.96A5.5 5.5 0 007 7.7 3.7 3.7 0 007 15z"/>';
  let d;
  if (c === 0) d = sole;
  else if (c <= 2) d = '<circle cx="8" cy="8" r="3"/><path d="M8 2v1.3M2 8h1.3M3.8 3.8l.9.9M12.2 3.8l-.9.9"/><path d="M9.5 19.5h8a3.5 3.5 0 00.5-6.96A4.8 4.8 0 009.3 13 3.3 3.3 0 009.5 19.5z"/>';
  else if (c === 3) d = nuvola;
  else if (c === 45 || c === 48) d = '<path d="M5 8h14M3 12h18M5 16h14M8 20h8"/>';
  else if (c <= 82 && !(c >= 71 && c <= 77)) d = nuvolaAlta + '<path d="M8.5 18v2.5M12 18v3.5M15.5 18v2.5"/>';
  else if (c <= 77) d = nuvolaAlta + '<path d="M8.5 19.5h.01M12 21h.01M15.5 19.5h.01"/>';
  else d = nuvolaAlta + '<path d="M12.5 16l-2.5 3.5h3.5L11.5 23"/>';
  return '<svg class="cielo" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + '</svg>';
}
const FASCE_ARIA = [[50, '#2e9e5b'], [100, '#e6c229'], [150, '#f08c2e'], [200, '#d64545'], [300, '#8e4ba8'], [500, '#7a2b3a']];
function scalaAria(aqi) {
  let pos = 100, da = 0;
  for (let i = 0; i < FASCE_ARIA.length; i++) { const a = FASCE_ARIA[i][0]; if (aqi <= a) { pos = (i + (aqi - da) / (a - da)) / FASCE_ARIA.length * 100; break; } da = a; }
  return '<div class="scala-aria" role="img" aria-label="Qualità dell\'aria ' + esc(aria(aqi)) + ', indice ' + Math.round(aqi) + ' su una scala da 0 a 500"><div class="fasce">' + FASCE_ARIA.map((f) => '<i style="background:' + f[1] + '"></i>').join('') + '<b style="left:' + pos + '%"></b></div><div class="estremi"><span>buona</span><span>pericolosa</span></div></div>';
}
function graficoViaggio() {
  const W = 360, H = 178, x0 = 34, passo = 19, y0 = 14, ph = 112, oggi = oggiIso();
  const y = (t) => y0 + ph - (Math.max(T_MIN, Math.min(T_MAX, t)) - T_MIN) / (T_MAX - T_MIN) * ph;
  let s = '<svg class="grafico" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Temperature minime e massime per ogni giorno del viaggio">';
  [0, 10, 20, 30].forEach((g) => { s += '<line class="griglia" x1="' + (x0 - 4) + '" x2="' + (W - 2) + '" y1="' + y(g) + '" y2="' + y(g) + '"/><text class="asse" x="' + (x0 - 8) + '" y="' + (y(g) + 4) + '" text-anchor="end">' + g + '°</text>'; });
  let prec = null, previsioni = 0;
  CONT.giorni.forEach((g, i) => {
    const cx = x0 + i * passo + passo / 2;
    s += '<text class="asse' + (g.data === oggi ? ' oggi' : '') + '" x="' + cx + '" y="' + (y0 + ph + 16) + '" text-anchor="middle">' + (i + 1) + '</text>';
    const t = g.tappe.length ? tappa(g.tappe[0]) : null;
    if (!t) { prec = null; return; }
    const m = METEO && METEO.per[t.id], p = m && m.giorni[g.data] && m.giorni[g.data].max != null ? m.giorni[g.data] : null;
    const mn = p ? p.min : t.clima.min, mx = p ? p.max : t.clima.max; if (p) previsioni++;
    const yy = y(mx), hh = Math.max(9, y(mn) - y(mx));
    s += '<a href="#tappa/' + esc(t.id) + '"><title>' + esc(fmtBreve.format(dataDa(g.data)) + ', ' + t.nome + ': da ' + Math.round(mn) + '° a ' + Math.round(mx) + '° (' + (p ? 'previsione' : 'media del periodo') + ')') + '</title><rect x="' + (cx - passo / 2) + '" y="' + y0 + '" width="' + passo + '" height="' + (ph + 22) + '" fill="transparent"/>';
    s += p ? '<rect x="' + (cx - 5.5) + '" y="' + yy + '" width="11" height="' + hh + '" rx="5.5" fill="' + esc(t.colore) + '"/>' : '<rect x="' + (cx - 4.25) + '" y="' + (yy + 1.25) + '" width="8.5" height="' + (hh - 2.5) + '" rx="4.25" fill="none" stroke="' + esc(t.colore) + '" stroke-width="2.5"/>';
    s += '</a>';
    if (prec !== t.id) s += '<text class="asse nome" x="' + (cx - 6) + '" y="' + (y0 + ph + 32) + '">' + esc(t.sigla || '') + '</text>';
    prec = t.id;
  });
  s += '</svg><p class="legenda">' + (previsioni ? '<span><i class="q piena"></i>Previsione</span>' : '') + '<span><i class="q vuota"></i>Media del periodo</span></p>';
  if (!previsioni) s += '<p class="piccolo">Le previsioni sostituiscono le medie da circa due settimane prima di ogni giorno.</p>';
  return s;
}

/* ---------- Versione e aggiornamento dell'app ---------- */
let versioneNuova = null;
async function controllaVersione() {
  if (!navigator.onLine) return;
  try {
    const r = await fetch('versione.json?fresco=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    versioneNuova = j && j.v && j.v !== VERSIONE ? j.v : null;
    const b = $('#bannerVersione'); if (b) b.hidden = !versioneNuova;
  } catch (e) { /* senza rete non si controlla */ }
}
async function aggiornaApp(messaggio) {
  const dire = (t) => { if (messaggio) messaggio.textContent = t; };
  if (!navigator.onLine) { dire('Serve la rete per aggiornare.'); return; }
  try {
    // Prima si verifica che il sito risponda: solo dopo si butta la copia locale.
    const r = await fetch('versione.json?fresco=' + Date.now(), { cache: 'no-store' });
    if (!r.ok) throw new Error('sito');
    dire('Scarico la versione nuova…');
    const nomi = await caches.keys();
    await Promise.all(nomi.filter((n) => /^rajasthan-v/.test(n)).map((n) => caches.delete(n)));
    if ('serviceWorker' in navigator) { const reg = await navigator.serviceWorker.getRegistration(); if (reg) { try { await reg.update(); } catch (e) { /* si ricarica comunque */ } } }
    location.reload();
  } catch (e) { dire('Il sito non risponde: riprova più tardi. Non è stato cambiato nulla.'); }
}

/* ---------- Foto delle tappe: scaricate una volta e tenute sul dispositivo ---------- */
async function scaricaFoto() {
  if (!CONT || !navigator.onLine || !('caches' in window)) return;
  try {
    const cache = await caches.open('rajasthan-foto');
    for (const t of CONT.tappe) {
      if (!t.foto || !t.foto.url) continue;
      if (await cache.match(t.foto.url)) continue;
      try { const r = await fetch(t.foto.url, { mode: 'cors' }); if (r.ok) await cache.put(t.foto.url, r); } catch (e) { /* si riprova alla prossima apertura */ }
    }
  } catch (e) { /* le foto sono un di più */ }
}

/* ---------- Sincronizzazione con GitHub ---------- */
function token() { return LS.get('rj.token', ''); }
function repo() { return LS.get('rj.repo', ''); }
function modoSync() { return token() ? 'github' : (LS.get('rj.drive', null) ? 'drive' : ''); }
let statoSync = { fase: 'fermo', errore: '', ultima: LS.get('rj.ultimaSync', 0) };
let inCorso = false, daRifare = false, timerSync = null;

function b64DaTesto(t) {
  const b = new TextEncoder().encode(t); let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
function testoDaB64(b64) {
  const s = atob(b64.replace(/\s/g, '')); const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return new TextDecoder().decode(b);
}

/* GitHub: un file per sezione in un repository privato. */
async function gh(percorso, opzioni) {
  const o = Object.assign({ cache: 'no-store' }, opzioni || {});
  o.headers = Object.assign({ Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, o.headers || {});
  return fetch('https://api.github.com/repos/' + repo() + percorso, o);
}
const SU_GITHUB = {
  async leggi(s) {
    const r = await gh('/contents/' + s + '.json?ref=main');
    if (r.status === 200) {
      const j = await r.json();
      try { return { items: (JSON.parse(testoDaB64(j.content || '')).items) || {}, rif: j.sha }; }
      catch (e) { throw new Error('Il file ' + s + '.json nel repository non è leggibile.'); }
    }
    if (r.status === 404) return { items: {}, rif: null };
    if (r.status === 401) throw new Error('Token non valido o scaduto.');
    if (r.status === 403) throw new Error('Accesso negato da GitHub (permessi del token o limite di richieste).');
    throw new Error('GitHub ha risposto ' + r.status + '.');
  },
  async scrivi(s, items, rif) {
    const corpo = { message: 'Aggiornamento ' + s + ' dall\'app', branch: 'main', content: b64DaTesto(JSON.stringify({ v: 1, items }, null, 1)) };
    if (rif) corpo.sha = rif;
    const p = await gh('/contents/' + s + '.json', { method: 'PUT', body: JSON.stringify(corpo) });
    if (p.status === 409 || p.status === 422) return 'conflitto';
    if (p.status === 404) throw new Error('Repository non trovato o token senza permesso di scrittura.');
    if (!p.ok) throw new Error('Salvataggio non riuscito (' + p.status + ').');
    return 'ok';
  }
};

/* Google Drive: gli stessi file, in una cartella del Drive di chi accede.
   L'app vede solo i file che ha creato lei (permesso "drive.file"). */
function driveToken() { const t = LS.get('rj.driveTok', null); return t && t.scade > Date.now() ? t.t : ''; }
function caricaGoogle() {
  return new Promise((ok, ko) => {
    if (window.google && google.accounts && google.accounts.oauth2) return ok();
    const s = document.createElement('script'); s.src = 'https://accounts.google.com/gsi/client';
    s.onload = () => ok(); s.onerror = () => ko(new Error('Rete non raggiungibile.'));
    document.head.appendChild(s);
  });
}
function driveAccedi() {
  return new Promise((ok, ko) => {
    if (!(window.google && google.accounts && google.accounts.oauth2)) return ko(new Error('Accesso a Google non ancora pronto: riprova tra un momento.'));
    const c = google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CLIENT_ID, scope: 'https://www.googleapis.com/auth/drive.file',
      callback: (r) => {
        if (r && r.access_token) { LS.set('rj.driveTok', { t: r.access_token, scade: Date.now() + ((Number(r.expires_in) || 3600) - 120) * 1000 }); ok(); }
        else ko(new Error('Accesso non completato.'));
      },
      error_callback: (e) => ko(new Error(e && e.type === 'popup_closed' ? 'Finestra di accesso chiusa.' : 'Accesso non riuscito: controlla che le finestre a comparsa non siano bloccate.'))
    });
    c.requestAccessToken();
  });
}
async function gd(url, opzioni) {
  const o = Object.assign({ cache: 'no-store' }, opzioni || {});
  o.headers = Object.assign({ Authorization: 'Bearer ' + driveToken() }, o.headers || {});
  const r = await fetch(url, o);
  if (r.status === 401) { LS.del('rj.driveTok'); throw new Error('ACCESSO'); }
  return r;
}
async function driveCerca(q) {
  const r = await gd('https://www.googleapis.com/drive/v3/files?spaces=drive&fields=files(id)&q=' + encodeURIComponent(q));
  if (!r.ok) throw new Error('Google Drive ha risposto ' + r.status + '.');
  const j = await r.json(); return j.files && j.files[0] ? j.files[0].id : null;
}
async function driveCartella() {
  const st = LS.get('rj.drive', {}); if (st.cartella) return st.cartella;
  let id = await driveCerca("name='" + CARTELLA_DRIVE + "' and mimeType='application/vnd.google-apps.folder' and trashed=false");
  if (!id) {
    const r = await gd('https://www.googleapis.com/drive/v3/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: CARTELLA_DRIVE, mimeType: 'application/vnd.google-apps.folder' }) });
    if (!r.ok) throw new Error('Non riesco a creare la cartella su Drive (' + r.status + ').');
    id = (await r.json()).id;
  }
  st.cartella = id; st.file = st.file || {}; LS.set('rj.drive', st); return id;
}
function driveRicorda(s, id) { const st = LS.get('rj.drive', {}); st.file = st.file || {}; if (id) st.file[s] = id; else delete st.file[s]; LS.set('rj.drive', st); }
const SU_DRIVE = {
  async leggi(s) {
    let id = (LS.get('rj.drive', {}).file || {})[s];
    if (!id) { const c = await driveCartella(); id = await driveCerca("name='" + s + ".json' and '" + c + "' in parents and trashed=false"); if (id) driveRicorda(s, id); }
    if (!id) return { items: {}, rif: null };
    const r = await gd('https://www.googleapis.com/drive/v3/files/' + id + '?alt=media');
    if (r.status === 404) { driveRicorda(s, null); return { items: {}, rif: null }; }
    if (!r.ok) throw new Error('Google Drive ha risposto ' + r.status + '.');
    try { const j = await r.json(); return { items: (j && j.items) || {}, rif: id }; }
    catch (e) { throw new Error('Il file ' + s + '.json su Drive non è leggibile.'); }
  },
  async scrivi(s, items, rif) {
    const testo = JSON.stringify({ v: 1, items }, null, 1);
    let r;
    if (rif) {
      r = await gd('https://www.googleapis.com/upload/drive/v3/files/' + rif + '?uploadType=media', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: testo });
    } else {
      const c = await driveCartella(), lim = 'rj' + Date.now();
      const corpo = '--' + lim + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify({ name: s + '.json', parents: [c], mimeType: 'application/json' }) + '\r\n--' + lim + '\r\nContent-Type: application/json\r\n\r\n' + testo + '\r\n--' + lim + '--';
      r = await gd('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': 'multipart/related; boundary=' + lim }, body: corpo });
      if (r.ok) driveRicorda(s, (await r.clone().json()).id);
    }
    if (!r.ok) throw new Error('Salvataggio su Drive non riuscito (' + r.status + ').');
    return 'ok';
  }
};
function archivio() { return modoSync() === 'drive' ? SU_DRIVE : SU_GITHUB; }

function unisci(locale, remoto) {
  const uniti = Object.assign({}, remoto); let daInviare = false, daLocale = false;
  for (const id of Object.keys(locale)) {
    const l = locale[id], r = remoto[id];
    if (!r || (l.mod || 0) > (r.mod || 0)) { uniti[id] = l; daInviare = true; }
  }
  for (const id of Object.keys(remoto)) {
    const l = locale[id], r = remoto[id];
    if (!l || (r.mod || 0) > (l.mod || 0)) daLocale = true;
  }
  return { uniti, daInviare, daLocale };
}
async function sincronizzaSezione(s, tentativo) {
  const contatore = modifiche[s], dove = archivio();
  const rem = await dove.leggi(s);
  const esito = unisci(DB[s].items, rem.items);
  if (esito.daInviare) {
    const fatto = await dove.scrivi(s, esito.uniti, rem.rif);
    if (fatto === 'conflitto') {
      if (tentativo) throw new Error('Conflitto nel salvataggio di ' + s + '. Riprova.');
      return sincronizzaSezione(s, true);
    }
  }
  // Se nel frattempo ci sono state altre modifiche, si tengono quelle e si riprova dopo.
  if (modifiche[s] === contatore) {
    if (esito.daLocale) { DB[s].items = esito.uniti; salvaSezione(s); }
    segnaAttesa(s, false);
  } else if (esito.daLocale) {
    DB[s].items = unisci(DB[s].items, esito.uniti).uniti; salvaSezione(s);
  }
  return esito.daLocale;
}
async function sincronizza(tutte) {
  const modo = modoSync();
  if (!modo) { aggiornaStato(); return; }
  if (!navigator.onLine) { statoSync.fase = 'offline'; aggiornaStato(); return; }
  if (modo === 'drive' && !driveToken()) { statoSync.fase = 'accesso'; aggiornaStato(); return; }
  if (inCorso) { daRifare = true; return; }
  inCorso = true; statoSync.fase = 'sync'; statoSync.errore = ''; aggiornaStato();
  let cambiato = false;
  try {
    for (const s of SEZIONI) {
      if (tutte || inAttesa[s]) { if (await sincronizzaSezione(s)) cambiato = true; }
    }
    statoSync.fase = 'ok'; statoSync.ultima = Date.now(); LS.set('rj.ultimaSync', statoSync.ultima);
  } catch (e) {
    statoSync.errore = e && e.message ? e.message : 'Errore di rete.';
    if (statoSync.errore === 'ACCESSO') { statoSync.fase = 'accesso'; statoSync.errore = ''; }
    else {
      statoSync.fase = navigator.onLine ? 'errore' : 'offline';
      if (/Failed to fetch|NetworkError|Load failed/i.test(statoSync.errore)) statoSync.errore = 'Rete non raggiungibile.';
    }
  }
  inCorso = false; aggiornaStato();
  if (cambiato) disegnaSePossibile();
  if (daRifare) { daRifare = false; programmaSync(); }
}
function programmaSync() { clearTimeout(timerSync); timerSync = setTimeout(() => sincronizza(false), 3000); }

function aggiornaStato() {
  const p = $('#punto'); if (!p) return;
  const attesa = Object.keys(inAttesa).length, modo = modoSync();
  let c = 'grigio', t = 'Dati solo su questo dispositivo';
  if (modo) {
    if (statoSync.fase === 'sync') { c = 'blu'; t = 'Sincronizzazione in corso'; }
    else if (statoSync.fase === 'errore') { c = 'rosso'; t = 'Errore di sincronizzazione'; }
    else if (statoSync.fase === 'accesso' || (modo === 'drive' && !driveToken())) { c = 'ambra'; t = 'Accesso a Google da rinnovare'; }
    else if (attesa) { c = 'ambra'; t = 'Modifiche in attesa di sincronizzazione'; }
    else { c = 'verde'; t = 'Sincronizzato'; }
  }
  p.className = 'punto ' + c; $('#stato').title = t; $('#stato').setAttribute('aria-label', t);
  const box = $('#statoDett'); if (box) box.innerHTML = htmlStatoSync();
}
function htmlStatoSync() {
  const attesa = Object.keys(inAttesa), modo = modoSync();
  if (!modo) return '<p>Per ora i dati stanno solo su questo dispositivo.</p>';
  let h = '<p><b>' + (modo === 'drive' ? 'Sincronizzazione con Google Drive attiva.' : 'Sincronizzazione con GitHub attiva.') + '</b></p>';
  if (statoSync.fase === 'sync') h += '<p>Sincronizzazione in corso…</p>';
  else if (statoSync.fase === 'errore') h += '<p class="err">' + esc(statoSync.errore) + '</p>';
  else if (modo === 'drive' && !driveToken()) h += '<p class="err">L\'accesso a Google è scaduto: rinnovalo per riprendere la sincronizzazione. Intanto i dati restano al sicuro su questo dispositivo.</p>';
  else if (!navigator.onLine) h += '<p>Senza rete: la sincronizzazione riprende da sola.</p>';
  h += '<p>' + (attesa.length ? 'In attesa: ' + esc(attesa.join(', ')) + '.' : 'Nessuna modifica in attesa.') + '</p>';
  h += '<p class="tenue">Ultima sincronizzazione: ' + (statoSync.ultima ? esc(fmtOra.format(new Date(statoSync.ultima))) : 'mai') + '</p>';
  return h;
}
function mostraAvvisoMemoria() { const a = $('#avvisoMemoria'); if (a) a.hidden = false; }

/* ---------- Account (Firebase Authentication, via REST) ---------- */
// Chiave API web di Firebase: non è un segreto, identifica solo il progetto.
const FIREBASE_API_KEY = 'AIzaSyBkU8Dr_7L9hc_GlBO5f-2ynrsNEugd4cg';
// Account di Gerry: su questi le sezioni personali (Liste, Foto, Diario) si attivano anche su un dispositivo nuovo.
const PROPRIETARI = [];
const URL_AUTH = 'https://identitytoolkit.googleapis.com/v1/accounts:';
let ACC = LS.get('rj.acc', null);
const ERR_ACC = {
  EMAIL_EXISTS: 'Esiste già un account con questa email: usa "Entra".',
  INVALID_LOGIN_CREDENTIALS: 'Email o password non corrette.', INVALID_PASSWORD: 'Email o password non corrette.', EMAIL_NOT_FOUND: 'Email o password non corrette.',
  INVALID_EMAIL: 'L\'email non sembra valida.', MISSING_PASSWORD: 'Scrivi la password.', MISSING_EMAIL: 'Scrivi l\'email.',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Troppi tentativi: riprova tra qualche minuto.', USER_DISABLED: 'Questo account è stato disattivato.',
  OPERATION_NOT_ALLOWED: 'Questo modo di accesso non è ancora attivo.'
};
function errAcc(m) {
  m = String(m || ''); if (m.indexOf('WEAK_PASSWORD') === 0) return 'Password troppo corta: almeno 6 caratteri.';
  return ERR_ACC[m.split(' ')[0]] || 'Accesso non riuscito (' + m + ').';
}
async function chiamaAuth(metodo, corpo) {
  if (!FIREBASE_API_KEY) throw new Error('L\'accesso non è ancora attivo in questa versione dell\'app.');
  const r = await fetch(URL_AUTH + metodo + '?key=' + FIREBASE_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(errAcc(j.error && j.error.message));
  return j;
}
function salvaAcc(j, metodo) {
  const prima = io().id;
  ACC = { uid: j.localId, idToken: j.idToken, refreshToken: j.refreshToken, scad: Date.now() + (+j.expiresIn || 3600) * 1000, email: j.email || '', metodo };
  LS.set('rj.acc', ACC);
  if (PROPRIETARI.indexOf(ACC.uid) >= 0) LS.set('rj.proprietario', true);
  migraIdentita(prima, ACC.uid);
  const x = io(); if (!x.n && j.displayName) { x.n = String(j.displayName).split(' ')[0].slice(0, 40); LS.set('rj.io', x); }
}
// Le adesioni date prima dell'accesso passano all'account.
function migraIdentita(da, a) {
  const x = io(); x.id = a; LS.set('rj.io', x);
  if (!da || da === a) return;
  const nuova = {};
  Object.keys(coda).forEach((k) => {
    let v = coda[k]; const p = k.split('/');
    if (p[p.length - 1] === da) p[p.length - 1] = a;
    if (v && typeof v === 'object' && v.autore && v.autore.id === da) v = Object.assign({}, v, { autore: Object.assign({}, v.autore, { id: a }) });
    nuova[p.join('/')] = v;
  });
  coda = nuova; LS.set('rj.grCoda', coda); GRV = null;
}
async function tokenAcc() {
  if (!ACC) return '';
  if (ACC.scad - 60000 > Date.now()) return ACC.idToken;
  const r = await fetch('https://securetoken.googleapis.com/v1/token?key=' + FIREBASE_API_KEY, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(ACC.refreshToken) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { if (r.status === 400) { ACC = null; LS.del('rj.acc'); } throw new Error('L\'accesso è scaduto: entra di nuovo.'); }
  ACC = Object.assign({}, ACC, { idToken: j.id_token, refreshToken: j.refresh_token, scad: Date.now() + (+j.expires_in || 3600) * 1000 });
  LS.set('rj.acc', ACC); return ACC.idToken;
}
function esciAccount() { ACC = null; LS.del('rj.acc'); statoGr = { fase: 'fermo', errore: '', ultima: 0 }; try { if (window.google && google.accounts && google.accounts.id) google.accounts.id.disableAutoSelect(); } catch (e) {} }
async function accediConIdGoogle(credenziale) {
  const j = await chiamaAuth('signInWithIdp', { postBody: 'id_token=' + credenziale + '&providerId=google.com', requestUri: location.origin + location.pathname, returnSecureToken: true, returnIdpCredential: true });
  salvaAcc(j, 'google');
}
// Pulsante "Accedi con Google" nel riquadro #gAcc, se presente nella vista.
function montaGoogle() {
  const el = $('#gAcc'); if (!el || !GOOGLE_CLIENT_ID || !FIREBASE_API_KEY || !navigator.onLine) return;
  caricaGoogle().then(() => {
    if (!(window.google && google.accounts && google.accounts.id) || !document.body.contains(el)) return;
    google.accounts.id.initialize({
      client_id: GOOGLE_CLIENT_ID, use_fedcm_for_prompt: true,
      callback: async (r) => {
        const err = $('#errAcc');
        try { await accediConIdGoogle(r.credential); await dopoAccesso(); }
        catch (e) { if (err) { err.textContent = e.message; err.hidden = false; } }
      }
    });
    el.innerHTML = ''; google.accounts.id.renderButton(el, { theme: 'outline', size: 'large', shape: 'pill', text: 'continue_with', locale: 'it', width: Math.min(320, el.clientWidth || 320) });
  }).catch(() => {});
}
function htmlAccesso(perche) {
  if (!FIREBASE_API_KEY) return '<p class="tenue">L\'accesso non è ancora attivo: aggiorna l\'app tra qualche giorno.</p>';
  return '<div class="accesso"><p>' + esc(perche) + '</p><div id="gAcc" class="g-acc"></div><p class="oppure">oppure con email e password</p>' +
    '<label>Email<input id="fEmail" type="email" autocomplete="email" autocapitalize="off" spellcheck="false"></label>' +
    '<label>Password<input id="fPass" type="password" autocomplete="current-password" minlength="6"></label>' +
    '<p class="err" id="errAcc" hidden></p><p class="tenue" id="msgAcc"></p>' +
    '<div class="azioni larghe"><button class="btn" data-az="accEntra">Entra</button><button class="btn chiaro" data-az="accNuovo">Crea l\'account</button></div>' +
    '<p><button class="link-btn" data-az="accReset">Password dimenticata?</button></p></div>';
}
// Dopo l'accesso: se c'è un invito in sospeso si entra nel gruppo, altrimenti si ridisegna.
async function dopoAccesso() {
  const inv = LS.get('rj.invito', '');
  if (inv) { LS.del('rj.invito'); await entraNelGruppo(inv, io().n || ''); return; }
  await grSincronizza(); disegna();
}
async function azioneAccount(az, el) {
  if (['accEntra', 'accNuovo', 'accReset'].indexOf(az) < 0) return false;
  const err = $('#errAcc'), msg = $('#msgAcc'), email = ($('#fEmail').value || '').trim(), pass = $('#fPass').value || '';
  err.hidden = true; msg.textContent = '';
  const fn = $('#fNome'); if (fn && fn.value.trim()) { const x = io(); x.n = fn.value.trim().slice(0, 40); LS.set('rj.io', x); }
  if (!navigator.onLine) { err.textContent = 'Serve la rete per entrare.'; err.hidden = false; return true; }
  try {
    if (az === 'accReset') {
      if (!email) throw new Error('Scrivi la tua email qui sopra, poi premi di nuovo.');
      await chiamaAuth('sendOobCode', { requestType: 'PASSWORD_RESET', email });
      msg.textContent = 'Se l\'email ha un account, ti arriva un messaggio per scegliere una password nuova. Guarda anche nello spam.';
      return true;
    }
    if (az === 'accNuovo' && pass.length < 6) throw new Error('Scegli una password di almeno 6 caratteri.');
    el.disabled = true;
    const j = await chiamaAuth(az === 'accNuovo' ? 'signUp' : 'signInWithPassword', { email, password: pass, returnSecureToken: true });
    salvaAcc(j, 'email'); await dopoAccesso();
  } catch (e) { err.textContent = e.message; err.hidden = false; el.disabled = false; }
  return true;
}

/* ---------- Sezioni personali solo per il proprietario ---------- */
function proprietario() {
  return !!(LS.get('rj.proprietario', false) || modoSync() || (ACC && PROPRIETARI.indexOf(ACC.uid) >= 0));
}
const SEZ_PERSONALI = ['liste', 'sim', 'foto', 'diario'];
function aggiornaModoOspite() {
  const p = proprietario();
  if (p && !LS.get('rj.proprietario', false)) LS.set('rj.proprietario', true);
  document.body.classList.toggle('ospite', !p);
}

/* ---------- Gruppo di viaggio: percorsi e adesioni (Firebase Realtime Database) ---------- */
// Indirizzo del database del gruppo (non è un segreto: i dati stanno sotto il codice del gruppo,
// che non compare mai nel repository). Vuoto = le adesioni restano su questo dispositivo.
const FIREBASE_DB = 'https://tutto-rajasthan-default-rtdb.europe-west1.firebasedatabase.app';
const PASTI = [['colazione', 'Colazione'], ['pranzo', 'Pranzo'], ['spuntino', 'Spuntino'], ['cena', 'Cena']];
let GR = LS.get('rj.gr', {});          // ultima copia del gruppo scaricata
let coda = LS.get('rj.grCoda', {});    // scritture in attesa: percorso -> valore (null = cancella)
let GRV = null;                        // copia + coda, ricalcolata quando serve
let statoGr = { fase: 'fermo', errore: '', ultima: LS.get('rj.grUltima', 0) };
let grInCorso = false, timerGr = null;
let BOZZA = null;                      // proposta in scrittura

function io() {
  let x = LS.get('rj.io', null);
  if (!x || !x.id) { x = { id: 'p' + Math.random().toString(36).slice(2, 12), n: '' }; LS.set('rj.io', x); }
  return x;
}
function codiceGruppo() { return LS.get('rj.gruppo', ''); }
function nuovoCodice() {
  const a = 'abcdefghjkmnpqrstuvwxyz23456789', b = new Uint8Array(20);
  crypto.getRandomValues(b); return Array.from(b, (x) => a[x % a.length]).join('');
}
function impostaIn(o, percorso, val) {
  const p = percorso.split('/'); let x = o;
  for (let i = 0; i < p.length - 1; i++) {
    if (x[p[i]] == null || typeof x[p[i]] !== 'object') { if (val === null) return; x[p[i]] = {}; }
    x = x[p[i]];
  }
  if (val === null) delete x[p[p.length - 1]]; else x[p[p.length - 1]] = val;
}
function gruppo() {
  if (!GRV) { GRV = JSON.parse(JSON.stringify(GR || {})); Object.keys(coda).forEach((k) => impostaIn(GRV, k, coda[k])); }
  return GRV;
}
function grScrivi(campi) { Object.assign(coda, campi); LS.set('rj.grCoda', coda); GRV = null; clearTimeout(timerGr); timerGr = setTimeout(grSincronizza, 800); }
function grUrl(tok) { return FIREBASE_DB.replace(/\/$/, '') + '/g2/' + encodeURIComponent(codiceGruppo()) + '.json?auth=' + encodeURIComponent(tok); }
async function grSincronizza() {
  if (!FIREBASE_DB || !codiceGruppo() || !ACC || grInCorso || !navigator.onLine) return;
  grInCorso = true; statoGr.fase = 'sync';
  try {
    const tok = await tokenAcc();
    const invio = Object.assign({}, coda);
    if (Object.keys(invio).length) {
      const r = await fetch(grUrl(tok), { method: 'PATCH', body: JSON.stringify(invio) });
      if (!r.ok) throw new Error(r.status === 401 || r.status === 403 ? 'Il database ha rifiutato la scrittura: vanno controllate le regole, oppure stai cambiando qualcosa di un altro.' : 'Il database ha risposto con un errore (' + r.status + ').');
      Object.keys(invio).forEach((k) => { if (JSON.stringify(coda[k]) === JSON.stringify(invio[k])) delete coda[k]; });
      LS.set('rj.grCoda', coda);
    }
    const r2 = await fetch(grUrl(tok));
    if (!r2.ok) throw new Error(r2.status === 401 || r2.status === 403 ? 'Il database ha rifiutato la lettura: vanno controllate le regole.' : 'Il database ha risposto con un errore (' + r2.status + ').');
    GR = (await r2.json()) || {}; LS.set('rj.gr', GR); GRV = null;
    statoGr = { fase: 'ok', errore: '', ultima: Date.now() }; LS.set('rj.grUltima', statoGr.ultima);
  } catch (e) {
    statoGr.fase = 'errore';
    statoGr.errore = /fetch|Network|Load failed/i.test(e.message) ? 'Rete non raggiungibile: riprovo da solo.' : e.message;
  }
  grInCorso = false;
  if (['giorno', 'tappa', 'impostazioni', 'gruppo', 'viaggio'].indexOf(rotta.nome) >= 0) disegnaSePossibile();
}
function salvaNome(n) {
  const x = io(); x.n = String(n || '').trim().slice(0, 40); LS.set('rj.io', x);
  if (x.n) grScrivi({ ['persone/' + x.id]: { n: x.n, t: Date.now() } });
}

function percorsiDi(tid) {
  const t = tappa(tid); if (!t) return [];
  const base = (t.percorsi || []).map((p) => Object.assign({ tappa: tid }, p));
  const prop = Object.entries(gruppo().proposte || {}).filter(([, p]) => p && p.tappa === tid).map(([k, p]) => Object.assign({}, p, { id: k, proposta: true }));
  return base.concat(prop.sort((a, b) => (a.t || 0) - (b.t || 0)));
}
function aderenti(data, pid) { return Object.keys((((gruppo().adesioni || {})[data]) || {})[pid] || {}); }
function nomeDi(p) { if (p === io().id) return 'tu'; const x = (gruppo().persone || {})[p]; return x && x.n ? x.n : 'qualcuno'; }
function locale(t, id) { return id ? (t.locali || []).find((l) => l.id === id) : null; }
const TIPO_LOC = { completo: 'Pasto completo', leggero: 'Leggero', entrambi: 'Leggero o completo' };
const NOME_PASTO = { colazione: 'Colazione', pranzo: 'Pranzo', cena: 'Cena', spuntino: 'Spuntino' };
function adattoA(l, k, completo) {
  if (k === completo) return l.tipo !== 'leggero' && l.pasti.indexOf(k) >= 0;
  return l.tipo !== 'completo' && (l.pasti.indexOf(k) >= 0 || l.pasti.indexOf('spuntino') >= 0);
}
function htmlLocale(l) {
  let h = '<li class="locale"><div class="loc-testa"><b>' + esc(l.n) + '</b><span class="prezzo" title="Prezzo indicativo">' + '₹'.repeat(l.prezzo || 1) + '</span></div>';
  h += '<p class="tenue">' + esc(l.zona) + '</p><p>' + esc(l.cosa) + '</p><span class="etichette"><span class="et">' + esc(TIPO_LOC[l.tipo] || '') + '</span>' + l.pasti.map((p) => '<span class="et">' + esc(NOME_PASTO[p]) + '</span>').join('') + (l.veg ? '<span class="et">Vegetariano</span>' : '') + '</span>';
  if (l.nota) h += '<p class="tenue nota">' + esc(l.nota) + '</p>';
  return h + '</li>';
}
function htmlVicini(t, x) {
  const v = (t.locali || []).filter((l) => l.vicino.indexOf(x.t) >= 0);
  if (!v.length) return '';
  return '<div class="vicini"><h4>Per mangiare qui vicino</h4><ul>' + v.map((l) => '<li><b>' + esc(l.n) + '</b> <span class="tenue">' + esc(TIPO_LOC[l.tipo].toLowerCase()) + ', ' + '₹'.repeat(l.prezzo || 1) + '</span><br>' + esc(l.cosa) + '</li>').join('') + '</ul></div>';
}
function htmlDoveMangiare(t) {
  const L = t.locali || []; if (!L.length) return '';
  const compl = L.filter((l) => l.tipo !== 'leggero'), legg = L.filter((l) => l.tipo === 'leggero');
  let h = '<h2 class="sez">' + arco(t.colore, 18) + 'Dove mangiare</h2><div class="pannello">';
  if (compl.length) h += '<h2>Per il pasto completo</h2><ul class="locali">' + compl.map(htmlLocale).join('') + '</ul>';
  if (legg.length) h += '<h2>Colazioni, pasti leggeri e spuntini</h2><ul class="locali">' + legg.map(htmlLocale).join('') + '</ul>';
  return h + '<p class="tenue nota" style="padding-bottom:14px">₹ economico, ₹₹ medio, ₹₹₹ caro: indicativo. Nomi e orari vengono da guide e recensioni: verificarli sul posto.</p></div>';
}

function htmlPercorso(p, t, data) {
  const me = io().id, ad = aderenti(data, p.id), mio = ad.indexOf(me) >= 0, mia = p.proposta && p.autore && p.autore.id === me;
  let h = '<article class="percorso' + (mio ? ' mio' : '') + '"' + stileCitta(t) + '><header><h3>' + esc(p.titolo) + '</h3>' + (p.sotto ? '<p>' + esc(p.sotto) + '</p>' : '');
  if (p.proposta) h += '<p class="autore">Proposto da ' + esc(mia ? 'te' : (p.autore && p.autore.n) || 'qualcuno') + '</p>';
  h += '</header><ol class="soste">' + (p.soste || []).map((s) => '<li><span class="ora">' + esc(s.ora || '') + '</span><div><b>' + esc(s.t) + '</b>' + (s.dur ? ' <span class="tenue">' + esc(s.dur) + '</span>' : '') + (s.nota ? '<p class="tenue">' + esc(s.nota) + '</p>' : '') + '</div></li>').join('') + '</ol>';
  h += '<dl class="pasti">' + PASTI.map(([k, n]) => {
    const m = (p.pasti || {})[k] || {}, l = locale(t, m.l), c = p.completo === k;
    return '<div' + (c ? ' class="completo"' : '') + '><dt>' + n + (c ? '<span class="et">completo</span>' : '') + '</dt><dd>' + (l ? '<b>' + esc(l.n) + '</b>' : '') + (m.c ? (l ? '<br>' : '') + esc(m.c) : '') + (!l && !m.c ? '<span class="tenue">Libero</span>' : '') + '</dd></div>';
  }).join('') + '</dl>';
  h += '<footer><button class="btn' + (mio ? '' : ' chiaro') + ' piccolo" data-az="aderisci" data-data="' + esc(data) + '" data-id="' + esc(p.id) + '" aria-pressed="' + mio + '">' + (mio ? 'Ci sto ✓' : 'Ci sto') + '</button>';
  h += '<span class="chi">' + (ad.length ? esc((s => s.charAt(0).toUpperCase() + s.slice(1))(ad.map(nomeDi).join(', '))) : 'Ancora nessuno') + '</span>';
  h += '<a class="link" href="#proponi/' + esc(data) + '/' + esc(t.id) + '/' + esc(p.id) + '">' + (mia ? 'Modifica' : 'Copia e cambia') + '</a></footer></article>';
  return h;
}
function htmlAvvisoGruppo() {
  if (!FIREBASE_DB) return '<p class="avviso-gr">Per ora le adesioni restano su questo dispositivo: il voto con i compagni si attiva appena il database del gruppo è pronto.</p>';
  if (!codiceGruppo()) return '<p class="avviso-gr">Le adesioni restano su questo dispositivo. Per vedere quelle dei compagni <a href="#impostazioni">entra nel gruppo</a> o apri il link d\'invito.</p>';
  if (statoGr.fase === 'errore') return '<p class="avviso-gr err">' + esc(statoGr.errore) + '</p>';
  return '';
}
function htmlNome() {
  if (io().n) return '';
  return '<div class="pannello pieno nome-box"><label>Il tuo nome, come lo vedranno gli altri<input id="fNome" maxlength="40" autocomplete="given-name"></label><div class="azioni"><button class="btn piccolo" data-az="salvaNome">Salva</button></div></div>';
}

function vistaGiorno(data) {
  const g = CONT.giorni.find((x) => x.data === data); if (!g) return vistaViaggio();
  let h = '<p class="tenue intro-giorno">' + (g.nota ? esc(g.nota) + '.<br>' : '') + 'Scegli con "Ci sto": chi aderisce allo stesso percorso va insieme. Un solo pasto completo al giorno, a pranzo o a cena.</p>';
  h += htmlAvvisoGruppo() + htmlNome();
  if (!g.tappe.length) h += '<div class="pannello vuoto"><h3>Giorno di viaggio</h3><p class="tenue">Niente percorsi per oggi.</p></div>';
  g.tappe.forEach((tid) => {
    const t = tappa(tid); if (!t) return;
    const lista = percorsiDi(tid).map((p, i) => ({ p, i, n: aderenti(data, p.id).length })).sort((a, b) => b.n - a.n || a.i - b.i);
    h += '<h2 class="sez"' + stileCitta(t) + '>' + arco(t.colore, 18) + esc(t.nome) + '</h2>';
    h += lista.map((x) => htmlPercorso(x.p, t, data)).join('');
    h += '<div class="azioni larghe"><a class="chip" href="#proponi/' + esc(data) + '/' + esc(tid) + '">' + ICO.piu + 'Proponi un percorso</a><a class="chip" href="#tappa/' + esc(tid) + '">Cosa vedere e dove mangiare</a></div>';
  });
  if (CONT.calendarioStimato) h += '<p class="pie">Calendario stimato: gli orari dei percorsi vanno adattati al programma del coordinatore e ai tempi del gruppo.</p>';
  return { titolo: fmtGiorno.format(dataDa(data)), html: h, indietro: '#viaggio' };
}

function nuovaBozza(chiave, data, t, srcId) {
  const src = srcId ? percorsiDi(t.id).find((p) => p.id === srcId) : null;
  const mia = src && src.proposta && src.autore && src.autore.id === io().id;
  const b = { chiave, data, tappa: t.id, editId: mia ? src.id : '', titolo: src ? (mia ? src.titolo : src.titolo + ' (variante)') : '', sotto: src ? src.sotto || '' : '', soste: {}, altro: '', altroOra: '', completo: src ? src.completo : 'cena', pasti: {} };
  (src ? src.soste || [] : []).forEach((s) => {
    if (t.vedere.some((x) => x.t === s.t)) b.soste[s.t] = { on: true, ora: s.ora || '', dur: s.dur || '', nota: s.nota || '' };
    else if (!b.altro) { b.altro = s.t; b.altroOra = s.ora || ''; }
  });
  PASTI.forEach(([k]) => { const m = src && src.pasti && src.pasti[k]; b.pasti[k] = { l: m ? m.l || '' : '', c: m ? m.c || '' : '' }; });
  return b;
}
function vistaProponi(arg) {
  const [data, tid, srcId] = arg.split('/'); const t = tappa(tid);
  if (!t || !CONT.giorni.some((g) => g.data === data)) return vistaViaggio();
  if (!BOZZA || BOZZA.chiave !== arg) BOZZA = nuovaBozza(arg, data, t, srcId);
  const b = BOZZA;
  let h = '<div' + stileCitta(t) + '><p class="tenue intro-giorno">' + esc(t.nome) + ', ' + esc(fmtLungo.format(dataDa(data))) + '. La proposta la vedono tutti i compagni del gruppo.</p>' + htmlNome();
  h += '<div class="pannello pieno editor"><label>Titolo<input data-b="titolo" maxlength="60" value="' + esc(b.titolo) + '" placeholder="Es. Mattina al forte, sera sul lago"></label>';
  h += '<label>In due parole<textarea data-b="sotto" rows="2" maxlength="200">' + esc(b.sotto) + '</textarea></label>';
  h += '<h3 class="ed-sez">Cosa vedere</h3><p class="tenue">Spunta le soste e indica l\'ora, se vuoi.</p><ul class="scegli-soste">';
  t.vedere.forEach((x, i) => { const s = b.soste[x.t] || {}; h += '<li><label class="riga"><input type="checkbox" data-bs="' + i + '"' + (s.on ? ' checked' : '') + '><span>' + esc(x.t) + '</span></label><input type="time" data-bo="' + i + '" value="' + esc(s.ora || '') + '" aria-label="Ora per ' + esc(x.t) + '"></li>'; });
  h += '<li><input data-b="altro" maxlength="80" value="' + esc(b.altro) + '" placeholder="Altro: un mercato, una passeggiata…"><input type="time" data-b="altroOra" value="' + esc(b.altroOra) + '" aria-label="Ora"></li></ul>';
  h += '<h3 class="ed-sez">Pasti</h3><p class="tenue">Il pasto completo è uno solo: gli altri restano leggeri.</p><div class="scelta-completo" role="radiogroup" aria-label="Pasto completo">' +
    ['pranzo', 'cena'].map((k) => '<label class="pill' + (b.completo === k ? ' on' : '') + '"><input type="radio" name="completo" data-b="completo" value="' + k + '"' + (b.completo === k ? ' checked' : '') + '>Completo a ' + k + '</label>').join('') + '</div>';
  PASTI.forEach(([k, n]) => {
    const m = b.pasti[k], ok = (t.locali || []).filter((l) => adattoA(l, k, b.completo));
    if (m.l && !ok.some((l) => l.id === m.l)) m.l = '';
    h += '<div class="pasto-ed"><label>' + n + (b.completo === k ? ' (completo)' : '') + '<select data-bp="' + k + '"><option value="">Libero o da decidere</option>' + ok.map((l) => '<option value="' + esc(l.id) + '"' + (m.l === l.id ? ' selected' : '') + '>' + esc(l.n) + '</option>').join('') + '</select></label>';
    h += '<input data-bc="' + k + '" maxlength="80" value="' + esc(m.c) + '" placeholder="Cosa (facoltativo)" aria-label="Cosa mangiare a ' + n.toLowerCase() + '"></div>';
  });
  h += '<p class="err" id="errProp" hidden></p><div class="azioni larghe"><button class="btn" data-az="salvaProposta">' + (b.editId ? 'Salva le modifiche' : 'Proponi') + '</button><a class="btn chiaro" href="#giorno/' + esc(data) + '">Annulla</a>' + (b.editId ? '<button class="btn pericolo" data-az="ritira">Ritira</button>' : '') + '</div></div></div>';
  return { titolo: b.editId ? 'Modifica la proposta' : 'Nuova proposta', html: h, indietro: '#giorno/' + data };
}
function bozzaDaCampo(el) {
  if (!BOZZA || !el.dataset) return false;
  const t = tappa(BOZZA.tappa), d = el.dataset;
  if (d.b) { BOZZA[d.b] = el.value; return d.b === 'completo'; }
  if (d.bs != null || d.bo != null) {
    const x = t.vedere[+(d.bs != null ? d.bs : d.bo)]; if (!x) return false;
    const s = BOZZA.soste[x.t] || (BOZZA.soste[x.t] = { on: false, ora: '' });
    if (d.bs != null) s.on = el.checked; else { s.ora = el.value; if (el.value) { s.on = true; const c = $('[data-bs="' + d.bo + '"]'); if (c) c.checked = true; } }
    return false;
  }
  if (d.bp) { BOZZA.pasti[d.bp].l = el.value; return false; }
  if (d.bc) { BOZZA.pasti[d.bc].c = el.value; return false; }
  return false;
}
function salvaProposta() {
  const b = BOZZA, t = tappa(b.tappa), err = $('#errProp');
  const mostra = (m) => { err.textContent = m; err.hidden = false; };
  const soste = t.vedere.map((x, i) => ({ x, i, s: b.soste[x.t] })).filter((o) => o.s && o.s.on).map((o) => {
    const r = { t: o.x.t, _i: o.i }; if (o.s.ora) r.ora = o.s.ora; if (o.s.dur) r.dur = o.s.dur; if (o.s.nota) r.nota = o.s.nota; return r;
  });
  if (b.altro.trim()) soste.push({ t: b.altro.trim(), _i: 99, ora: b.altroOra || undefined });
  soste.sort((a, c) => (a.ora || '99') .localeCompare(c.ora || '99') || a._i - c._i); soste.forEach((s) => { delete s._i; if (!s.ora) delete s.ora; });
  if (!b.titolo.trim()) return mostra('Dai un titolo alla proposta.');
  if (!soste.length) return mostra('Scegli almeno una cosa da vedere.');
  if (!io().n) return mostra('Scrivi il tuo nome qui sopra: serve agli altri per sapere chi propone.');
  const pasti = {}; PASTI.forEach(([k]) => { const m = b.pasti[k]; if (m.l || m.c.trim()) pasti[k] = Object.assign({}, m.l ? { l: m.l } : {}, m.c.trim() ? { c: m.c.trim() } : {}); });
  const id = b.editId || 'u' + nuovoId(), me = io();
  grScrivi({
    ['proposte/' + id]: { tappa: b.tappa, titolo: b.titolo.trim(), sotto: b.sotto.trim(), soste, pasti, completo: b.completo, autore: { id: me.id, n: me.n }, t: Date.now() },
    ['adesioni/' + b.data + '/' + id + '/' + me.id]: Date.now()
  });
  const data = b.data; BOZZA = null; location.hash = '#giorno/' + data;
}

function htmlImpostazioniGruppo() {
  let h = '<h2 class="sez">Gruppo di viaggio</h2><section class="pannello pieno">';
  h += '<p>I percorsi di ogni giorno si scelgono insieme: ognuno dice "Ci sto" e può proporne di nuovi.</p>';
  h += '<label>Il tuo nome<input id="fNome" maxlength="40" value="' + esc(io().n) + '" autocomplete="given-name"></label><div class="azioni"><button class="btn chiaro piccolo" data-az="salvaNome">Salva il nome</button></div>';
  if (!FIREBASE_DB) return h + '<p class="tenue" style="margin-top:14px">Il voto con i compagni non è ancora attivo.</p></section>';
  if (!ACC) return h + '<div style="margin-top:18px">' + htmlAccesso('Per creare il gruppo o entrarci serve un accesso: così le tue scelte ti seguono su telefono e computer.') + '</div></section>';
  h += '<p style="margin-top:16px">Accesso ' + (ACC.metodo === 'google' ? 'con Google' : 'con email') + (ACC.email ? ': <b>' + esc(ACC.email) + '</b>' : '') + '.</p>';
  if (codiceGruppo()) {
    h += '<p style="margin-top:10px"><b>Sei in un gruppo.</b> ' + (statoGr.fase === 'errore' ? '<span class="err">' + esc(statoGr.errore) + '</span>' : statoGr.ultima ? 'Aggiornato il ' + esc(fmtOra.format(new Date(statoGr.ultima))) + '.' : '') + (Object.keys(coda).length ? ' Modifiche in attesa di invio.' : '') + '</p>';
    h += '<div class="azioni"><button class="btn piccolo" data-az="invita">Invita i compagni</button><button class="btn chiaro piccolo" data-az="grAggiorna">Aggiorna</button><button class="btn pericolo piccolo" data-az="esciGruppo">Esci dal gruppo</button></div><p class="tenue" id="msgGruppo"></p>';
    h += '<p class="tenue" style="margin-top:10px">Chi ha il link d\'invito può entrare nel gruppo: mandalo solo ai compagni di viaggio. Ognuno può cambiare solo le proprie adesioni e proposte.</p>';
  } else {
    h += '<p class="tenue" style="margin-top:10px">Uno solo crea il gruppo e manda il link d\'invito agli altri, per esempio su WhatsApp.</p><div class="azioni"><button class="btn piccolo" data-az="creaGruppo">Crea il gruppo</button></div><p class="err" id="errGruppo" hidden></p>';
  }
  h += '<div class="azioni" style="margin-top:14px"><button class="btn chiaro piccolo" data-az="esciAccount">Esci dall\'account</button></div>';
  if (proprietario()) h += '<p class="tenue" style="margin-top:10px">Identificativo del tuo account (serve a riconoscerti sui dispositivi nuovi): <span class="codice">' + esc(ACC.uid) + '</span></p>';
  return h + '</section>';
}
function vistaGruppo(codice) {
  let h = '';
  const dopo = () => montaGoogle();
  if (!/^[a-z2-9]{16,40}$/.test(codice || '')) h = '<div class="pannello vuoto"><h3>Link d\'invito non valido</h3><p class="tenue">Chiedi di nuovo il link a chi ha creato il gruppo.</p></div>';
  else if (codice === codiceGruppo() && ACC) h = '<div class="pannello vuoto"><h3>Sei già in questo gruppo</h3><p><a class="chip" href="#viaggio">Vai al viaggio</a></p></div>';
  else {
    h = '<div class="pannello pieno"><h3>Ti hanno invitato nel gruppo di viaggio</h3><p>Entrando vedi i percorsi di ogni giorno, chi aderisce a cosa, e puoi proporre i tuoi. Gli altri vedranno il tuo nome, le tue adesioni e le tue proposte.</p>';
    if (codiceGruppo() && codiceGruppo() !== codice) h += '<p class="err">Sei già in un altro gruppo: entrando lasci quello.</p>';
    if (!FIREBASE_DB) h += '<p class="err">Questa versione dell\'app non ha ancora il gruppo: aggiornala dalle impostazioni e riapri il link.</p>';
    h += '<label>Il tuo nome<input id="fNome" maxlength="40" value="' + esc(io().n) + '" autocomplete="given-name"></label><p class="err" id="errGruppo" hidden></p>';
    if (ACC) h += '<div class="azioni larghe"><button class="btn" data-az="entra" data-codice="' + esc(codice) + '">Entra nel gruppo</button></div>';
    else { LS.set('rj.invito', codice); h += '<div style="margin-top:16px">' + htmlAccesso('Per entrare serve un accesso: con lo stesso account ritrovi le tue scelte su telefono e computer.') + '</div>'; }
    h += '<p class="tenue" style="margin-top:12px"><a href="privacy.html">Informativa sulla privacy</a></p></div>';
  }
  return { titolo: 'Gruppo di viaggio', html: h, indietro: '#viaggio', dopo };
}
async function entraNelGruppo(codice, nome) {
  if (codiceGruppo() !== codice) { GR = {}; LS.set('rj.gr', GR); }
  LS.set('rj.gruppo', codice); GRV = null;
  if (nome) salvaNome(nome); else if (io().n) salvaNome(io().n);
  await grSincronizza(); location.hash = '#viaggio'; disegna();
}
async function azioneGruppo(az, el) {
  if (az === 'aderisci') {
    const d = el.dataset.data, pid = el.dataset.id, me = io().id, mio = aderenti(d, pid).indexOf(me) >= 0;
    grScrivi({ ['adesioni/' + d + '/' + pid + '/' + me]: mio ? null : Date.now() });
    disegna(); return true;
  }
  if (az === 'salvaNome') { salvaNome($('#fNome').value); disegna(); return true; }
  if (az === 'salvaProposta') { salvaProposta(); return true; }
  if (az === 'ritira') {
    if (!el.dataset.conferma) { el.dataset.conferma = '1'; el.textContent = 'Conferma: ritira'; return true; }
    const data = BOZZA.data; grScrivi({ ['proposte/' + BOZZA.editId]: null }); BOZZA = null; location.hash = '#giorno/' + data; return true;
  }
  if (az === 'creaGruppo' || az === 'entra') {
    const n = $('#fNome').value.trim(), err = $('#errGruppo');
    if (!n) { err.textContent = 'Scrivi il tuo nome: è quello che vedranno gli altri.'; err.hidden = false; return true; }
    if (!navigator.onLine) { err.textContent = 'Serve la rete per entrare nel gruppo.'; err.hidden = false; return true; }
    if (!ACC) { err.textContent = 'Prima accedi.'; err.hidden = false; return true; }
    if (az === 'entra') { await entraNelGruppo(el.dataset.codice, n); return true; }
    LS.set('rj.gruppo', nuovoCodice()); GR = {}; GRV = null; salvaNome(n); await grSincronizza(); disegna();
    return true;
  }
  if (az === 'esciAccount') { esciAccount(); disegna(); return true; }
  if (az === 'invita') {
    const link = location.origin + location.pathname + '#gruppo/' + codiceGruppo(), msg = $('#msgGruppo');
    const testo = 'Per scegliere insieme i percorsi del Rajasthan, apri questo link nell\'app Tutto Rajasthan:';
    try { if (navigator.share) { await navigator.share({ title: 'Tutto Rajasthan, gruppo di viaggio', text: testo, url: link }); return true; } } catch (x) { if (x && x.name === 'AbortError') return true; }
    try { await navigator.clipboard.writeText(testo + ' ' + link); msg.textContent = 'Link copiato: incollalo nella chat del gruppo.'; } catch (x) { msg.textContent = link; }
    return true;
  }
  if (az === 'grAggiorna') { await grSincronizza(); disegna(); return true; }
  if (az === 'esciGruppo') {
    if (!el.dataset.conferma) { el.dataset.conferma = '1'; el.textContent = 'Conferma: esci'; return true; }
    LS.del('rj.gruppo'); GR = {}; coda = {}; GRV = null; LS.set('rj.gr', GR); LS.set('rj.grCoda', coda); statoGr = { fase: 'fermo', errore: '', ultima: 0 }; disegna(); return true;
  }
  return false;
}

/* ---------- Viste ---------- */
let rotta = { nome: 'viaggio', arg: '' };
let disegnoRimandato = false;
function leggiRotta() {
  const h = decodeURIComponent(location.hash.replace(/^#/, ''));
  const i = h.indexOf('/');
  rotta = i < 0 ? { nome: h || 'viaggio', arg: '' } : { nome: h.slice(0, i), arg: h.slice(i + 1) };
}
function staScrivendo() {
  const a = document.activeElement;
  return a && $('#vista').contains(a) && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT');
}
function disegnaSePossibile() { if (staScrivendo() || $('#dlg').open) { disegnoRimandato = true; return; } disegna(); }

function disegna() {
  disegnoRimandato = false;
  const v = $('#vista');
  if (!CONT) { v.innerHTML = '<div class="pannello vuoto"><h3>Contenuti non ancora scaricati</h3><p class="tenue">Apri l\'app una volta con la rete attiva: poi funziona anche senza.</p></div>'; return; }
  const viste = { viaggio: vistaViaggio, giorno: vistaGiorno, proponi: vistaProponi, gruppo: vistaGruppo, tappe: vistaTappe, tappa: vistaTappa, generali: vistaGenerali, liste: vistaListe, sim: vistaSim, foto: vistaFoto, diario: vistaDiario, impostazioni: vistaImpostazioni };
  aggiornaModoOspite();
  if (!proprietario() && SEZ_PERSONALI.indexOf(rotta.nome) >= 0) rotta = { nome: 'viaggio', arg: '' };
  const f = viste[rotta.nome] || vistaViaggio;
  const r = f(rotta.arg);
  v.innerHTML = r.html;
  $('#titolo').textContent = r.titolo;
  $('#back').hidden = !r.indietro; $('#back').dataset.dove = r.indietro || '';
  const tab = { tappa: 'tappe', generali: 'tappe', sim: 'liste', giorno: 'viaggio', proponi: 'viaggio', gruppo: 'viaggio' }[rotta.nome] || rotta.nome;
  document.querySelectorAll('.tab a').forEach((a) => { const q = a.dataset.tab === tab; a.classList.toggle('qui', q); if (q) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  aggiornaStato();
  if (r.dopo) r.dopo();
}

function prossimaScadenza() {
  // In apertura solo cose ancora davanti: le voci con una data già passata restano nella lista Scadenze.
  const oggi = oggiIso();
  const aperte = voci('scadenze').filter((v) => !v.fatto && (!v.data || v.data >= oggi));
  if (!aperte.length) return null;
  const conData = aperte.filter((v) => v.data).sort((a, b) => a.data.localeCompare(b.data));
  const senza = aperte.filter((v) => !v.data).sort(perOrdine);
  // Una voce datata entro tre giorni passa davanti a quelle senza data, che sono "da fare appena puoi".
  if (conData.length && giorniTra(oggi, conData[0].data) <= 3) return conData[0];
  return senza[0] || conData[0];
}
function vistaViaggio() {
  const oggi = oggiIso(), p = CONT.partenza, r = CONT.rientro;
  let h = '<section class="apertura">';
  if (oggi < p) { const n = giorniTra(oggi, p); h += '<h2 class="titolone">' + (n === 1 ? 'Domani si parte' : 'Tra ' + n + ' giorni si parte') + '</h2>'; }
  else if (oggi <= r) { const g = CONT.giorni.find((x) => x.data === oggi); h += '<h2 class="titolone">Giorno ' + (giorniTra(p, oggi) + 1) + ' di ' + (giorniTra(p, r) + 1) + (g ? ': ' + esc(g.titolo) : '') + '</h2>'; }
  else { h += '<h2 class="titolone">Viaggio concluso</h2>'; }
  h += '<p class="tenue date">Da ' + esc(fmtLungo.format(dataDa(p))) + ' a ' + esc(fmtLungo.format(dataDa(r))) + ' ' + dataDa(r).getFullYear() + '</p>';
  h += '<div class="nastro">' + CONT.tappe.map((t) => '<a href="#tappa/' + esc(t.id) + '" aria-label="' + esc(t.nome) + '">' + arco(t.colore, 40) + '</a>').join('') + '</div>';
  h += '<div class="nastro-leg"><span>' + esc(CONT.tappe[0].nome) + '</span><span>' + esc(CONT.tappe[CONT.tappe.length - 1].nome) + '</span></div>';
  const gOggi = CONT.giorni.find((x) => x.data === oggi), tOggi = gOggi && gOggi.tappe.length ? tappa(gOggi.tappe[0]) : null;
  const m = tOggi && METEO && METEO.per[tOggi.id];
  if (m && m.ora) h += '<a class="oggi-meteo" href="#tappa/' + esc(tOggi.id) + '"' + stileCitta(tOggi) + '><span class="gradi">' + gradi(m.ora.t) + '</span><span><b>' + esc(tOggi.nome) + ', ' + esc(cielo(m.ora.c)) + '</b><br>' + (m.aria && m.aria.aqi != null ? 'Aria ' + esc(aria(m.aria.aqi)) : '') + '</span></a>';
  const ps = oggi <= r && proprietario() ? prossimaScadenza() : null;
  if (ps) h += '<a class="prossima" href="#liste/scadenze">' + ICO.campana + '<div><b>' + esc(ps.titolo) + '</b><span>' + (ps.data ? esc(fmtBreve.format(dataDa(ps.data))) + ', ' + esc(quantoManca(ps.data)) : 'Prossima cosa da fare') + '</span></div></a>';
  h += '</section><h2 class="sez">Temperature del viaggio</h2><div class="pannello pieno">' + graficoViaggio() + '</div><h2 class="sez">Giorno per giorno</h2>';
  if (CONT.calendarioStimato) h += '<p class="tenue" style="margin-bottom:22px">Calendario stimato: fa fede il programma del coordinatore.</p>';
  h += '<ol class="filo">';
  CONT.giorni.forEach((g, i) => {
    const cl = g.data === oggi ? ' class="oggi"' : (g.data < oggi ? ' class="passato"' : '');
    const d = voce('diario', 'g-' + g.data), t0 = g.tappe.length ? tappa(g.tappe[0]) : null;
    h += '<li' + cl + stileCitta(t0) + '><span class="perla">' + (i + 1) + '</span><div class="cosa"><span class="quando">' + esc(fmtLungo.format(dataDa(g.data))) + '</span><h3>' + esc(g.titolo) + '</h3>';
    if (g.nota) h += '<p class="tenue">' + esc(g.nota) + '</p>';
    h += '<div class="azioni">' + g.tappe.map((id) => { const t = tappa(id); return t ? '<a class="chip citta" href="#tappa/' + esc(id) + '"' + stileCitta(t) + '>' + esc(t.nome) + '</a>' : ''; }).join('');
    if (g.tappe.length) { const n = g.tappe.reduce((a, id) => a + percorsiDi(id).filter((p) => aderenti(g.data, p.id).indexOf(io().id) >= 0).length, 0); h += '<a class="chip' + (n ? ' scritto' : '') + '" href="#giorno/' + esc(g.data) + '">' + ICO.bussola + (n ? 'Ci sto' : 'Percorsi') + '</a>'; }
    if (proprietario()) h += '<a class="chip' + (d && d.testo ? ' scritto' : '') + '" href="#diario/' + esc(g.data) + '" aria-label="Diario del ' + esc(fmtBreve.format(dataDa(g.data))) + '">' + ICO.penna + (d && d.testo ? 'Scritto' : 'Diario') + '</a>';
    h += '</div></div>';
    h += '</li>';
  });
  h += '</ol><p class="pie">Tutto Rajasthan è un\'app di viaggio gratuita: itinerario, tappe, meteo, liste e diario, anche senza rete. I tuoi dati restano sul tuo dispositivo o nel tuo spazio personale. <a href="privacy.html">Informativa sulla privacy</a></p>';
  return { titolo: 'Tutto Rajasthan', html: h, dopo() { const o = $('.filo .oggi'); if (o) o.scrollIntoView({ block: 'center' }); } };
}

function vistaTappe() {
  let h = '<a class="generali" href="#generali">' + ICO.bussola + '<div style="flex:1"><h3>Consigli per tutto il viaggio</h3><p class="tenue">Scarpe, templi, cibo di strada, guide non ufficiali</p></div>' + ICO.freccia + '</a><ul class="tappe">';
  CONT.tappe.forEach((t) => {
    const tutti = t.vedere.map((x) => 'v/' + slug(x.t)).concat(t.mangiare.map((x) => 'm/' + slug(x.t)));
    const fatti = tutti.filter((k) => { const s = voce('segni', t.id + '/' + k); return s && s.fatto; }).length;
    h += '<li' + stileCitta(t) + '><a href="#tappa/' + esc(t.id) + '">' + arco(t.colore, 46) + '<div><h3>' + esc(t.nome) + '</h3><p class="tenue">' + esc(t.quando) + (fatti ? ', ' + fatti + ' di ' + tutti.length + ' spuntati' : '') + '</p>' + barraT(t.clima.min, t.clima.max) + '</div>' + ICO.freccia + '</a></li>';
  });
  h += '</ul><p class="pie">' + esc(CONT.avviso) + ' Contenuti aggiornati al ' + esc(fmtBreve.format(dataDa(CONT.aggiornato))) + ' ' + dataDa(CONT.aggiornato).getFullYear() + '.</p>';
  return { titolo: 'Tappe', html: h };
}

const PICCANTE = ['Non piccante', 'Poco piccante', 'Piccante', 'Molto piccante'];
function htmlEtichette(x) {
  if (x.piccante == null && x.veg == null) return '';
  let h = '<span class="etichette">';
  if (x.piccante != null) h += '<span class="et pic p' + x.piccante + '"><i></i><i></i><i></i>' + PICCANTE[x.piccante] + '</span>';
  if (x.veg != null) h += '<span class="et">' + (x.veg ? 'Vegetariano' : 'Con carne') + '</span>';
  return h + '</span>';
}
function htmlFotoVoce(x) {
  if (!x.f || !x.f.url) return '';
  const f = x.f;
  return '<figure class="foto-voce"><img src="' + esc(f.url) + '" alt="' + esc(f.nota || x.t) + '" loading="lazy" decoding="async" crossorigin="anonymous" onerror="this.parentNode.hidden=true">' +
    '<figcaption>' + (f.nota ? esc(f.nota) + '. ' : '') + 'Foto <a href="' + esc(f.pagina) + '" target="_blank" rel="noopener">' + esc(f.autore) + '</a>, ' + esc(f.licenza) + ', Wikimedia Commons</figcaption></figure>';
}
function urlFotoVoci() {
  const u = new Set();
  (CONT ? CONT.tappe : []).forEach((t) => ['vedere', 'mangiare'].forEach((k) => (t[k] || []).forEach((x) => { if (x.f && x.f.url) u.add(x.f.url); })));
  return [...u];
}
async function scaricaFotoVoci(msg) {
  if (!('caches' in window)) { msg.textContent = 'Questo browser non permette di salvare le foto.'; return; }
  if (!navigator.onLine) { msg.textContent = 'Serve la connessione: riprova quando sei online.'; return; }
  const cache = await caches.open('rajasthan-foto'), lista = urlFotoVoci();
  let ok = 0, ko = 0;
  for (const u of lista) {
    if (await cache.match(u)) { ok++; continue; }
    try { const r = await fetch(u, { mode: 'cors' }); if (r.ok) { await cache.put(u, r); ok++; } else ko++; } catch (e) { ko++; }
    msg.textContent = 'Scaricate ' + ok + ' di ' + lista.length + '…';
  }
  msg.textContent = ko ? ok + ' foto salvate, ' + ko + ' non scaricate: riprova più tardi.' : 'Tutte le ' + ok + ' foto sono salvate e si vedranno anche offline.';
}
function htmlSegni(t, lista, k, titolo, etichetta) {
  if (!lista.length) return '';
  let h = '<h2 class="sez">' + arco(t.colore, 18) + titolo + '</h2><div class="pannello"><ul class="segni">';
  lista.forEach((x) => {
    const id = t.id + '/' + k + '/' + slug(x.t); const s = voce('segni', id); const on = !!(s && s.fatto);
    h += '<li><button class="spunta' + (on ? ' on' : '') + '" data-az="segno" data-id="' + esc(id) + '" aria-pressed="' + on + '" aria-label="' + esc(etichetta + ': ' + x.t) + '"></button>';
    const testa = '<h3>' + esc(x.t) + '</h3>' + (x.d ? '<p>' + esc(x.d) + '</p>' : '') + htmlEtichette(x);
    if (x.x && x.x.length) {
      h += '<details class="dett"><summary><div>' + testa + '</div>' + ICO.giu + '</summary>' + htmlFotoVoce(x) + '<dl>' + x.x.map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('') + '</dl>' + (k === 'v' ? htmlVicini(t, x) : '') + '</details>';
    } else h += '<div>' + testa + '</div>';
    h += '</li>';
  });
  return h + '</ul></div>';
}
function htmlMeteo(t) {
  const gg = giorniDi(t.id), m = METEO && METEO.per[t.id], fresco = METEO && Date.now() - METEO.t < 2 * 3600e3;
  let h = '<div class="meteo">';
  if (m && m.ora) {
    h += '<div class="adesso">' + icoCielo(m.ora.c) + '<div><span class="k">' + (fresco ? 'Adesso' : 'Ultimo dato, ' + esc(fmtOra.format(new Date(METEO.t)))) + '</span><b class="grande">' + gradi(m.ora.t) + '</b><span>' + esc(cielo(m.ora.c)) + '</span></div></div>';
    if (m.aria && m.aria.aqi != null) h += '<div class="blocco"><span class="k">Qualità dell\'aria</span><p><b>' + esc(aria(m.aria.aqi)) + '</b>, indice ' + Math.round(m.aria.aqi) + '</p>' + scalaAria(m.aria.aqi) + '</div>';
  }
  h += '<div class="blocco"><span class="k">Di solito in questo periodo</span>' + barraT(t.clima.min, t.clima.max, m && m.ora && fresco ? m.ora.t : null) + '<p class="tenue">' + esc(t.clima.nota) + (m && m.ora && fresco ? ' Il pallino è la temperatura di adesso.' : '') + '</p></div>';
  const prev = m ? gg.filter((g) => m.giorni[g.data] && m.giorni[g.data].max != null) : [];
  if (prev.length) {
    h += '<div class="blocco"><span class="k">Previsioni per i tuoi giorni</span><div class="colonne">' + prev.map((g) => {
      const p = m.giorni[g.data];
      return '<div class="col" role="img" aria-label="' + esc(fmtBreve.format(dataDa(g.data)) + ': ' + cielo(p.c) + ', da ' + Math.round(p.min) + ' a ' + Math.round(p.max) + ' gradi') + '">' + icoCielo(p.c) + '<span class="v">' + gradi(p.max) + '</span><div class="asta"><i style="top:' + (100 - pctT(p.max)) + '%;height:' + Math.max(8, pctT(p.max) - pctT(p.min)) + '%"></i></div><span class="v">' + gradi(p.min) + '</span><span class="d">' + esc(fmtBreve.format(dataDa(g.data))) + '</span><span class="d">' + esc(cielo(p.c)) + '</span></div>';
    }).join('') + '</div></div>';
  } else if (gg.length && giorniTra(oggiIso(), gg[0].data) > 15) {
    h += '<div class="blocco"><span class="k">Previsioni per i tuoi giorni</span><p class="tenue">Disponibili da circa due settimane prima, dal ' + esc(fmtBreve.format(new Date(dataDa(gg[0].data).getTime() - 15 * 864e5))) + '.</p></div>';
  }
  if (gg.length) {
    const a = sole(gg[0].data, t.lat, t.lon, true), s = sole(gg[0].data, t.lat, t.lon, false);
    if (a && s) h += '<div class="blocco soli"><div><span class="k">Alba</span><b class="grande">' + a + '</b></div><div><span class="k">Tramonto</span><b class="grande">' + s + '</b></div><p class="tenue">Ora indiana, ' + esc(fmtBreve.format(dataDa(gg[0].data))) + '</p></div>';
  }
  return h + '</div>';
}
function vistaTappa(id) {
  const t = tappa(id); if (!t) return vistaTappe();
  let h = '<div' + stileCitta(t) + '><section class="fascia">' + (t.foto && t.foto.url ? '<img class="foto" crossorigin="anonymous" src="' + esc(t.foto.url) + '" alt="' + esc(t.foto.soggetto || t.nome) + '">' : '') + arco(suColore(t.colore), 210, 'sfondo') + '<div class="scritta"><h2 class="titolone">' + esc(t.nome) + '</h2><p>' + esc(t.quando) + (CONT.calendarioStimato ? ', data stimata' : '') + '</p></div></section>' + htmlMeteo(t);
  h += htmlSegni(t, t.vedere, 'v', 'Cosa vedere', 'Visto');
  h += htmlSegni(t, t.mangiare, 'm', 'Cosa mangiare', 'Assaggiato');
  h += htmlDoveMangiare(t);
  h += '<h2 class="sez">' + arco(t.colore, 18) + 'Consigli pratici</h2><div class="pannello"><ul class="punti">' + t.consigli.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul></div>';
  const sit = voci('foto').filter((v) => v.tipo === 'situazione' && (v.dove || []).indexOf(t.id) >= 0).sort(perOrdine);
  if (sit.length && proprietario()) h += '<h2 class="sez">' + arco(t.colore, 18) + 'Fotografia qui</h2><div class="pannello rimandi">' + sit.map((v) => '<a href="#foto/s/' + esc(v.id) + '"><div><h3>' + esc(v.titolo) + '</h3><p class="tenue">' + esc(v.sotto || '') + '</p></div>' + ICO.freccia + '</a>').join('') + '</div>';
  const gg = giorniDi(t.id);
  if (gg.length && (t.percorsi || []).length) h += '<div class="azioni larghe">' + gg.map((g) => '<a class="chip" href="#giorno/' + esc(g.data) + '">' + ICO.bussola + 'Percorsi del ' + esc(fmtBreve.format(dataDa(g.data))) + '</a>').join('') + '</div>';
  if (gg.length && proprietario()) h += '<div class="azioni larghe">' + gg.map((g) => '<a class="chip" href="#diario/' + esc(g.data) + '">' + ICO.penna + 'Diario del ' + esc(fmtBreve.format(dataDa(g.data))) + '</a>').join('') + '</div>';
  let pie = METEO ? 'Meteo di Open-Meteo, aggiornato il ' + esc(fmtOra.format(new Date(METEO.t))) + '. ' : '';
  if (t.foto && t.foto.url) pie += 'Foto: ' + esc(t.foto.soggetto || '') + ', di ' + esc(t.foto.autore) + ', <a href="' + esc(t.foto.pagina) + '" target="_blank" rel="noopener">' + esc(t.foto.licenza) + ', Wikimedia Commons</a>.';
  if (pie) h += '<p class="pie">' + pie + '</p>';
  h += '</div>';
  return {
    titolo: t.nome, html: h, indietro: '#tappe', dopo() {
      const img = $('.fascia .foto'); if (!img) return;
      const ok = () => img.closest('.fascia').classList.add('con-foto');
      const ko = () => img.remove();
      if (img.complete) { if (img.naturalWidth) ok(); else ko(); }
      else { img.addEventListener('load', ok); img.addEventListener('error', ko); }
    }
  };
}
function vistaGenerali() {
  const h = '<div class="pannello"><ul class="voci-testo">' + CONT.generali.map((g) => '<li><h3>' + esc(g.t) + '</h3><p>' + esc(g.d) + '</p></li>').join('') + '</ul></div>';
  return { titolo: 'Consigli generali', html: h, indietro: '#tappe' };
}

function vistaListe(arg) {
  const sez = LISTE[arg] ? arg : (LISTE[LS.get('rj.lista', '')] ? LS.get('rj.lista') : 'scadenze');
  LS.set('rj.lista', sez);
  const cfg = LISTE[sez];
  let h = barraListe(sez);
  const tutte = voci(sez);
  if (!tutte.length) {
    h += '<div class="pannello vuoto">' + arco('currentColor', 44) + '<h3>Ancora nessuna voce</h3><p class="tenue">' + (modoSync() ? 'Aggiungine una qui sotto, o attendi la sincronizzazione.' : 'Aggiungi le tue: restano su questo dispositivo.') + '</p></div>';
  } else {
    if (cfg.spunta) { const f = tutte.filter((v) => v.fatto).length; h += '<p class="progresso"><span style="--p:' + Math.round(100 * f / tutte.length) + '%"></span>' + f + ' di ' + tutte.length + ' ' + esc(cfg.spunta) + '</p>'; }
    const gruppi = {};
    tutte.forEach((v) => { const g = v.gruppo || 'Altro'; (gruppi[g] = gruppi[g] || []).push(v); });
    const ordG = Object.keys(gruppi).sort((a, b) => Math.min.apply(null, gruppi[a].map((v) => v.ord || 9999)) - Math.min.apply(null, gruppi[b].map((v) => v.ord || 9999)) || a.localeCompare(b));
    ordG.forEach((g) => {
      h += '<section class="pannello"><h2>' + esc(g) + '</h2><ul class="lista">';
      gruppi[g].sort(perOrdine).forEach((v) => {
        h += '<li class="' + (v.fatto ? 'fatto' : '') + '">';
        if (cfg.spunta) h += '<button class="spunta' + (v.fatto ? ' on' : '') + '" data-az="fatto" data-sez="' + sez + '" data-id="' + esc(v.id) + '" aria-pressed="' + !!v.fatto + '" aria-label="' + esc(cfg.spunta + ': ' + v.titolo) + '"></button>';
        h += '<div class="corpo" data-az="modifica" data-sez="' + sez + '" data-id="' + esc(v.id) + '"><h3>' + esc(v.titolo) + '</h3>';
        if (v.testo) h += '<p>' + testoAParagrafi(v.testo) + '</p>';
        if (v.data) { const gg = giorniTra(oggiIso(), v.data); h += '<div class="meta"><span class="quando-voce' + (gg < 0 && !v.fatto ? ' scaduta' : '') + '">' + esc(fmtBreve.format(dataDa(v.data))) + (v.fatto ? '' : ', ' + esc(quantoManca(v.data))) + '</span></div>'; }
        h += '</div>';
        if (cfg.stati) h += '<button class="stato-voce s-' + slug(v.stato || cfg.stati[0]) + '" data-az="stato" data-sez="' + sez + '" data-id="' + esc(v.id) + '" aria-label="Stato: ' + esc(v.stato || cfg.stati[0]) + '. Tocca per cambiare">' + esc(v.stato || cfg.stati[0]) + '</button>';
        h += '</li>';
      });
      h += '</ul></section>';
    });
  }
  h += '<button class="piu" data-az="nuova" data-sez="' + sez + '">' + ICO.piu + 'Aggiungi una voce</button>';
  return { titolo: 'Liste', html: h };
}
function barraListe(qui) {
  return '<div class="sotto">' + Object.keys(LISTE).map((k) => '<a href="#liste/' + k + '"' + (k === qui ? ' class="qui" aria-current="true"' : '') + '>' + esc(LISTE[k].nome) + '</a>').join('') +
    '<a href="#sim"' + (qui === 'sim' ? ' class="qui" aria-current="true"' : '') + '>Simulatore</a></div>';
}

/* ---------- Simulatore del bagaglio ----------
   Sezione "simulatore", voci di tre tipi:
   - contenitore: titolo, peso (g, a vuoto), volume (L), comp (% di compressione del contenuto), stima,
     rigido (dentro un altro contenitore occupa sempre tutto il suo volume, non solo quello del contenuto)
   - oggetto: titolo, gruppo, peso (g, per pezzo), volume (L, per pezzo), qta, stima, soloCabina, liquidi
   - scenario: titolo, limCabina, limPersonale e limStiva (g; 0 = nessun limite),
     cont { idContenitore: 'cabina' (bagaglio a mano) | 'personale' (oggetto personale) | 'stiva' | 'dentro:<id>' },
     pos { idOggetto: idContenitore | 'addosso' } (un oggetto senza posizione resta a casa). */
function simDi(tipo) { return voci('simulatore').filter((v) => v.tipo === tipo).sort(perOrdine); }
function num(x) { const n = Number(x); return isFinite(n) && n > 0 ? n : 0; }
function qtaDi(o) { return Math.max(1, Math.round(num(o.qta)) || 1); }
function fmtPeso(g) { return g >= 1000 ? (g / 1000).toLocaleString('it-IT', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + ' kg' : Math.round(g) + ' g'; }
function fmtVol(l) { return l.toLocaleString('it-IT', { maximumFractionDigits: 1 }) + ' L'; }
const NOME_RUOLO = { cabina: 'bagaglio a mano', personale: 'oggetto personale', stiva: 'in stiva' };
const RUOLI = [['cabina', 'Bagaglio a mano', 'limCabina'], ['personale', 'Oggetto personale', 'limPersonale'], ['stiva', 'Stiva', 'limStiva']];
function opzRuoli(sel) { return RUOLI.map((r) => '<option value="' + r[0] + '"' + (sel === r[0] ? ' selected' : '') + '>' + r[1] + '</option>').join(''); }

function calcolaSim(s) {
  const ruoli = s.cont || {}, pos = s.pos || {}, C = {};
  simDi('contenitore').forEach((c) => { if (ruoli[c.id]) C[c.id] = { c, ruolo: ruoli[c.id], ogg: [], figli: [], pesoOgg: 0, volOgg: 0 }; });
  const addosso = { ogg: [], peso: 0 }, casa = { ogg: [], peso: 0 }, avvisi = [];
  simDi('oggetto').forEach((o) => {
    const d = pos[o.id], p = num(o.peso) * qtaDi(o), l = num(o.volume) * qtaDi(o);
    if (d === 'addosso') { addosso.ogg.push(o); addosso.peso += p; }
    else if (C[d]) { C[d].ogg.push(o); C[d].pesoOgg += p; C[d].volOgg += l; }
    else { casa.ogg.push(o); casa.peso += p; }
  });
  // Contenitori uno dentro l'altro: si risale fino al bagaglio vero (cabina o stiva).
  const radice = (x) => { let y = x; for (let i = 0; i < 8; i++) { const m = /^dentro:(.+)$/.exec(y.ruolo); if (!m) return NOME_RUOLO[y.ruolo] ? y : null; y = C[m[1]]; if (!y) return null; } return null; };
  Object.values(C).forEach((x) => {
    x.radice = radice(x);
    const m = /^dentro:(.+)$/.exec(x.ruolo);
    if (m && x.radice && C[m[1]]) C[m[1]].figli.push(x);
    if (!x.radice) avvisi.push('«' + x.c.titolo + '» è dentro un contenitore che non è nel bagaglio: non viene contato.');
  });
  const tot = (x) => {
    if (x.tot) return x.tot;
    let peso = num(x.c.peso) + x.pesoOgg, interno = x.volOgg * (1 - Math.min(90, num(x.c.comp)) / 100);
    x.figli.forEach((f) => { const t = tot(f); peso += t.peso; interno += t.occ; });
    x.tot = { peso, interno, occ: x.c.rigido ? Math.max(num(x.c.volume), interno) : interno };
    return x.tot;
  };
  const somme = { cabina: 0, personale: 0, stiva: 0 };
  const radici = Object.values(C).filter((x) => x.radice === x);
  radici.forEach((x) => { somme[x.ruolo] += tot(x).peso; });
  Object.values(C).forEach((x) => {
    if (!x.radice) return;
    const t = tot(x);
    if (num(x.c.volume) && t.interno > num(x.c.volume)) avvisi.push('«' + x.c.titolo + '» è troppo pieno: ' + fmtVol(t.interno) + ' in ' + fmtVol(num(x.c.volume)) + '.');
    x.ogg.forEach((o) => {
      if (o.soloCabina && x.radice.ruolo === 'stiva') avvisi.push('«' + o.titolo + '» non può andare in stiva (batterie al litio): spostalo nel bagaglio a mano, nell\'oggetto personale o addosso.');
      if (o.liquidi && x.radice.ruolo !== 'stiva') avvisi.push('«' + o.titolo + '» è in cabina: liquidi solo in flaconi da 100 ml, in una busta trasparente da 1 litro.');
    });
  });
  RUOLI.slice().reverse().forEach((r) => {
    const lim = num(s[r[2]]), n = radici.filter((x) => x.ruolo === r[0]).length;
    if (n > 1 && r[0] !== 'stiva') avvisi.unshift('Ci sono ' + n + ' contenitori come «' + r[1].toLowerCase() + '»: di solito ne è ammesso uno solo.');
    if (lim && somme[r[0]] > lim) avvisi.unshift(r[1] + ' oltre il limite di ' + fmtPeso(lim) + ' (' + fmtPeso(somme[r[0]]) + ').');
  });
  return { C, radici, addosso, casa, somme, avvisi, tot };
}

function barraSim(etichetta, val, lim, fmt) {
  const p = lim ? Math.min(100, val / lim * 100) : 0, oltre = lim && val > lim;
  return '<div class="sim-barra' + (oltre ? ' oltre' : '') + '"><div class="sim-et"><span>' + esc(etichetta) + '</span><b>' + esc(fmt(val)) + (lim ? ' di ' + esc(fmt(lim)) : '') + '</b></div>' +
    (lim ? '<span class="sim-trac"><i style="width:' + p.toFixed(1) + '%"></i></span>' : '') + '</div>';
}
// Una barra per ruolo, solo se il ruolo è usato nello scenario o ha un limite.
function barreRuoli(s, R) {
  return RUOLI.filter((r) => R.radici.some((x) => x.ruolo === r[0]) || num(s[r[2]])).map((r) => barraSim(r[1], R.somme[r[0]], num(s[r[2]]), fmtPeso)).join('');
}
function rigaOggetto(s, o, dest) {
  const q = qtaDi(o), p = num(o.peso) * q, l = num(o.volume) * q;
  let opz = '<option value="casa"' + (dest === 'casa' ? ' selected' : '') + '>A casa</option><option value="addosso"' + (dest === 'addosso' ? ' selected' : '') + '>Addosso</option>';
  simDi('contenitore').forEach((c) => { if ((s.cont || {})[c.id]) opz += '<option value="' + esc(c.id) + '"' + (dest === c.id ? ' selected' : '') + '>' + esc(c.titolo) + '</option>'; });
  return '<li><div class="corpo" data-az="simMod" data-tipo="oggetto" data-id="' + esc(o.id) + '"><h3>' + esc(o.titolo) + (q > 1 ? ' <span class="tenue">×' + q + '</span>' : '') + '</h3>' +
    '<p>' + fmtPeso(p) + ' · ' + fmtVol(l) + (o.stima ? ' <span class="stima">stima</span>' : '') + '</p></div>' +
    '<select class="sim-dove" data-simpos="' + esc(s.id) + '|' + esc(o.id) + '" aria-label="Dove va: ' + esc(o.titolo) + '">' + opz + '</select></li>';
}
function htmlContenitore(s, R, x) {
  const t = R.tot(x), cap = num(x.c.volume);
  const altri = simDi('contenitore').filter((c) => c.id !== x.c.id && (s.cont || {})[c.id]);
  let opz = '<option value="fuori">Togli dallo scenario</option>' + opzRuoli(x.ruolo);
  altri.forEach((c) => { opz += '<option value="dentro:' + esc(c.id) + '"' + (x.ruolo === 'dentro:' + c.id ? ' selected' : '') + '>Dentro: ' + esc(c.titolo) + '</option>'; });
  let h = '<section class="pannello sim-cont' + (x.radice === x ? '' : ' interno') + '"><div class="sim-testa"><h2 data-az="simMod" data-tipo="contenitore" data-id="' + esc(x.c.id) + '">' + esc(x.c.titolo) + (x.c.stima ? ' <span class="stima">stima</span>' : '') + '</h2>' +
    '<select class="sim-dove" data-simruolo="' + esc(s.id) + '|' + esc(x.c.id) + '" aria-label="Dove sta: ' + esc(x.c.titolo) + '">' + opz + '</select></div>';
  h += barraSim('Peso' + (num(x.c.peso) ? ' (vuoto ' + fmtPeso(num(x.c.peso)) + ')' : ''), t.peso, 0, fmtPeso);
  h += barraSim('Volume' + (num(x.c.comp) ? ' (compressione ' + num(x.c.comp) + '%)' : ''), t.interno, cap, fmtVol);
  if (x.ogg.length) h += '<ul class="lista">' + x.ogg.map((o) => rigaOggetto(s, o, x.c.id)).join('') + '</ul>';
  else if (!x.figli.length) h += '<p class="tenue sim-vuoto">Vuoto: sposta qui gli oggetti con il menu accanto a ciascuno.</p>';
  x.figli.forEach((f) => { h += htmlContenitore(s, R, f); });
  return h + '</section>';
}

function vistaSim(arg) {
  if (arg === 'catalogo') return vistaSimCatalogo();
  const s = arg ? voce('simulatore', arg) : null;
  if (s && s.tipo === 'scenario') return vistaScenario(s);
  let h = barraListe('sim');
  h += '<p class="tenue sim-intro">Prova combinazioni di zaini e contenuto: pesi e volumi si sommano da soli. Gli oggetti e i contenitori sono gli stessi per tutti gli scenari.</p>';
  const sc = simDi('scenario');
  if (!sc.length) h += '<div class="pannello vuoto">' + arco('currentColor', 44) + '<h3>Ancora nessuno scenario</h3><p class="tenue">Creane uno qui sotto' + (modoSync() ? ', o attendi la sincronizzazione.' : '.') + '</p></div>';
  sc.forEach((s) => {
    const R = calcolaSim(s);
    const nomi = R.radici.map((x) => x.c.titolo + ' ' + NOME_RUOLO[x.ruolo]).join(' + ') || 'Nessun bagaglio';
    h += '<a class="pannello pieno sim-scen" href="#sim/' + esc(s.id) + '"><h3>' + esc(s.titolo) + '</h3><p class="tenue">' + esc(nomi) + '</p>' +
      barreRuoli(s, R) +
      (R.avvisi.length ? '<p class="err">' + R.avvisi.length + (R.avvisi.length === 1 ? ' avviso' : ' avvisi') + '</p>' : '') + '</a>';
  });
  h += '<div class="azioni larghe"><button class="btn" data-az="simNuovo" data-tipo="scenario">Nuovo scenario</button><a class="btn chiaro" href="#sim/catalogo">Oggetti e contenitori</a></div>';
  return { titolo: 'Simulatore', html: h };
}

function vistaScenario(s) {
  const R = calcolaSim(s);
  let h = barraListe('sim');
  h += '<section class="pannello pieno"><div class="sim-testa"><h2 class="sim-tit" data-az="simMod" data-tipo="scenario" data-id="' + esc(s.id) + '">' + esc(s.titolo) + '</h2><button class="btn chiaro piccolo" data-az="simDuplica" data-id="' + esc(s.id) + '">Duplica</button></div>';
  h += barreRuoli(s, R) + barraSim('Addosso (non pesato)', R.addosso.peso, 0, fmtPeso);
  if (R.avvisi.length) h += '<ul class="sim-avvisi">' + R.avvisi.map((a) => '<li>' + esc(a) + '</li>').join('') + '</ul>';
  if (s.testo) h += '<p class="tenue">' + testoAParagrafi(s.testo) + '</p>';
  h += '<p class="tenue sim-nota">Tocca il nome dello scenario per cambiare nome e limiti, il nome di un contenitore o di un oggetto per i suoi pesi.</p></section>';
  RUOLI.forEach((r) => R.radici.filter((x) => x.ruolo === r[0]).forEach((x) => { h += htmlContenitore(s, R, x); }));
  h += '<section class="pannello"><h2>Addosso</h2>' + (R.addosso.ogg.length ? '<ul class="lista">' + R.addosso.ogg.map((o) => rigaOggetto(s, o, 'addosso')).join('') + '</ul>' : '<p class="tenue sim-vuoto">Niente: quello che indossi in viaggio va qui e non pesa sul bagaglio.</p>') + '</section>';
  h += '<details class="pannello sim-casa"' + (R.casa.ogg.length && R.casa.ogg.length < 6 ? ' open' : '') + '><summary><h2>A casa <span class="tenue">(' + R.casa.ogg.length + ')</span></h2></summary>' +
    (R.casa.ogg.length ? '<ul class="lista">' + R.casa.ogg.map((o) => rigaOggetto(s, o, 'casa')).join('') + '</ul>' : '<p class="tenue sim-vuoto">Tutti gli oggetti sono nel bagaglio o addosso.</p>') + '</details>';
  const fuori = simDi('contenitore').filter((c) => !(s.cont || {})[c.id]);
  if (fuori.length) {
    h += '<section class="pannello"><h2>Altri contenitori</h2><ul class="lista">' + fuori.map((c) => '<li><div class="corpo" data-az="simMod" data-tipo="contenitore" data-id="' + esc(c.id) + '"><h3>' + esc(c.titolo) + '</h3><p>' + fmtPeso(num(c.peso)) + ' · ' + fmtVol(num(c.volume)) + '</p></div>' +
      '<select class="sim-dove" data-simruolo="' + esc(s.id) + '|' + esc(c.id) + '" aria-label="Aggiungi: ' + esc(c.titolo) + '"><option value="fuori" selected>Non usato</option>' + opzRuoli('') +
      simDi('contenitore').filter((d) => d.id !== c.id && (s.cont || {})[d.id]).map((d) => '<option value="dentro:' + esc(d.id) + '">Dentro: ' + esc(d.titolo) + '</option>').join('') + '</select></li>').join('') + '</ul></section>';
  }
  h += '<div class="azioni larghe"><button class="btn chiaro" data-az="simNuovo" data-tipo="oggetto">Nuovo oggetto</button><button class="btn chiaro" data-az="simNuovo" data-tipo="contenitore">Nuovo contenitore</button></div>';
  return { titolo: 'Simulatore', html: h, indietro: '#sim' };
}

function vistaSimCatalogo() {
  let h = barraListe('sim');
  const cont = simDi('contenitore');
  h += '<section class="pannello"><h2>Contenitori</h2>' + (cont.length ? '<ul class="lista">' + cont.map((c) => '<li><div class="corpo" data-az="simMod" data-tipo="contenitore" data-id="' + esc(c.id) + '"><h3>' + esc(c.titolo) + '</h3><p>' + fmtPeso(num(c.peso)) + ' a vuoto · ' + fmtVol(num(c.volume)) + (num(c.comp) ? ' · compressione ' + num(c.comp) + '%' : '') + (c.rigido ? ' · rigido' : '') + (c.stima ? ' <span class="stima">stima</span>' : '') + '</p></div></li>').join('') + '</ul>' : '<p class="tenue sim-vuoto">Nessuno.</p>') + '</section>';
  const gruppi = {};
  simDi('oggetto').forEach((o) => { (gruppi[o.gruppo || 'Altro'] = gruppi[o.gruppo || 'Altro'] || []).push(o); });
  Object.keys(gruppi).forEach((g) => {
    h += '<section class="pannello"><h2>' + esc(g) + '</h2><ul class="lista">' + gruppi[g].map((o) => '<li><div class="corpo" data-az="simMod" data-tipo="oggetto" data-id="' + esc(o.id) + '"><h3>' + esc(o.titolo) + (qtaDi(o) > 1 ? ' <span class="tenue">×' + qtaDi(o) + '</span>' : '') + '</h3><p>' + fmtPeso(num(o.peso)) + ' · ' + fmtVol(num(o.volume)) + (qtaDi(o) > 1 ? ' a pezzo' : '') + (o.stima ? ' <span class="stima">stima</span>' : '') + (o.soloCabina ? ' · solo cabina' : '') + (o.liquidi ? ' · liquidi' : '') + '</p></div></li>').join('') + '</ul></section>';
  });
  h += '<div class="azioni larghe"><button class="btn" data-az="simNuovo" data-tipo="oggetto">Nuovo oggetto</button><button class="btn chiaro" data-az="simNuovo" data-tipo="contenitore">Nuovo contenitore</button></div>';
  return { titolo: 'Oggetti e contenitori', html: h, indietro: '#sim' };
}

function apriSim(tipo, id) {
  const v = id ? voce('simulatore', id) : null;
  const casella = (n, t, on) => '<label class="sim-check"><input type="checkbox" name="' + n + '"' + (on ? ' checked' : '') + '> ' + esc(t) + '</label>';
  const numero = (n, t, val, passo) => '<label>' + esc(t) + '<input type="number" inputmode="decimal" min="0" step="' + (passo || 1) + '" name="' + n + '" value="' + (val === '' || val == null ? '' : esc(val)) + '"></label>';
  const nomi = { oggetto: 'oggetto', contenitore: 'contenitore', scenario: 'scenario' };
  let h = '<h2>' + (v ? 'Modifica ' : 'Nuovo ') + nomi[tipo] + '</h2><label>Nome<input name="titolo" required value="' + esc(v ? v.titolo : '') + '"></label>';
  if (tipo === 'oggetto') {
    const gruppi = Array.from(new Set(simDi('oggetto').map((x) => x.gruppo).filter(Boolean)));
    h += '<label>Gruppo<input name="gruppo" list="simGruppi" value="' + esc(v ? v.gruppo || '' : '') + '"><datalist id="simGruppi">' + gruppi.map((g) => '<option value="' + esc(g) + '">').join('') + '</datalist></label>' +
      '<div class="sim-tre">' + numero('peso', 'Peso (g, a pezzo)', v ? v.peso : '') + numero('volume', 'Volume (L, a pezzo)', v ? v.volume : '', 0.1) + numero('qta', 'Quanti', v ? qtaDi(v) : 1) + '</div>' +
      casella('stima', 'Peso o volume stimati: da misurare', v ? v.stima : true) + casella('soloCabina', 'Solo in cabina (batterie al litio)', v && v.soloCabina) + casella('liquidi', 'Contiene liquidi', v && v.liquidi);
  } else if (tipo === 'contenitore') {
    h += '<div class="sim-tre">' + numero('peso', 'Peso a vuoto (g)', v ? v.peso : '') + numero('volume', 'Capienza (L)', v ? v.volume : '', 0.5) + numero('comp', 'Compressione (%)', v ? v.comp || 0 : 0) + '</div>' +
      '<p class="tenue">La compressione riduce lo spazio occupato dal contenuto: 0 per zaini e cubi normali, 20–40 per le sacche di compressione.</p>' + casella('rigido', 'Rigido: dentro un altro contenitore occupa sempre tutta la sua capienza', v && v.rigido) + casella('stima', 'Peso o capienza stimati: da misurare', v ? v.stima : true);
  } else {
    const kg = (k, d) => (v ? (v[k] ? v[k] / 1000 : '') : d);
    h += '<div class="sim-tre">' + numero('limCabina', 'Bagaglio a mano (kg)', kg('limCabina', 8), 0.5) + numero('limPersonale', 'Oggetto personale (kg)', kg('limPersonale', ''), 0.5) + numero('limStiva', 'Stiva (kg)', kg('limStiva', 23), 0.5) + '</div>' +
      '<p class="tenue">Limiti da verificare quando si conosce la compagnia aerea. Lascia vuoto per nessun limite.</p>';
  }
  h += '<label>Note<textarea name="testo" rows="2">' + esc(v ? v.testo || '' : '') + '</textarea></label>';
  h += '<div class="azioni larghe"><button class="btn" value="salva">Salva</button><button class="btn chiaro" value="annulla" formnovalidate>Annulla</button>' + (v ? '<button class="btn pericolo" type="button" id="btnElimina">Elimina</button>' : '') + '</div>';
  const f = $('#dlgForm'); f.innerHTML = h; f.dataset.sez = 'simulatore'; f.dataset.id = id || ''; f.dataset.sim = tipo;
  const be = $('#btnElimina');
  if (be) be.addEventListener('click', () => {
    if (be.dataset.conferma) { elimina('simulatore', id); if (tipo === 'scenario') { history.replaceState(null, '', '#sim'); leggiRotta(); } $('#dlg').close('eliminata'); }
    else { be.dataset.conferma = '1'; be.textContent = 'Conferma: elimina'; }
  });
  $('#dlg').returnValue = '';
  $('#dlg').showModal();
}
function salvaSim(f) {
  const fd = new FormData(f), tipo = f.dataset.sim, nuovo = !f.dataset.id, id = f.dataset.id || nuovoId();
  const n = (k) => { const x = String(fd.get(k) || '').replace(',', '.'); return x === '' ? 0 : Math.max(0, Number(x) || 0); };
  const campi = { tipo, titolo: String(fd.get('titolo') || '').trim(), testo: String(fd.get('testo') || '').trim() };
  if (!campi.titolo) return;
  if (tipo === 'oggetto') Object.assign(campi, { gruppo: String(fd.get('gruppo') || '').trim(), peso: n('peso'), volume: n('volume'), qta: Math.max(1, Math.round(n('qta')) || 1), stima: fd.has('stima'), soloCabina: fd.has('soloCabina'), liquidi: fd.has('liquidi') });
  else if (tipo === 'contenitore') Object.assign(campi, { peso: n('peso'), volume: n('volume'), comp: Math.min(90, n('comp')), rigido: fd.has('rigido'), stima: fd.has('stima') });
  else Object.assign(campi, { limCabina: Math.round(n('limCabina') * 1000), limPersonale: Math.round(n('limPersonale') * 1000), limStiva: Math.round(n('limStiva') * 1000) });
  if (nuovo) { campi.ord = 5000 + simDi(tipo).length; if (tipo === 'scenario') Object.assign(campi, { cont: {}, pos: {} }); }
  scrivi('simulatore', id, campi);
  if (nuovo && tipo === 'scenario') { history.replaceState(null, '', '#sim/' + id); leggiRotta(); }
}

/* ---------- Fotografia ---------- */
function fotoDi(tipo) { return voci('foto').filter((v) => v.tipo === tipo).sort(perOrdine); }
function ricettaPerChiave(k) { return voci('foto').find((v) => v.tipo === 'ricetta' && v.chiave === k); }
function htmlNote(v) {
  return '<h2 class="sez">Le mie note</h2><textarea data-campo="foto|' + esc(v.id) + '" rows="3" placeholder="Cosa ha funzionato, cosa cambierei">' + esc(v.testo || '') + '</textarea>';
}
function vistaFoto(arg) {
  const tutte = voci('foto');
  if (!tutte.length) return { titolo: 'Fotografia', html: '<div class="pannello vuoto">' + arco('currentColor', 44) + '<h3>Sezione personale</h3><p class="tenue">Qui compaiono le schede di fotografia quando la sincronizzazione è attiva.</p></div>' };
  if (arg.indexOf('s/') === 0) {
    const v = voce('foto', arg.slice(2)); if (!v || v.tipo !== 'situazione') return vistaFoto('situazioni');
    const r = v.ricetta && ricettaPerChiave(v.ricetta);
    let h = '<h2 class="titolone">' + esc(v.titolo) + '</h2><p class="tenue">' + esc(v.sotto || '') + '</p><p class="intro-foto">' + esc(v.perche || '') + '</p>';
    h += '<h2 class="sez">Impostazioni</h2><div class="pannello"><ul class="imp">' + (v.imp || []).map((x) => '<li><span class="k">' + esc(x[0]) + '</span><span class="v">' + esc(x[1]) + '</span><span class="w">' + esc(x[2]) + '</span></li>').join('') + '</ul></div>';
    if (r) h += '<div class="pannello rimandi"><a href="#foto/r/' + esc(r.id) + '"><div><span class="k piccolo">Ricetta consigliata</span><h3><span class="slot">' + esc(r.slot) + '</span>' + esc(r.titolo) + '</h3></div>' + ICO.freccia + '</a></div>';
    h += '<h2 class="sez">Sul posto</h2><div class="pannello"><ol class="passi">' + (v.passi || []).map((x) => '<li><div><p>' + esc(x[0]) + '</p><p class="w">' + esc(x[1]) + '</p></div></li>').join('') + '</ol></div>';
    if ((v.errori || []).length) h += '<h2 class="sez">Errori tipici</h2><div class="pannello"><ul class="errori">' + v.errori.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul></div>';
    const dove = (v.dove || []).map(tappa).filter(Boolean);
    if (dove.length) h += '<h2 class="sez">Dove</h2><div class="azioni">' + dove.map((t) => '<a class="chip citta" href="#tappa/' + esc(t.id) + '"' + stileCitta(t) + '>' + esc(t.nome) + '</a>').join('') + '</div>';
    h += htmlNote(v);
    return { titolo: 'Situazione', html: h, indietro: '#foto/situazioni' };
  }
  if (arg.indexOf('r/') === 0) {
    const v = voce('foto', arg.slice(2)); if (!v || v.tipo !== 'ricetta') return vistaFoto('ricette');
    let h = '<h2 class="titolone"><span class="slot">' + esc(v.slot) + '</span>' + esc(v.titolo) + '</h2><p class="tenue">Simulazione ' + esc(v.sim) + '</p><p class="intro-foto">' + esc(v.quando || '') + '</p>';
    h += '<div class="pannello"><ul class="voci-testo"><li><h3>Quando rende</h3><p>' + esc(v.generale || '') + '</p></li><li><h3>Attenzione</h3><p>' + esc(v.nota || '') + '</p></li></ul></div>';
    h += '<h2 class="sez">Impostazioni</h2><div class="pannello"><dl class="coppie"><dt>Simulazione</dt><dd>' + esc(v.sim) + '</dd>' + Object.keys(v.s || {}).map((k) => '<dt>' + esc(k) + '</dt><dd>' + esc(v.s[k]) + '</dd>').join('') + '</dl></div>';
    const usi = fotoDi('situazione').filter((s) => s.ricetta === v.chiave);
    if (usi.length) h += '<h2 class="sez">Situazioni</h2><div class="pannello rimandi">' + usi.map((s) => '<a href="#foto/s/' + esc(s.id) + '"><h3>' + esc(s.titolo) + '</h3>' + ICO.freccia + '</a>').join('') + '</div>';
    h += htmlNote(v);
    if (v.url) h += '<p class="pie">Ricetta di Fuji X Weekly: <a href="' + esc(v.url) + '" target="_blank" rel="noopener">pagina originale</a>.</p>';
    return { titolo: 'Ricetta', html: h, indietro: '#foto/ricette' };
  }
  const sez = FOTO[arg] ? arg : (FOTO[LS.get('rj.foto', '')] ? LS.get('rj.foto') : 'situazioni');
  LS.set('rj.foto', sez);
  let h = '<div class="sotto">' + Object.keys(FOTO).map((k) => '<a href="#foto/' + k + '"' + (k === sez ? ' class="qui" aria-current="true"' : '') + '>' + esc(FOTO[k]) + '</a>').join('') + '</div>';
  if (sez === 'situazioni') {
    h += '<div class="pannello"><ul class="schede-foto">' + fotoDi('situazione').map((v) => { const r = v.ricetta && ricettaPerChiave(v.ricetta); return '<li><a href="#foto/s/' + esc(v.id) + '"><h3>' + esc(v.titolo) + '</h3><p>' + esc(v.sotto || '') + (r ? '<br><span class="slot" style="margin-top:6px">' + esc(r.slot) + '</span>' + esc(r.titolo) : '') + '</p>' + ICO.freccia + '</a></li>'; }).join('') + '</ul></div>';
  } else if (sez === 'ricette') {
    h += '<p class="tenue" style="margin-bottom:12px">Le sette ricette salvate in fotocamera, con l\'uso consigliato per questo viaggio.</p><div class="pannello"><ul class="schede-foto">' + fotoDi('ricetta').map((v) => '<li><a href="#foto/r/' + esc(v.id) + '"><h3><span class="slot">' + esc(v.slot) + '</span>' + esc(v.titolo) + '</h3><p>' + esc(v.quando || '') + '</p>' + ICO.freccia + '</a></li>').join('') + '</ul></div>';
  } else if (sez === 'fotocamera') {
    const base = fotoDi('base'), f = base.filter((v) => v.fatto).length, gruppi = [];
    base.forEach((v) => { let g = gruppi.find((x) => x.n === v.gruppo); if (!g) gruppi.push(g = { n: v.gruppo, v: [] }); g.v.push(v); });
    h += '<p class="progresso"><span style="--p:' + (base.length ? Math.round(100 * f / base.length) : 0) + '%"></span>' + f + ' di ' + base.length + ' controllate</p>';
    gruppi.forEach((g) => {
      h += '<section class="pannello"><h2>' + esc(g.n) + '</h2><ul class="imp base">' + g.v.map((v) => '<li class="' + (v.fatto ? 'fatto' : '') + '"><button class="spunta' + (v.fatto ? ' on' : '') + '" data-az="fatto" data-sez="foto" data-id="' + esc(v.id) + '" aria-pressed="' + !!v.fatto + '" aria-label="Controllata: ' + esc(v.titolo) + '"></button><span class="k">' + esc(v.titolo) + '</span><span class="v">' + esc(v.valore || '') + '</span><span class="w">' + esc(v.perche || '') + '</span>' + (v.percorso ? '<span class="percorso">' + esc(v.percorso) + '</span>' : '') + '</li>').join('') + '</ul></section>';
    });
  } else {
    [['trucco', 'Trucchi'], ['regola', 'Regole nei luoghi']].forEach((x) => {
      const l = fotoDi(x[0]); if (!l.length) return;
      h += '<h2 class="sez">' + x[1] + '</h2><div class="pannello"><ul class="voci-testo">' + l.map((v) => '<li><h3>' + esc(v.titolo) + '</h3><p>' + esc(v.testo_fisso || v.testo || '') + '</p></li>').join('') + '</ul></div>';
    });
  }
  return { titolo: 'Fotografia', html: h };
}

function vistaDiario(arg) {
  const oggi = oggiIso();
  let h = '<p class="tenue" style="margin-bottom:12px">Si salva da solo mentre scrivi.</p>';
  const note = voce('diario', 'note');
  h += '<section class="pannello pieno giorno-d"><h2>Note generali</h2><textarea data-campo="diario|note" rows="3" placeholder="Appunti che non appartengono a un giorno preciso">' + esc(note ? note.testo : '') + '</textarea></section>';
  CONT.giorni.forEach((g, i) => {
    const v = voce('diario', 'g-' + g.data), t0 = g.tappe.length ? tappa(g.tappe[0]) : null;
    h += '<section class="pannello pieno giorno-d' + (g.data === oggi ? ' oggi' : '') + '" id="d-' + g.data + '"' + stileCitta(t0) + '><h2><span class="perla">' + (i + 1) + '</span>' + esc(fmtLungo.format(dataDa(g.data))) + '</h2><p class="tenue">' + esc(g.titolo) + '</p><textarea data-campo="diario|g-' + g.data + '" rows="' + (v && v.testo ? 5 : 2) + '" placeholder="Cosa ho visto, mangiato, cosa ricordare">' + esc(v ? v.testo : '') + '</textarea></section>';
  });
  return {
    titolo: 'Diario', html: h, dopo() {
      const bersaglio = arg || (oggi >= CONT.partenza && oggi <= CONT.rientro ? oggi : '');
      const el = bersaglio && document.getElementById('d-' + bersaglio);
      if (el) { el.scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); if (arg) { const ta = $('textarea', el); if (ta) ta.focus({ preventScroll: true }); } }
    }
  };
}

let installa = null;
function vistaImpostazioni() {
  const modo = modoSync(), prop = proprietario();
  let h = '';
  if (prop) {
  h += '<h2 class="sez">Dove stanno i tuoi dati</h2><section class="pannello pieno"><div id="statoDett">' + htmlStatoSync() + '</div>';
  if (modo === 'github') h += '<p class="tenue">Repository: ' + esc(repo()) + '</p><div class="azioni larghe"><button class="btn" data-az="sync">Sincronizza ora</button><button class="btn chiaro" data-az="togliToken">Scollega GitHub</button></div>';
  else if (modo === 'drive') h += '<p class="tenue">Cartella "' + esc(CARTELLA_DRIVE) + '" nel tuo Drive.</p><p class="err" id="errDrive" hidden></p><div class="azioni larghe">' + (driveToken() ? '<button class="btn" data-az="sync">Sincronizza ora</button>' : '<button class="btn" data-az="driveAccedi">Rinnova l\'accesso a Google</button>') + '<button class="btn chiaro" data-az="driveEsci">Scollega Google Drive</button></div>';
  else h += '<p class="tenue">Liste, spunte e diario si salvano da soli qui. Per non perderli se cambi o perdi il telefono, scegli uno dei modi qui sotto.</p>';
  h += '</section>';

  h += '<h2 class="sez">Copia di sicurezza</h2><section class="pannello pieno"><p>Il modo più semplice: salvi una copia di tutti i tuoi dati dove vuoi (Google Drive, email, WhatsApp a te stesso) e la ripristini quando serve. Non è automatica: falla ogni tanto.</p><div class="azioni larghe"><button class="btn" data-az="copia">Salva una copia</button><label class="btn chiaro file">Ripristina da una copia<input type="file" id="fImporta" accept="application/json,text/plain,.json,.txt" hidden></label></div><p class="tenue" id="msgCopia"></p></section>';

  if (!modo) {
    if (GOOGLE_CLIENT_ID) h += '<h2 class="sez">Google Drive</h2><section class="pannello pieno"><p>Sincronizzazione automatica con il tuo Drive: accedi con Google e ritrovi i dati sugli altri tuoi dispositivi. L\'app vede solo i file che crea lei, nella cartella "' + esc(CARTELLA_DRIVE) + '".</p><p class="tenue" style="margin-top:8px">L\'accesso dura circa un\'ora: quando scade, il pallino in alto diventa giallo e basta un tocco per rinnovarlo.</p><p class="err" id="errDrive" hidden></p><div class="azioni larghe"><button class="btn" data-az="driveAccedi">Accedi con Google</button></div></section>';
    h += '<h2 class="sez">GitHub</h2><section class="pannello pieno"><p>Sincronizzazione automatica con un tuo repository privato, per chi lo preferisce. L\'accesso non scade finché il token è valido.</p>' +
      '<details class="guida"><summary>Come si fa, passo per passo</summary><ol>' +
      '<li>Crea un account gratuito su <a href="https://github.com/signup" target="_blank" rel="noopener">github.com</a>, se non lo hai.</li>' +
      '<li>Crea un repository nuovo: dagli un nome (per esempio <b>rajasthan-dati</b>), scegli <b>Private</b> e spunta <b>Add a README file</b>.</li>' +
      '<li>Nelle impostazioni del tuo account apri <b>Developer settings</b>, poi <b>Personal access tokens</b>, <b>Fine-grained tokens</b>, e scegli <b>Generate new token</b>.</li>' +
      '<li>In <b>Repository access</b> scegli <b>Only select repositories</b> e seleziona il repository appena creato.</li>' +
      '<li>In <b>Permissions</b>, sotto <b>Repository permissions</b>, imposta <b>Contents</b> su <b>Read and write</b>. Non serve altro.</li>' +
      '<li>Scegli una scadenza successiva al rientro, genera il token e copialo subito: GitHub lo mostra una volta sola.</li>' +
      '<li>Qui sotto scrivi il repository nella forma <b>utente/nome</b>, incolla il token e salva. Ripeti l\'ultimo passo su ogni dispositivo.</li>' +
      '</ol><p class="tenue">I nomi dei menu sono quelli del sito di GitHub, che è in inglese e può cambiarli leggermente.</p></details>' +
      '<label>Repository dei dati<input id="fRepo" value="' + esc(repo()) + '" placeholder="utente/nome" autocapitalize="off" autocomplete="off" spellcheck="false"></label>' +
      '<label>Token<input id="fToken" type="password" autocomplete="off" placeholder="github_pat_…"></label>' +
      '<p class="err" id="errToken" hidden></p><div class="azioni larghe"><button class="btn chiaro" data-az="salvaToken">Salva e sincronizza</button></div></section>';
  }
  }

  h += htmlImpostazioniGruppo();
  h += '<h2 class="sez">App</h2><section class="pannello pieno">';
  h += '<p>' + (versioneNuova ? '<b>È pronta una versione nuova.</b>' : 'Versione ' + esc(VERSIONE) + '.') + '</p><div class="azioni" style="margin:10px 0 14px"><button class="btn' + (versioneNuova ? '' : ' chiaro') + '" data-az="aggiornaApp">Aggiorna l\'app</button>' + (installa ? '<button class="btn chiaro" data-az="installa">Installa sul dispositivo</button>' : '') + '</div><p class="tenue" id="msgApp"></p>';
  h += '<p class="tenue" id="infoMemoria"></p><p class="tenue" style="margin-top:8px">Contenuti aggiornati al ' + esc(fmtBreve.format(dataDa(CONT.aggiornato))) + ' ' + dataDa(CONT.aggiornato).getFullYear() + '. Il pulsante scarica subito l\'ultima versione; i tuoi dati non vengono toccati.</p>';
  h += '<p class="tenue" style="margin-top:8px">Meteo e qualità dell\'aria: <a href="https://open-meteo.com/" target="_blank" rel="noopener" style="text-decoration:underline">Open-Meteo</a>' + (METEO ? ', aggiornati il ' + esc(fmtOra.format(new Date(METEO.t))) : ', non ancora scaricati') + '.</p><div class="azioni"><button class="btn chiaro" data-az="meteo">Aggiorna il meteo</button></div>' +
    '<p class="tenue" style="margin-top:14px">Le foto di luoghi e piatti si scaricano quando apri un dettaglio. Per averle tutte anche offline (circa 3 MB) scaricale prima di partire, col Wi-Fi.</p><div class="azioni"><button class="btn chiaro" data-az="fotoVoci">Scarica tutte le foto</button></div><p class="tenue" id="msgFoto"></p></section><p class="pie"><a href="privacy.html">Informativa sulla privacy</a></p>';
  return {
    titolo: 'Impostazioni', html: h, indietro: '#viaggio', dopo() {
      // Lo script di Google va caricato prima del tocco: una finestra di accesso aperta in ritardo verrebbe bloccata.
      if (GOOGLE_CLIENT_ID && modo !== 'github' && navigator.onLine) caricaGoogle().catch(() => {});
      montaGoogle();
      const el = $('#infoMemoria');
      if (!memoriaOk) { el.textContent = 'La memoria del dispositivo non è disponibile.'; return; }
      if (navigator.storage && navigator.storage.persisted) navigator.storage.persisted().then((p) => { el.textContent = p ? 'Memoria protetta: il sistema non cancellerà i dati per fare spazio.' : 'Memoria non protetta: installa l\'app sulla schermata Home per proteggerla.'; });
    }
  };
}

/* ---------- Finestra di modifica ---------- */
function apriModifica(sez, id) {
  const cfg = LISTE[sez]; const v = id ? voce(sez, id) : null;
  const gruppiNoti = Array.from(new Set(voci(sez).map((x) => x.gruppo).filter(Boolean)));
  let h = '<h2>' + (v ? 'Modifica la voce' : 'Nuova voce') + '</h2>' +
    '<label>Titolo<input name="titolo" required value="' + esc(v ? v.titolo : '') + '"></label>' +
    '<label>Note<textarea name="testo" rows="4">' + esc(v ? v.testo || '' : '') + '</textarea></label>' +
    '<label>Gruppo<input name="gruppo" list="gruppi" value="' + esc(v ? v.gruppo || '' : gruppiNoti[0] || '') + '"><datalist id="gruppi">' + gruppiNoti.map((g) => '<option value="' + esc(g) + '">').join('') + '</datalist></label>';
  if (cfg.conData) h += '<label>Data<input type="date" name="data" value="' + esc(v ? v.data || '' : '') + '"></label>';
  if (cfg.stati) h += '<label>Stato<select name="stato">' + cfg.stati.map((s) => '<option' + ((v ? v.stato : cfg.stati[2]) === s ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></label>';
  h += '<div class="azioni larghe"><button class="btn" value="salva">Salva</button><button class="btn chiaro" value="annulla" formnovalidate>Annulla</button>' + (v ? '<button class="btn pericolo" type="button" id="btnElimina">Elimina</button>' : '') + '</div>';
  const f = $('#dlgForm'); f.innerHTML = h; f.dataset.sez = sez; f.dataset.id = id || ''; f.dataset.sim = '';
  const be = $('#btnElimina');
  if (be) be.addEventListener('click', () => {
    if (be.dataset.conferma) { elimina(sez, id); $('#dlg').close('eliminata'); }
    else { be.dataset.conferma = '1'; be.textContent = 'Conferma: elimina'; }
  });
  $('#dlg').returnValue = '';
  $('#dlg').showModal();
}
$('#dlg').addEventListener('close', () => {
  const d = $('#dlg'), f = $('#dlgForm');
  if (d.returnValue === 'salva' && f.dataset.sim) salvaSim(f);
  else if (d.returnValue === 'salva') {
    const fd = new FormData(f), sez = f.dataset.sez, id = f.dataset.id || nuovoId();
    const campi = { titolo: String(fd.get('titolo') || '').trim(), testo: String(fd.get('testo') || '').trim(), gruppo: String(fd.get('gruppo') || '').trim() };
    if (fd.has('data')) campi.data = fd.get('data') || '';
    if (fd.has('stato')) campi.stato = fd.get('stato');
    if (!f.dataset.id) campi.ord = 5000;
    if (campi.titolo) scrivi(sez, id, campi);
  }
  disegna();
});

/* ---------- Eventi ---------- */
const timerCampo = {};
function campoDi(el) { const k = el.dataset && el.dataset.campo; if (!k) return null; const i = k.indexOf('|'); return { k, sez: k.slice(0, i), id: k.slice(i + 1) }; }
$('#vista').addEventListener('input', (e) => {
  bozzaDaCampo(e.target);
  const c = campoDi(e.target); if (!c) return;
  const ta = e.target;
  clearTimeout(timerCampo[c.k]);
  timerCampo[c.k] = setTimeout(() => { timerCampo[c.k] = null; scrivi(c.sez, c.id, { testo: ta.value }); }, 600);
  ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px';
});
$('#vista').addEventListener('focusout', (e) => {
  const c = campoDi(e.target);
  if (c && timerCampo[c.k]) { clearTimeout(timerCampo[c.k]); timerCampo[c.k] = null; const v = voce(c.sez, c.id); if (!v || v.testo !== e.target.value) scrivi(c.sez, c.id, { testo: e.target.value }); }
  if (disegnoRimandato) setTimeout(() => { if (!staScrivendo()) disegna(); }, 250);
});
$('#vista').addEventListener('change', (e) => {
  if (bozzaDaCampo(e.target)) { disegna(); return; }
  const sp = e.target.dataset && (e.target.dataset.simpos || e.target.dataset.simruolo);
  if (sp) {
    const i = sp.indexOf('|'), s = voce('simulatore', sp.slice(0, i)), x = sp.slice(i + 1), val = e.target.value;
    if (!s) return;
    if (e.target.dataset.simpos) { const pos = Object.assign({}, s.pos); if (val === 'casa') delete pos[x]; else pos[x] = val; scrivi('simulatore', s.id, { pos }); }
    else {
      const cont = Object.assign({}, s.cont);
      if (val === 'fuori') {
        delete cont[x];
        // Chi stava dentro il contenitore tolto torna fuori: gli oggetti a casa, i contenitori fuori dallo scenario.
        const pos = Object.assign({}, s.pos); Object.keys(pos).forEach((k) => { if (pos[k] === x) delete pos[k]; });
        Object.keys(cont).forEach((k) => { if (cont[k] === 'dentro:' + x) delete cont[k]; });
        scrivi('simulatore', s.id, { cont, pos });
      } else { cont[x] = val; scrivi('simulatore', s.id, { cont }); }
    }
    disegna();
    return;
  }
  if (e.target.id !== 'fImporta' || !e.target.files[0]) return;
  const lettore = new FileReader();
  lettore.onload = () => {
    const msg = $('#msgCopia');
    try {
      const j = JSON.parse(lettore.result); if (!j || !j.dati) throw new Error('formato');
      let n = 0;
      for (const s of SEZIONI) {
        const it = j.dati[s] && j.dati[s].items; if (!it) continue;
        if (unisci(DB[s].items, it).daLocale) { DB[s].items = unisci(it, DB[s].items).uniti; modifiche[s]++; salvaSezione(s); segnaAttesa(s, true); n++; }
      }
      if (msg) msg.textContent = n ? 'Dati ripristinati.' : 'Nella copia non c\'è niente di più recente di quello che hai già.';
      programmaSync();
    } catch (err) { if (msg) msg.textContent = 'Questo file non è una copia dei dati dell\'app.'; }
  };
  lettore.readAsText(e.target.files[0]);
});
$('#vista').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-az]'); if (!el) return;
  const az = el.dataset.az, sez = el.dataset.sez, id = el.dataset.id;
  if (await azioneAccount(az, el)) return;
  if (await azioneGruppo(az, el)) return;
  if (az === 'segno') { const s = voce('segni', id); scrivi('segni', id, { fatto: !(s && s.fatto) }); el.classList.toggle('on'); el.setAttribute('aria-pressed', el.classList.contains('on')); }
  else if (az === 'fatto') { const v = voce(sez, id); if (v) { scrivi(sez, id, { fatto: !v.fatto }); disegna(); } }
  else if (az === 'stato') { const v = voce(sez, id), st = LISTE[sez].stati; if (v) { scrivi(sez, id, { stato: st[(st.indexOf(v.stato || st[0]) + 1) % st.length] }); disegna(); } }
  else if (az === 'modifica') apriModifica(sez, id);
  else if (az === 'nuova') apriModifica(sez, null);
  else if (az === 'simNuovo') apriSim(el.dataset.tipo, null);
  else if (az === 'simMod') apriSim(el.dataset.tipo, id);
  else if (az === 'simDuplica') {
    const s = voce('simulatore', id); if (!s) return;
    const nid = nuovoId();
    scrivi('simulatore', nid, { tipo: 'scenario', titolo: s.titolo + ' (copia)', testo: s.testo || '', limCabina: s.limCabina || 0, limPersonale: s.limPersonale || 0, limStiva: s.limStiva || 0, cont: Object.assign({}, s.cont), pos: Object.assign({}, s.pos), ord: (s.ord || 0) + 1 });
    location.hash = '#sim/' + nid;
  }
  else if (az === 'sync') sincronizza(true);
  else if (az === 'fotoVoci') { el.disabled = true; await scaricaFotoVoci($('#msgFoto')); el.disabled = false; }
  else if (az === 'aggiornaApp') { el.disabled = true; await aggiornaApp($('#msgApp')); el.disabled = false; }
  else if (az === 'meteo') { el.disabled = true; await aggiornaMeteo(true); disegna(); }
  else if (az === 'togliToken') { LS.del('rj.token'); statoSync.fase = 'fermo'; disegna(); }
  else if (az === 'salvaToken') {
    const t = $('#fToken').value.trim(), r = $('#fRepo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\/$/, ''), err = $('#errToken');
    const mostra = (m) => { err.textContent = m; err.hidden = false; };
    if (!t || !/^[\w.-]+\/[\w.-]+$/.test(r)) { mostra('Inserisci il token e il repository nella forma utente/nome.'); return; }
    if (!navigator.onLine) { mostra('Serve la rete per verificare il token.'); return; }
    el.disabled = true; LS.set('rj.token', t); LS.set('rj.repo', r);
    try {
      const p = await gh('');
      if (p.status === 200) { const j = await p.json(); if (j.permissions && j.permissions.push === false) throw new Error('Il token può leggere il repository ma non scriverci.'); }
      else if (p.status === 401) throw new Error('Token non valido o scaduto.');
      else throw new Error('Repository non trovato, o il token non vi ha accesso.');
      disegna(); sincronizza(true);
    } catch (x) { LS.del('rj.token'); el.disabled = false; mostra(/fetch|Network|Load failed/i.test(x.message) ? 'Rete non raggiungibile.' : x.message); aggiornaStato(); }
  }
  else if (az === 'driveAccedi') {
    const err = $('#errDrive'); el.disabled = true;
    try { await driveAccedi(); if (!LS.get('rj.drive', null)) LS.set('rj.drive', { file: {} }); statoSync.fase = 'fermo'; disegna(); sincronizza(true); }
    catch (x) { el.disabled = false; if (err) { err.textContent = x.message; err.hidden = false; } }
  }
  else if (az === 'driveEsci') { LS.del('rj.drive'); LS.del('rj.driveTok'); statoSync.fase = 'fermo'; disegna(); }
  else if (az === 'copia') {
    const dati = {}; for (const s of SEZIONI) dati[s] = DB[s];
    const testo = JSON.stringify({ app: 'rajasthan', v: 1, esportato: new Date().toISOString(), dati }, null, 1);
    const nome = 'rajasthan-copia-' + oggiIso() + '.txt', msg = $('#msgCopia');
    let fatto = false;
    try {
      const file = new File([testo], nome, { type: 'text/plain' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: 'Copia dei dati di Tutto Rajasthan' }); fatto = true; if (msg) msg.textContent = 'Copia consegnata all\'app che hai scelto.'; }
    } catch (x) { if (x && x.name === 'AbortError') { fatto = true; if (msg) msg.textContent = 'Nessuna copia salvata.'; } }
    if (!fatto) {
      const url = URL.createObjectURL(new Blob([testo], { type: 'text/plain' }));
      const a = document.createElement('a'); a.href = url; a.download = nome; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      if (msg) msg.textContent = 'File salvato tra i download: spostalo dove preferisci.';
    }
  }
  else if (az === 'installa' && installa) { installa.prompt(); installa = null; }
});
$('#back').addEventListener('click', () => { location.hash = $('#back').dataset.dove || '#viaggio'; });
$('#stato').addEventListener('click', () => { location.hash = '#impostazioni'; });
// L'avviso viene creato qui se la pagina sul dispositivo è ancora quella vecchia:
// pagina e script possono essere di versioni diverse per una apertura.
(function preparaAvvisoVersione() {
  let b = $('#bannerVersione');
  if (!b) {
    b = document.createElement('div'); b.className = 'nuova'; b.id = 'bannerVersione'; b.hidden = true;
    b.innerHTML = '<p><b>È pronta una versione nuova dell\'app.</b> <span id="msgVersione"></span></p><button id="btnVersione">Aggiorna</button>';
    const v = $('#vista'); v.parentNode.insertBefore(b, v);
  }
  $('#btnVersione').addEventListener('click', (e) => { e.target.disabled = true; aggiornaApp($('#msgVersione')).then(() => { e.target.disabled = false; }); });
})();
window.addEventListener('hashchange', () => { leggiRotta(); disegna(); window.scrollTo(0, 0); });
window.addEventListener('online', () => { sincronizza(false); aggiornaMeteo(false); grSincronizza(); });
window.addEventListener('offline', aggiornaStato);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { sincronizza(true); aggiornaMeteo(false); controllaVersione(); grSincronizza(); } });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installa = e; if (rotta.nome === 'impostazioni') disegna(); });
setInterval(() => sincronizza(false), 5 * 60 * 1000);
setInterval(() => { if (document.visibilityState === 'visible') grSincronizza(); }, 2 * 60 * 1000);

/* ---------- Avvio ---------- */
(async function avvio() {
  if (!memoriaOk) mostraAvvisoMemoria();
  leggiRotta();
  await caricaContenuti();
  disegna();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* senza service worker l'app funziona solo online */ });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  sincronizza(true);
  aggiornaMeteo(false);
  controllaVersione();
  scaricaFoto();
  grSincronizza();
})();
