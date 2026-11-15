'use strict';
/* Tutto Rajasthan – app di viaggio offline-first.
   - Contenuti comuni: data/tappe.json (tenuto sul dispositivo dal service worker).
   - Dati personali: memoria locale del dispositivo; con un token, sincronizzati
     come file JSON in un repository GitHub privato (un file per sezione). */

const REPO_PREDEFINITO = 'gerardo-paternoster/rajasthan-dati';
const SEZIONI = ['segni', 'diario', 'scadenze', 'bagagli', 'documenti', 'foto'];
const LISTE = {
  scadenze: { nome: 'Scadenze', spunta: 'fatto', conData: true },
  bagagli: { nome: 'Bagagli', spunta: 'nello zaino', stati: ['posseduto', 'da comprare', 'da decidere'] },
  documenti: { nome: 'Documenti e salute', spunta: 'fatto', conData: true },
  foto: { nome: 'Fotografia', spunta: null }
};

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

const DB = {};       // DB[sezione] = { items: { id: voce } }
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

/* ---------- Sincronizzazione con GitHub ---------- */
function token() { return LS.get('rj.token', ''); }
function repo() { return LS.get('rj.repo', REPO_PREDEFINITO); }
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
async function gh(percorso, opzioni) {
  const o = Object.assign({ cache: 'no-store' }, opzioni || {});
  o.headers = Object.assign({ Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, o.headers || {});
  return fetch('https://api.github.com/repos/' + repo() + percorso, o);
}
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
  const contatore = modifiche[s];
  const r = await gh('/contents/' + s + '.json?ref=main');
  let remoto = {}, sha = null;
  if (r.status === 200) {
    const j = await r.json(); sha = j.sha;
    try { remoto = (JSON.parse(testoDaB64(j.content || '')).items) || {}; }
    catch (e) { throw new Error('Il file ' + s + '.json nel repository non è leggibile.'); }
  } else if (r.status === 401) { throw new Error('Token non valido o scaduto.');
  } else if (r.status === 403) { throw new Error('Accesso negato da GitHub (permessi del token o limite di richieste).');
  } else if (r.status !== 404) { throw new Error('GitHub ha risposto ' + r.status + '.'); }

  const esito = unisci(DB[s].items, remoto);
  if (esito.daInviare) {
    const corpo = { message: 'Aggiornamento ' + s + ' dall\'app', branch: 'main', content: b64DaTesto(JSON.stringify({ v: 1, items: esito.uniti }, null, 1)) };
    if (sha) corpo.sha = sha;
    const p = await gh('/contents/' + s + '.json', { method: 'PUT', body: JSON.stringify(corpo) });
    if (p.status === 409 || p.status === 422) {
      if (tentativo) throw new Error('Conflitto nel salvataggio di ' + s + '. Riprova.');
      return sincronizzaSezione(s, true);
    }
    if (p.status === 404) throw new Error('Repository non trovato o token senza permesso di scrittura.');
    if (!p.ok) throw new Error('Salvataggio non riuscito (' + p.status + ').');
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
  if (!token()) { aggiornaStato(); return; }
  if (!navigator.onLine) { statoSync.fase = 'offline'; aggiornaStato(); return; }
  if (inCorso) { daRifare = true; return; }
  inCorso = true; statoSync.fase = 'sync'; statoSync.errore = ''; aggiornaStato();
  let cambiato = false;
  try {
    for (const s of SEZIONI) {
      if (tutte || inAttesa[s]) { if (await sincronizzaSezione(s)) cambiato = true; }
    }
    statoSync.fase = 'ok'; statoSync.ultima = Date.now(); LS.set('rj.ultimaSync', statoSync.ultima);
  } catch (e) {
    statoSync.fase = navigator.onLine ? 'errore' : 'offline';
    statoSync.errore = e && e.message ? e.message : 'Errore di rete.';
    if (/Failed to fetch|NetworkError|Load failed/i.test(statoSync.errore)) { statoSync.errore = 'Rete non raggiungibile.'; }
  }
  inCorso = false; aggiornaStato();
  if (cambiato) disegnaSePossibile();
  if (daRifare) { daRifare = false; programmaSync(); }
}
function programmaSync() { clearTimeout(timerSync); timerSync = setTimeout(() => sincronizza(false), 3000); }

function aggiornaStato() {
  const p = $('#punto'); if (!p) return;
  const attesa = Object.keys(inAttesa).length;
  let c = 'grigio', t = 'Dati solo su questo dispositivo';
  if (token()) {
    if (statoSync.fase === 'sync') { c = 'blu'; t = 'Sincronizzazione in corso'; }
    else if (statoSync.fase === 'errore') { c = 'rosso'; t = 'Errore di sincronizzazione'; }
    else if (attesa) { c = 'ambra'; t = 'Modifiche in attesa di sincronizzazione'; }
    else { c = 'verde'; t = 'Sincronizzato'; }
  }
  p.className = 'punto ' + c; $('#stato').title = t;
  const box = $('#statoDett'); if (box) box.innerHTML = htmlStatoSync();
}
function htmlStatoSync() {
  const attesa = Object.keys(inAttesa);
  if (!token()) return '<p>Nessun token: i dati restano su questo dispositivo.' + (attesa.length ? '' : '') + '</p>';
  let h = '';
  if (statoSync.fase === 'sync') h += '<p>Sincronizzazione in corso…</p>';
  else if (statoSync.fase === 'errore') h += '<p class="err">' + esc(statoSync.errore) + '</p>';
  else if (!navigator.onLine) h += '<p>Senza rete: la sincronizzazione riprende da sola.</p>';
  h += '<p>' + (attesa.length ? 'In attesa: ' + esc(attesa.join(', ')) + '.' : 'Nessuna modifica in attesa.') + '</p>';
  h += '<p class="tenue">Ultima sincronizzazione: ' + (statoSync.ultima ? esc(fmtOra.format(new Date(statoSync.ultima))) : 'mai') + '</p>';
  return h;
}
function mostraAvvisoMemoria() { const a = $('#avvisoMemoria'); if (a) a.hidden = false; }

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
  if (!CONT) { v.innerHTML = '<div class="carta"><h2>Contenuti non disponibili</h2><p>Apri l\'app una volta con la rete attiva per scaricare i contenuti.</p></div>'; return; }
  const viste = { viaggio: vistaViaggio, tappe: vistaTappe, tappa: vistaTappa, generali: vistaGenerali, liste: vistaListe, diario: vistaDiario, impostazioni: vistaImpostazioni };
  const f = viste[rotta.nome] || vistaViaggio;
  const r = f(rotta.arg);
  v.innerHTML = r.html;
  $('#titolo').textContent = r.titolo;
  $('#back').hidden = !r.indietro; $('#back').dataset.dove = r.indietro || '';
  const tab = { tappa: 'tappe', generali: 'tappe' }[rotta.nome] || rotta.nome;
  document.querySelectorAll('.tab a').forEach((a) => a.classList.toggle('qui', a.dataset.tab === tab));
  aggiornaStato();
  if (r.dopo) r.dopo();
}

function vistaViaggio() {
  const oggi = oggiIso(), p = CONT.partenza, r = CONT.rientro;
  let testa;
  if (oggi < p) { const n = giorniTra(oggi, p); testa = '<div class="conto"><b>' + n + '</b><span>' + (n === 1 ? 'giorno' : 'giorni') + ' alla partenza</span></div>'; }
  else if (oggi <= r) { testa = '<div class="conto"><b>' + (giorniTra(p, oggi) + 1) + '</b><span>° giorno di ' + (giorniTra(p, r) + 1) + '</span></div>'; }
  else { testa = '<div class="conto"><span>Viaggio concluso</span></div>'; }
  let h = '<section class="eroe">' + testa + '<p>' + esc(fmtBreve.format(dataDa(p))) + ' – ' + esc(fmtBreve.format(dataDa(r))) + ' ' + dataDa(r).getFullYear() + '</p></section>';
  if (CONT.calendarioStimato) h += '<p class="nota-stima">Calendario stimato: fa fede il programma del coordinatore.</p>';
  h += '<ol class="giorni">';
  CONT.giorni.forEach((g, i) => {
    const cl = g.data === oggi ? ' oggi' : (g.data < oggi ? ' passato' : '');
    const d = voce('diario', 'g-' + g.data);
    h += '<li class="giorno' + cl + '"><div class="quando"><span class="n">' + (i + 1) + '</span>' + esc(fmtGiorno.format(dataDa(g.data))) + '</div><div class="cosa"><h3>' + esc(g.titolo) + '</h3>';
    if (g.nota) h += '<p class="tenue">' + esc(g.nota) + '</p>';
    h += '<div class="azioni">' + g.tappe.map((id) => { const t = tappa(id); return t ? '<a class="chip" href="#tappa/' + esc(id) + '">' + esc(t.nome) + '</a>' : ''; }).join('');
    h += '<a class="chip chiaro" href="#diario/' + esc(g.data) + '">' + (d && d.testo ? '✎ Diario scritto' : '✎ Diario') + '</a></div></div></li>';
  });
  h += '</ol>';
  return { titolo: 'Tutto Rajasthan', html: h, dopo() { const o = $('.giorno.oggi'); if (o) o.scrollIntoView({ block: 'center' }); } };
}

function vistaTappe() {
  let h = '<a class="carta link" href="#generali"><h2>Consigli per tutto il viaggio</h2><p class="tenue">Scarpe, abbigliamento nei templi, cibo di strada, guide non ufficiali.</p></a>';
  CONT.tappe.forEach((t) => {
    const tot = t.vedere.length + t.mangiare.length;
    const fatti = t.vedere.concat(t.mangiare).filter((x, i) => { const k = i < t.vedere.length ? 'v' : 'm'; const s = voce('segni', t.id + '/' + k + '/' + slug(x.t)); return s && s.fatto; }).length;
    h += '<a class="carta link" href="#tappa/' + esc(t.id) + '"><div class="riga"><h2>' + esc(t.nome) + '</h2><span class="temp">' + t.clima.min + '° / ' + t.clima.max + '°</span></div><p class="tenue">' + esc(t.quando) + (fatti ? ' · ' + fatti + ' di ' + tot + ' spuntati' : '') + '</p></a>';
  });
  h += '<p class="pie">' + esc(CONT.avviso) + '<br>Contenuti aggiornati al ' + esc(fmtBreve.format(dataDa(CONT.aggiornato))) + ' ' + dataDa(CONT.aggiornato).getFullYear() + '.</p>';
  return { titolo: 'Tappe', html: h };
}

function htmlSegni(t, lista, k, titolo, etichetta) {
  if (!lista.length) return '';
  let h = '<section class="carta"><h2>' + titolo + '</h2><ul class="segni">';
  lista.forEach((x) => {
    const id = t.id + '/' + k + '/' + slug(x.t); const s = voce('segni', id); const on = !!(s && s.fatto);
    h += '<li><button class="spunta' + (on ? ' on' : '') + '" data-az="segno" data-id="' + esc(id) + '" aria-pressed="' + on + '" aria-label="' + esc(etichetta + ': ' + x.t) + '"></button><div><h3>' + esc(x.t) + '</h3>' + (x.d ? '<p>' + esc(x.d) + '</p>' : '') + '</div></li>';
  });
  return h + '</ul></section>';
}
function vistaTappa(id) {
  const t = tappa(id); if (!t) return vistaTappe();
  let h = '<section class="eroe piccolo"><p>' + esc(t.quando) + (CONT.calendarioStimato ? ' · data stimata' : '') + '</p><div class="clima"><b>' + t.clima.min + '°</b> min <b>' + t.clima.max + '°</b> max</div><p>' + esc(t.clima.nota) + '</p></section>';
  h += htmlSegni(t, t.vedere, 'v', 'Cosa vedere', 'Visto');
  h += htmlSegni(t, t.mangiare, 'm', 'Cosa mangiare', 'Assaggiato');
  h += '<section class="carta"><h2>Consigli pratici</h2><ul class="punti">' + t.consigli.map((c) => '<li>' + esc(c) + '</li>').join('') + '</ul></section>';
  const gg = CONT.giorni.filter((g) => g.tappe.indexOf(t.id) >= 0);
  if (gg.length) h += '<div class="azioni larghe">' + gg.map((g) => '<a class="chip chiaro" href="#diario/' + esc(g.data) + '">✎ Diario del ' + esc(fmtBreve.format(dataDa(g.data))) + '</a>').join('') + '</div>';
  return { titolo: t.nome, html: h, indietro: '#tappe' };
}
function vistaGenerali() {
  const h = '<section class="carta"><ul class="voci-testo">' + CONT.generali.map((g) => '<li><h3>' + esc(g.t) + '</h3><p>' + esc(g.d) + '</p></li>').join('') + '</ul></section>';
  return { titolo: 'Consigli generali', html: h, indietro: '#tappe' };
}

function vistaListe(arg) {
  const sez = LISTE[arg] ? arg : LS.get('rj.lista', 'scadenze');
  LS.set('rj.lista', sez);
  const cfg = LISTE[sez];
  let h = '<div class="sotto">' + Object.keys(LISTE).map((k) => '<a href="#liste/' + k + '" class="' + (k === sez ? 'qui' : '') + '">' + esc(LISTE[k].nome) + '</a>').join('') + '</div>';
  const tutte = voci(sez);
  if (!tutte.length) {
    h += '<div class="carta vuoto"><p>Nessuna voce.</p><p class="tenue">' + (token() ? 'Aggiungine una, oppure attendi la sincronizzazione.' : 'Aggiungi le tue voci: restano su questo dispositivo.') + '</p></div>';
  } else {
    if (cfg.spunta) { const f = tutte.filter((v) => v.fatto).length; h += '<p class="progresso"><span style="--p:' + Math.round(100 * f / tutte.length) + '%"></span>' + f + ' di ' + tutte.length + ' ' + esc(cfg.spunta) + '</p>'; }
    const gruppi = {};
    tutte.forEach((v) => { const g = v.gruppo || 'Altro'; (gruppi[g] = gruppi[g] || []).push(v); });
    const ordG = Object.keys(gruppi).sort((a, b) => Math.min.apply(null, gruppi[a].map((v) => v.ord || 9999)) - Math.min.apply(null, gruppi[b].map((v) => v.ord || 9999)) || a.localeCompare(b));
    ordG.forEach((g) => {
      h += '<section class="carta"><h2>' + esc(g) + '</h2><ul class="lista">';
      gruppi[g].sort((a, b) => (a.ord || 9999) - (b.ord || 9999) || String(a.titolo).localeCompare(String(b.titolo))).forEach((v) => {
        h += '<li class="' + (v.fatto ? 'fatto' : '') + '">';
        if (cfg.spunta) h += '<button class="spunta' + (v.fatto ? ' on' : '') + '" data-az="fatto" data-sez="' + sez + '" data-id="' + esc(v.id) + '" aria-pressed="' + !!v.fatto + '" aria-label="' + esc(cfg.spunta + ': ' + v.titolo) + '"></button>';
        h += '<div class="corpo" data-az="modifica" data-sez="' + sez + '" data-id="' + esc(v.id) + '"><h3>' + esc(v.titolo) + '</h3>';
        if (v.testo) h += '<p>' + testoAParagrafi(v.testo) + '</p>';
        let meta = '';
        if (v.data) { const gg = giorniTra(oggiIso(), v.data); meta += '<span class="quando-voce' + (gg < 0 && !v.fatto ? ' scaduta' : '') + '">' + esc(fmtBreve.format(dataDa(v.data))) + (v.fatto ? '' : gg === 0 ? ' · oggi' : gg > 0 ? ' · tra ' + gg + ' g' : ' · scaduta') + '</span>'; }
        if (meta) h += '<div class="meta">' + meta + '</div>';
        h += '</div>';
        if (cfg.stati) h += '<button class="stato-voce s-' + slug(v.stato || cfg.stati[0]) + '" data-az="stato" data-sez="' + sez + '" data-id="' + esc(v.id) + '">' + esc(v.stato || cfg.stati[0]) + '</button>';
        h += '</li>';
      });
      h += '</ul></section>';
    });
  }
  h += '<button class="piu" data-az="nuova" data-sez="' + sez + '">+ Aggiungi voce</button>';
  return { titolo: 'Liste', html: h };
}

function vistaDiario(arg) {
  const oggi = oggiIso();
  let h = '<p class="tenue intro">Si salva da solo mentre scrivi.</p>';
  const note = voce('diario', 'note');
  h += '<section class="carta diario"><h2>Note generali</h2><textarea data-diario="note" rows="3" placeholder="Appunti che non appartengono a un giorno preciso">' + esc(note ? note.testo : '') + '</textarea></section>';
  CONT.giorni.forEach((g, i) => {
    const v = voce('diario', 'g-' + g.data);
    h += '<section class="carta diario' + (g.data === oggi ? ' oggi' : '') + '" id="d-' + g.data + '"><h2><span class="n">' + (i + 1) + '</span>' + esc(fmtLungo.format(dataDa(g.data))) + '</h2><p class="tenue">' + esc(g.titolo) + '</p><textarea data-diario="g-' + g.data + '" rows="' + (v && v.testo ? 5 : 2) + '" placeholder="Cosa ho visto, mangiato, cosa ricordare">' + esc(v ? v.testo : '') + '</textarea></section>';
  });
  return {
    titolo: 'Diario', html: h, dopo() {
      const bersaglio = arg || (oggi >= CONT.partenza && oggi <= CONT.rientro ? oggi : '');
      const el = bersaglio && document.getElementById('d-' + bersaglio);
      if (el) { el.scrollIntoView({ block: 'start' }); if (arg) { const ta = $('textarea', el); if (ta) ta.focus({ preventScroll: true }); } }
    }
  };
}

let installa = null;
function vistaImpostazioni() {
  let h = '<section class="carta"><h2>Sincronizzazione</h2><div id="statoDett">' + htmlStatoSync() + '</div>';
  if (token()) {
    h += '<p class="tenue">Repository: ' + esc(repo()) + '</p><div class="azioni larghe"><button class="btn" data-az="sync">Sincronizza ora</button><button class="btn chiaro" data-az="togliToken">Rimuovi il token</button></div>';
  } else {
    h += '<p>Con un token di accesso GitHub i dati vengono salvati anche in un repository privato e ritrovati sugli altri dispositivi. Senza token l\'app funziona lo stesso e i dati restano qui.</p>' +
      '<label>Repository dei dati<input id="fRepo" value="' + esc(repo()) + '" autocapitalize="off" autocomplete="off" spellcheck="false"></label>' +
      '<label>Token<input id="fToken" type="password" autocomplete="off" placeholder="github_pat_…"></label>' +
      '<p class="err" id="errToken" hidden></p><button class="btn" data-az="salvaToken">Salva e sincronizza</button>';
  }
  h += '</section>';
  h += '<section class="carta"><h2>Copia di sicurezza</h2><p>Salva tutti i tuoi dati in un file, o ricaricali da un file salvato.</p><div class="azioni larghe"><button class="btn chiaro" data-az="esporta">Esporta</button><label class="btn chiaro file">Importa<input type="file" id="fImporta" accept="application/json,.json" hidden></label></div><p class="tenue" id="msgCopia"></p></section>';
  h += '<section class="carta"><h2>App</h2>';
  if (installa) h += '<button class="btn" data-az="installa">Installa sul dispositivo</button>';
  h += '<p class="tenue" id="infoMemoria"></p><p class="tenue">Contenuti aggiornati al ' + esc(fmtBreve.format(dataDa(CONT.aggiornato))) + ' ' + dataDa(CONT.aggiornato).getFullYear() + '. Gli aggiornamenti si scaricano da soli con la rete e compaiono alla riapertura.</p></section>';
  return {
    titolo: 'Impostazioni', html: h, indietro: '#viaggio', dopo() {
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
  let h = '<h2>' + (v ? 'Modifica voce' : 'Nuova voce') + '</h2>' +
    '<label>Titolo<input name="titolo" required value="' + esc(v ? v.titolo : '') + '"></label>' +
    '<label>Note<textarea name="testo" rows="4">' + esc(v ? v.testo || '' : '') + '</textarea></label>' +
    '<label>Gruppo<input name="gruppo" list="gruppi" value="' + esc(v ? v.gruppo || '' : gruppiNoti[0] || '') + '"><datalist id="gruppi">' + gruppiNoti.map((g) => '<option value="' + esc(g) + '">').join('') + '</datalist></label>';
  if (cfg.conData) h += '<label>Data<input type="date" name="data" value="' + esc(v ? v.data || '' : '') + '"></label>';
  if (cfg.stati) h += '<label>Stato<select name="stato">' + cfg.stati.map((s) => '<option' + ((v ? v.stato : cfg.stati[2]) === s ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></label>';
  h += '<div class="azioni larghe"><button class="btn" value="salva">Salva</button><button class="btn chiaro" value="annulla" formnovalidate>Annulla</button>' + (v ? '<button class="btn pericolo" type="button" id="btnElimina">Elimina</button>' : '') + '</div>';
  const f = $('#dlgForm'); f.innerHTML = h; f.dataset.sez = sez; f.dataset.id = id || '';
  const be = $('#btnElimina');
  if (be) be.addEventListener('click', () => {
    if (be.dataset.conferma) { elimina(sez, id); $('#dlg').close('eliminata'); }
    else { be.dataset.conferma = '1'; be.textContent = 'Conferma eliminazione'; }
  });
  $('#dlg').returnValue = '';
  $('#dlg').showModal();
}
$('#dlg').addEventListener('close', () => {
  const d = $('#dlg'), f = $('#dlgForm');
  if (d.returnValue === 'salva') {
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
const timerDiario = {};
$('#vista').addEventListener('input', (e) => {
  const k = e.target.dataset && e.target.dataset.diario; if (!k) return;
  const ta = e.target;
  clearTimeout(timerDiario[k]);
  timerDiario[k] = setTimeout(() => scrivi('diario', k, { testo: ta.value }), 600);
  ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 2 + 'px';
});
$('#vista').addEventListener('focusout', (e) => {
  const k = e.target.dataset && e.target.dataset.diario;
  if (k && timerDiario[k]) { clearTimeout(timerDiario[k]); timerDiario[k] = null; const v = voce('diario', k); if (!v || v.testo !== e.target.value) scrivi('diario', k, { testo: e.target.value }); }
  if (disegnoRimandato) setTimeout(() => { if (!staScrivendo()) disegna(); }, 250);
});
$('#vista').addEventListener('change', (e) => {
  if (e.target.id !== 'fImporta' || !e.target.files[0]) return;
  const lettore = new FileReader();
  lettore.onload = () => {
    const msg = $('#msgCopia');
    try {
      const j = JSON.parse(lettore.result); if (!j || !j.dati) throw new Error('formato');
      let n = 0;
      for (const s of SEZIONI) {
        const it = j.dati[s] && j.dati[s].items; if (!it) continue;
        const es = unisci(DB[s].items, it);
        const finale = unisci(it, DB[s].items).uniti; // vince la voce più recente
        if (es.daLocale) { DB[s].items = finale; modifiche[s]++; salvaSezione(s); segnaAttesa(s, true); n++; }
      }
      if (msg) msg.textContent = n ? 'Importazione completata.' : 'Nessuna voce nuova nel file.';
      programmaSync();
    } catch (err) { if (msg) msg.textContent = 'Il file non è una copia valida dell\'app.'; }
  };
  lettore.readAsText(e.target.files[0]);
});
$('#vista').addEventListener('click', async (e) => {
  const el = e.target.closest('[data-az]'); if (!el) return;
  const az = el.dataset.az, sez = el.dataset.sez, id = el.dataset.id;
  if (az === 'segno') { const s = voce('segni', id); scrivi('segni', id, { fatto: !(s && s.fatto) }); el.classList.toggle('on'); el.setAttribute('aria-pressed', el.classList.contains('on')); }
  else if (az === 'fatto') { const v = voce(sez, id); if (v) { scrivi(sez, id, { fatto: !v.fatto }); disegna(); } }
  else if (az === 'stato') { const v = voce(sez, id), st = LISTE[sez].stati; if (v) { scrivi(sez, id, { stato: st[(st.indexOf(v.stato || st[0]) + 1) % st.length] }); disegna(); } }
  else if (az === 'modifica') apriModifica(sez, id);
  else if (az === 'nuova') apriModifica(sez, null);
  else if (az === 'sync') sincronizza(true);
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
  else if (az === 'esporta') {
    const dati = {}; for (const s of SEZIONI) dati[s] = DB[s];
    const url = URL.createObjectURL(new Blob([JSON.stringify({ app: 'rajasthan', v: 1, esportato: new Date().toISOString(), dati }, null, 1)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = 'rajasthan-dati-' + oggiIso() + '.json'; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    const msg = $('#msgCopia'); if (msg) msg.textContent = 'File salvato tra i download.';
  }
  else if (az === 'installa' && installa) { installa.prompt(); installa = null; }
});
$('#back').addEventListener('click', () => { location.hash = $('#back').dataset.dove || '#viaggio'; });
$('#stato').addEventListener('click', () => { location.hash = '#impostazioni'; });
window.addEventListener('hashchange', () => { leggiRotta(); disegna(); window.scrollTo(0, 0); });
window.addEventListener('online', () => sincronizza(false));
window.addEventListener('offline', aggiornaStato);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sincronizza(true); });
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installa = e; if (rotta.nome === 'impostazioni') disegna(); });
setInterval(() => sincronizza(false), 5 * 60 * 1000);

/* ---------- Avvio ---------- */
(async function avvio() {
  if (!memoriaOk) mostraAvvisoMemoria();
  leggiRotta();
  await caricaContenuti();
  disegna();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => { /* senza service worker l'app funziona solo online */ });
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  sincronizza(true);
})();
