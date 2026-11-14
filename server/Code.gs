// Hotte Surprise : petit serveur Secret Santa sur Google Apps Script.
// Déploiement : Déployer > Nouveau déploiement > Application Web
//   Exécuter en tant que : Moi · Qui a accès : Tout le monde
// FIN DU FICHIER : la dernière ligne est « // ===== FIN ===== ».
const SITE = "https://hottesurprise.fr/";
const CODE_DIGITS = 6;          // longueur du code secret envoyé à chaque participant
const MAX_PARTICIPANTS = 40;     // limite liée à la taille de stockage (9 Ko par Secret Santa)
const MAX_EVENTS_PER_DAY = 10;   // anti-abus : créations de Secret Santa par jour et par compte Google
const MAX_EVENTS_PER_DAY_SITE = 100; // anti-abus : créations par jour sur tout le site
const MAX_FIND_FAILURES = 60;    // anti-devinette : codes faux tolérés par heure sur la page d'accueil (tout le site)
const MAX_CODE_FAILURES = 10;    // anti-devinette : codes faux tolérés par heure et par Secret Santa
// Connexion Google pour les organisateurs : ID client OAuth (public). Vide = création libre sans connexion.
const GOOGLE_CLIENT_ID = "841116298846-u2p0did8cuubiabmauqtsfvsmaf2qfp7.apps.googleusercontent.com";

function doPost(e) {
  let out;
  try {
    const req = JSON.parse(e.postData.contents);
    const fn = ACTIONS[req.action];
    if (!fn) throw new Error("Action inconnue");
    out = fn(req);
  } catch (err) {
    out = { error: String(err && err.message || err) };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() {
  return ContentService.createTextOutput(JSON.stringify({ ok: true, app: "hotte-surprise" })).setMimeType(ContentService.MimeType.JSON);
}

// ---------- Stockage ----------
const props = () => PropertiesService.getScriptProperties();
function load(id) {
  const raw = props().getProperty("ev_" + String(id || "").replace(/[^A-Za-z0-9]/g, ""));
  if (!raw) throw new Error("Ce Secret Santa n'existe pas ou a été supprimé.");
  return JSON.parse(raw);
}
function store(ev) {
  const json = JSON.stringify(ev);
  if (json.length > 8800) throw new Error("Ce Secret Santa est trop grand pour être enregistré (trop de participants).");
  props().setProperty("ev_" + ev.id, json);
}
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------- Outils ----------
// Aléatoire sûr : octets issus de Utilities.getUuid() (UUID v4 aléatoires), sans biais (tirage par rejet)
function rand(n, alphabet) {
  alphabet = alphabet || "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const max = 256 - (256 % alphabet.length);
  let s = "", pool = [];
  while (s.length < n) {
    if (!pool.length) pool = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, Utilities.getUuid() + Utilities.getUuid()).map(b => (b + 256) % 256);
    const b = pool.pop();
    if (b < max) s += alphabet.charAt(b % alphabet.length);
  }
  return s;
}
function hash(s) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}
const clean = (s, max) => String(s == null ? "" : s).trim().slice(0, max || 80);
const normEmail = s => clean(s, 120).toLowerCase();
const isEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const escHtml = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
function publicEvent(ev) {
  return { id: ev.id, name: ev.name, budget: ev.budget, date: ev.date, status: ev.status, count: ev.participants.length };
}
// Vérifie un jeton de connexion Google et renvoie l'email du compte
// Session du site (30 jours) créée après une connexion Google, pour ne pas devoir se reconnecter à chaque visite
const SESSION_DAYS = 30;
const sessKey = t => "sess_" + hash("session:" + t).slice(0, 32);
const magicKey = t => "magic_" + hash("magic:" + t).slice(0, 32);
const MAGIC_MINUTES = 15, MAX_MAGIC_PER_HOUR = 5;
function newSession(email) {
  const token = "s." + rand(40), exp = Date.now() + SESSION_DAYS * 86400000;
  props().setProperty(sessKey(token), JSON.stringify({ e: email, x: exp }));
  return { session: token, email, exp: Math.floor(exp / 1000) };
}
function googleEmail(idToken) {
  if (!GOOGLE_CLIENT_ID) throw new Error("La connexion Google n'est pas configurée.");
  if (!idToken) throw new Error("Connecte-toi avec Google.");
  if (String(idToken).indexOf("s.") === 0) {
    const sess = JSON.parse(props().getProperty(sessKey(idToken)) || "null");
    if (!sess || sess.x < Date.now()) throw new Error("Connexion Google expirée. Reconnecte-toi.");
    return sess.e;
  }
  const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error("Connexion Google expirée. Reconnecte-toi.");
  const t = JSON.parse(res.getContentText());
  if (t.aud !== GOOGLE_CLIENT_ID || ["accounts.google.com", "https://accounts.google.com"].indexOf(t.iss) < 0 ||
      String(t.email_verified) !== "true" || Number(t.exp) * 1000 < Date.now())
    throw new Error("Connexion Google invalide. Reconnecte-toi.");
  return String(t.email).toLowerCase();
}

// Propriétaire : le compte Google qui l'a créé, ou (anciens Secret Santa) l'email organisateur identique
function isOwner(ev, email) { return !!email && (ev.owner ? ev.owner === email : normEmail(ev.orgEmail) === email); }

// ---------- Listes d'envies (une propriété par participant, hors de l'événement pour ne pas dépasser 9 Ko) ----------
const MAX_WISH = 1500;
const wishKey = (evId, pid) => "wish_" + evId + "_" + pid;
function getWish(evId, pid) { return props().getProperty(wishKey(evId, pid)) || ""; }
function setWish(evId, pid, text) {
  const w = String(text || "").replace(/\r/g, "").replace(/[\u0000-\u0009\u000b-\u001f]/g, "").trim().slice(0, MAX_WISH);
  if (w) props().setProperty(wishKey(evId, pid), normalizeWish(w).slice(0, MAX_WISH)); else props().deleteProperty(wishKey(evId, pid));
  return getWish(evId, pid);
}
// Liens de la liste d'envies : les liens courts Amazon (amzn.eu/…) sont dépliés et tous raccourcis en amazon.xx/dp/ASIN,
// ce qui permet au site d'afficher l'image du produit. (Amazon bloque la lecture de ses pages depuis les serveurs Google.)
const URL_RE = /https?:\/\/[^\s<>"']+/g;
function amazonShort(u) {
  const m = u.match(/^https?:\/\/(?:www\.)?amazon\.([a-z.]+)\/(?:[^?#]*\/)?(?:dp|gp\/product|gp\/aw\/d|exec\/obidos\/ASIN|o\/ASIN)\/([A-Z0-9]{10})/i)
    || u.match(/^https?:\/\/(?:www\.)?amazon\.([a-z.]+)\/.*[?&]asin=([A-Z0-9]{10})/i);
  return m ? "https://www.amazon." + m[1] + "/dp/" + m[2].toUpperCase() : u;
}
function expandLink(u) {
  let url = u;
  try {
    for (let i = 0; i < 3 && /^https?:\/\/(amzn\.(eu|to|com)|a\.co)\//i.test(url); i++) {
      const res = UrlFetchApp.fetch(url, { followRedirects: false, muteHttpExceptions: true });
      const loc = res.getHeaders()["Location"] || res.getHeaders()["location"];
      if (!loc) break;
      url = /^\//.test(String(loc)) ? url.match(/^https?:\/\/[^\/]+/)[0] + loc : String(loc);
    }
  } catch (e) {}
  const out = amazonShort(url);
  return out === url && url !== u && !/\/dp\//.test(out) ? u : out;
}
const normalizeWish = w => String(w || "").replace(URL_RE, u => expandLink(u.replace(/[).,;!]+$/, "")));

function deleteEventData(evId) {
  const all = props().getProperties();
  Object.keys(all).forEach(k => { if (k.indexOf("wish_" + evId + "_") === 0 || k.indexOf("pv_" + evId + "_") === 0) props().deleteProperty(k); });
  props().deleteProperty("ev_" + evId);
  props().deleteProperty("fail_" + evId);
}
// Retrouve un participant par son lien perso (token) ou son code secret (avec anti-devinette)
function findParticipant(ev, req, allowGoogle) {
  let p;
  if (allowGoogle && req.idToken && !req.token && !req.code) {
    // Connecté avec Google : on retrouve l'inscription faite avec le même email
    const email = googleEmail(req.idToken);
    p = ev.participants.find(x => x.email && normEmail(x.email) === email);
    if (!p) throw new Error("Aucune inscription avec ton compte Google dans ce Secret Santa.");
  } else if (req.token) p = ev.participants.find(x => x.token && x.token === req.token);
  else {
    if (tooManyFailures(ev.id, false)) throw new Error("Trop d'essais. Réessaie dans une heure.");
    const code = clean(req.code, 12).replace(/\D/g, ""), h = hash(ev.id + ":" + code);
    p = ev.participants.find(x => x.codeHash === h);
    if (!p) { tooManyFailures(ev.id, true); throw new Error("Code secret incorrect."); }
  }
  if (!p) throw new Error("Ce lien n'est plus valable. Utilise ton code secret.");
  return p;
}

function admin(req) {
  const ev = load(req.eventId);
  if (req.superKey) { checkSuper(req.superKey); return ev; }
  if (req.idToken) {
    if (isOwner(ev, googleEmail(req.idToken))) return ev;
    throw new Error("Ce Secret Santa n'appartient pas à ton compte Google.");
  }
  if (hash(req.adminToken) !== ev.adminHash) throw new Error("Lien organisateur invalide.");
  return ev;
}

// ---------- Super-admin : gère tous les Secret Santa (sans jamais voir les tirages) ----------
function checkSuper(key) {
  const h = props().getProperty("SUPER_KEY_HASH");
  if (!h) throw new Error("Le mot de passe administrateur n'est pas encore créé.");
  if (tooManyFailures("super", false)) throw new Error("Trop d'essais. Réessaie dans une heure.");
  if (hash("super:" + key) !== h) { tooManyFailures("super", true); throw new Error("Mot de passe administrateur incorrect."); }
}
function allEvents() {
  const all = props().getProperties(), list = [];
  Object.keys(all).forEach(k => {
    if (k.indexOf("ev_") !== 0) return;
    try { list.push(JSON.parse(all[k])); } catch (e) {}
  });
  return list.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}
function adminView(ev) {
  return Object.assign(publicEvent(ev), {
    orgEmail: ev.orgEmail,
    // « seen » dit seulement si la personne a ouvert son tirage, jamais qui elle a tiré
    participants: ev.participants.map(p => ({ id: p.id, name: p.name, email: p.email, seen: ev.status === "drawn" ? !!p.seen : undefined,
      // Inscrits à la main par l'organisateur : il gère leur liste d'envies (qu'il a lui-même écrite)
      byOrg: !!p.byOrg, wish: p.byOrg ? getWish(ev.id, p.id) : undefined })),
    exclusions: ev.exclusions,
    // Jamais le résultat du tirage : l'organisateur ne voit que le résultat de la vérification.
    verified: ev.status === "drawn" ? (() => { try { verify(ev.participants.map(p => p.id), ev.exclusions, ev.assign); return true; } catch (e) { return false; } })() : null
  });
}

function mail(to, subject, title, bodyHtml) {
  const html =
    '<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;background:#fffaf3;border-radius:16px;overflow:hidden;border:1px solid #eadfce">' +
    '<div style="background:#0e2a47;color:#fff;padding:20px;text-align:center"><div style="font-size:28px">🎁</div>' +
    '<div style="font-size:22px;font-weight:bold">Hotte <span style="color:#f4b400">Surprise</span></div></div>' +
    '<div style="padding:22px;color:#2b2522;font-size:15px;line-height:1.5"><h2 style="color:#c62828;margin-top:0">' + title + '</h2>' + bodyHtml + '</div></div>';
  if (MailApp.getRemainingDailyQuota() < 3) throw new Error("La limite d'emails du jour est atteinte. Réessaie demain.");
  MailApp.sendEmail({ to: to, subject: subject, htmlBody: html, name: "Hotte Surprise" });
}
const button = (url, label) =>
  '<p style="text-align:center;margin:22px 0"><a href="' + url + '" style="background:#c62828;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:bold">' + label + '</a></p>';

// Code secret unique dans le Secret Santa : il suffit à retrouver son tirage
function uniqueCode(ev) {
  for (let i = 0; i < 50; i++) {
    const code = rand(CODE_DIGITS, "0123456789"), h = hash(ev.id + ":" + code);
    if (!ev.participants.some(x => x.codeHash === h)) return code;
  }
  throw new Error("Impossible de générer un code, réessaie.");
}
// Anti-devinette : au-delà de 20 codes faux en 15 minutes, on bloque temporairement
function tooManyFailures(evId, add) {
  const key = "fail_" + evId, now = Date.now();
  let list = []; try { list = JSON.parse(props().getProperty(key) || "[]"); } catch (e) {}
  list = list.filter(t => now - t < 60 * 60 * 1000);
  if (add) { list.push(now); props().setProperty(key, JSON.stringify(list)); }
  return list.length >= MAX_CODE_FAILURES;
}

// ---------- Tirage ----------
function draw(ids, exclusions) {
  const forbidden = {};
  ids.forEach(id => forbidden[id] = { [id]: true });
  exclusions.forEach(([a, b]) => { if (forbidden[a]) forbidden[a][b] = true; if (forbidden[b]) forbidden[b][a] = true; });
  const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const givers = shuffle(ids), used = {}, res = {};
  const bt = i => {
    if (i === givers.length) return true;
    const g = givers[i];
    for (const r of shuffle(ids)) {
      if (used[r] || forbidden[g][r]) continue;
      used[r] = true; res[g] = r;
      if (bt(i + 1)) return true;
      delete used[r]; delete res[g];
    }
    return false;
  };
  if (!bt(0)) return null;
  verify(ids, exclusions, res);
  return res;
}

// Vérification finale : on n'enregistre jamais un tirage qui ne respecte pas toutes les règles.
function verify(ids, exclusions, res) {
  const givers = Object.keys(res), receivers = givers.map(g => res[g]);
  if (givers.length !== ids.length || ids.some(id => !(id in res)))
    throw new Error("Vérification échouée : quelqu'un n'a pas de personne à qui offrir.");
  if (new Set(receivers).size !== ids.length || receivers.some(r => ids.indexOf(r) < 0))
    throw new Error("Vérification échouée : quelqu'un a été tiré deux fois ou pas du tout.");
  if (givers.some(g => res[g] === g))
    throw new Error("Vérification échouée : quelqu'un s'est tiré lui-même.");
  if (exclusions.some(([a, b]) => res[a] === b || res[b] === a))
    throw new Error("Vérification échouée : une exclusion n'est pas respectée.");
}

// ---------- Actions ----------
const ACTIONS = {
  createEvent(req) {
    // Anti-abus : nombre de créations limité par jour (chaque création envoie un email)
    if (GOOGLE_CLIENT_ID && !req.idToken) throw new Error("Connecte-toi avec Google pour créer un Secret Santa.");
    const day = new Date().toISOString().slice(0, 10), siteKey = "day_" + day;
    const site = Number(props().getProperty(siteKey) || 0);
    if (site >= MAX_EVENTS_PER_DAY_SITE) throw new Error("Trop de Secret Santa créés aujourd'hui sur le site. Réessaie demain.");
    // Avec la connexion Google activée, il faut être connecté pour créer, et l'email du compte devient celui de l'organisateur
    const owner = GOOGLE_CLIENT_ID ? googleEmail(req.idToken) : "";
    const name = clean(req.name), orgEmail = owner || normEmail(req.orgEmail);
    const userKey = "dayu_" + day + "_" + hash(orgEmail).slice(0, 16), mine = Number(props().getProperty(userKey) || 0);
    if (mine >= MAX_EVENTS_PER_DAY) throw new Error("Tu as créé trop de Secret Santa aujourd'hui. Réessaie demain.");
    props().setProperty(siteKey, String(site + 1));
    props().setProperty(userKey, String(mine + 1));
    if (!name) throw new Error("Donne un nom au Secret Santa.");
    if (!isEmail(orgEmail)) throw new Error("Adresse email de l'organisateur invalide.");
    const ev = {
      id: rand(10), name, budget: clean(req.budget, 30), date: clean(req.date, 10), orgEmail,
      status: "open", participants: [], exclusions: [], assign: null, created: new Date().toISOString(), owner
    };
    const token = rand(24);
    ev.adminHash = hash(token);
    store(ev);
    const adminUrl = SITE + "#admin=" + ev.id + "." + token, joinUrl = SITE + "#e=" + ev.id;
    mail(orgEmail, "Ton Secret Santa « " + name + " » est créé", "C'est parti !",
      "<p>Ton Secret Santa <strong>" + escHtml(name) + "</strong> est prêt.</p>" +
      "<p>Envoie ce lien d'inscription à tous les participants :<br><a href=\"" + joinUrl + "\">" + joinUrl + "</a></p>" +
      "<p>Garde ce mail : le bouton ci-dessous est ton accès organisateur, pour suivre les inscriptions, ajouter des exclusions et lancer le tirage. Ne le partage pas.</p>" +
      button(adminUrl, "Gérer mon Secret Santa"));
    return { eventId: ev.id, adminToken: token };
  },

  getEvent(req) { return publicEvent(load(req.eventId)); },

  register(req) {
    return withLock(() => {
      const ev = load(req.eventId);
      if (ev.status !== "open") throw new Error("Les inscriptions sont fermées : le tirage a déjà eu lieu.");
      const name = clean(req.name, 40), email = normEmail(req.email);
      if (!name) throw new Error("Indique ton prénom.");
      if (!isEmail(email)) throw new Error("Adresse email invalide.");
      if (ev.participants.length >= MAX_PARTICIPANTS) throw new Error("Le nombre maximum de participants est atteint.");
      let p = ev.participants.find(x => x.email === email);
      const again = !!p;
      if (!p && ev.participants.some(x => x.name.toLowerCase() === name.toLowerCase()))
        throw new Error("Ce prénom est déjà inscrit. Ajoute l'initiale de ton nom, par exemple « " + name + " D. ».");
      if (p && p.lastMail && Date.now() - p.lastMail < 2 * 60 * 1000)
        throw new Error("Un email vient déjà d'être envoyé à cette adresse. Attends 2 minutes avant de réessayer.");
      const code = uniqueCode(ev);
      if (!p) { p = { id: rand(8), name, email }; ev.participants.push(p); }
      p.lastMail = Date.now();
      p.codeHash = hash(ev.id + ":" + code);
      p.token = rand(24);
      store(ev);
      if (req.wish != null) setWish(ev.id, p.id, req.wish);
      mail(email, "Ton inscription au Secret Santa « " + ev.name + " »", "Bienvenue " + escHtml(p.name) + " !",
        "<p>Tu es bien inscrit·e au Secret Santa <strong>" + escHtml(ev.name) + "</strong>" +
        (ev.budget ? " (budget : " + escHtml(ev.budget) + ")" : "") + ".</p>" +
        "<p>Ton code secret : <strong style=\"font-size:22px;letter-spacing:4px\">" + code + "</strong></p>" +
        "<p>Écris ou modifie ta liste d'envies à tout moment avec ce bouton (ou sur la page du Secret Santa avec ton code) :</p>" +
        button(SITE + "#e=" + ev.id + "&t=" + p.token, "🎁 Ma liste d'envies") +
        "<p>Garde ce mail. Quand l'organisateur aura lancé le tirage, tu recevras un autre email. Tu pourras aussi découvrir ton tirage à tout moment sur le site avec ce code.</p>");
      // Nouvelle inscription : le navigateur reçoit le lien perso pour voir/modifier sa liste d'envies tout de suite.
      // (Pas pour une réinscription avec un email existant, pour ne pas donner l'accès à quelqu'un d'autre.)
      return { ok: true, again, name: p.name, token: again ? undefined : p.token, mw: again ? undefined : getWish(ev.id, p.id) };
    });
  },

  reveal(req) {
    const ev = load(req.eventId);
    // Le code secret seul suffit (il est unique dans ce Secret Santa) ; connecté avec Google, l'email de l'inscription suffit
    const p = findParticipant(ev, req, true);
    if (ev.status !== "drawn") return { waiting: true, name: p.name, event: publicEvent(ev), mw: getWish(ev.id, p.id) };
    if (req.peek) return { drawn: true, seen: !!p.seen };  // simple vérification du lien, sans afficher ni marquer le tirage comme vu
    const r = ev.participants.find(x => x.id === ev.assign[p.id]);
    if (!p.seen) {
      // Note que la personne a vu son tirage (pour que l'organisateur sache qui relancer)
      try { withLock(() => { const fresh = load(ev.id), me = fresh.participants.find(x => x.id === p.id); if (me && !me.seen) { me.seen = new Date().toISOString(); store(fresh); } }); } catch (e) {}
    }
    // again : déjà ouvert une fois (sur n'importe quel appareil), le site n'affiche plus l'animation
    return { g: p.name, r: r.name, b: ev.budget, d: ev.date, e: ev.name, w: getWish(ev.id, r.id), mw: getWish(ev.id, p.id), again: !!p.seen };
  },

  // Page d'accueil, connecté avec Google : les Secret Santa où l'on est inscrit avec cet email, et sa liste d'envies
  myWishes(req) {
    const email = googleEmail(req.idToken), list = [];
    allEvents().forEach(ev => {
      const p = ev.participants.find(x => x.email && normEmail(x.email) === email);
      if (p) list.push({ eventId: ev.id, event: ev.name, name: p.name, drawn: ev.status === "drawn", mw: getWish(ev.id, p.id) });
    });
    return { list };
  },

  // Page d'accueil : retrouver son Secret Santa avec son seul code secret (pour modifier sa liste d'envies)
  findByCode(req) {
    const now = Date.now(), key = "gfail";
    let fails = []; try { fails = JSON.parse(props().getProperty(key) || "[]"); } catch (e) {}
    fails = fails.filter(t => now - t < 60 * 60 * 1000);
    if (fails.length >= MAX_FIND_FAILURES) throw new Error("Trop d'essais. Utilise plutôt le lien reçu par email, ou réessaie dans une heure.");
    const code = clean(req.code, 12).replace(/\D/g, "");
    if (code.length === CODE_DIGITS) {
      const ev = allEvents().find(e => e.participants.some(x => x.codeHash === hash(e.id + ":" + code)));
      if (ev) return { eventId: ev.id };
    }
    fails.push(now); props().setProperty(key, JSON.stringify(fails));
    throw new Error("Code secret introuvable. Vérifie-le dans l'email reçu à l'inscription.");
  },

  // Connexion : vérifie le jeton Google une fois et donne une session de 30 jours
  login(req) {
    if (String(req.idToken || "").indexOf("s.") === 0) throw new Error("Connexion Google invalide. Reconnecte-toi.");
    return newSession(googleEmail(req.idToken));
  },

  // Connexion sans Google (iCloud, Hotmail…) : lien magique à usage unique envoyé par email, valable 15 minutes
  magicLink(req) {
    const email = normEmail(req.email);
    if (!isEmail(email)) throw new Error("Adresse email invalide.");
    return withLock(() => {
      const now = Date.now(), rk = "mlr_" + hash("ml:" + email).slice(0, 16);
      let sent = []; try { sent = JSON.parse(props().getProperty(rk) || "[]"); } catch (e) {}
      sent = sent.filter(t => now - t < 60 * 60 * 1000);
      if (sent.length >= MAX_MAGIC_PER_HOUR) throw new Error("Trop de demandes pour cette adresse. Réessaie dans une heure.");
      const token = "m." + rand(40);
      props().setProperty(magicKey(token), JSON.stringify({ e: email, x: now + MAGIC_MINUTES * 60000 }));
      sent.push(now); props().setProperty(rk, JSON.stringify(sent));
      mail(email, "Ton lien de connexion à Hotte Surprise", "Connexion à Hotte Surprise",
        "<p>Clique sur ce bouton pour te connecter. Le lien marche une seule fois, pendant " + MAGIC_MINUTES + " minutes.</p>" +
        button(SITE + "#login=" + token, "Me connecter") +
        "<p style=\"color:#7a6f69;font-size:13px\">Tu n'as rien demandé ? Ignore simplement cet email.</p>");
      return { ok: true };
    });
  },
  magicLogin(req) {
    const t = String(req.token || "");
    if (t.indexOf("m.") !== 0) throw new Error("Lien de connexion invalide.");
    return withLock(() => {
      const k = magicKey(t), m = JSON.parse(props().getProperty(k) || "null");
      props().deleteProperty(k);  // usage unique
      if (!m || m.x < Date.now()) throw new Error("Ce lien de connexion a expiré ou a déjà servi. Demande-en un nouveau.");
      return newSession(m.e);
    });
  },
  logout(req) {
    if (String(req.session || "").indexOf("s.") === 0) props().deleteProperty(sessKey(req.session));
    return { ok: true };
  },

  // Aperçu dans l'éditeur : déplie les liens courts Amazon (amzn.eu/…) pour afficher la photo avant l'enregistrement
  expandLinks(req) {
    const urls = (Array.isArray(req.urls) ? req.urls : []).slice(0, 15).map(String);
    return { links: urls.map(u => /^https?:\/\/(amzn\.(eu|to|com)|a\.co)\/[^\s<>"']{1,200}$/i.test(u) ? expandLink(u) : amazonShort(u)) };
  },

  // Chaque participant modifie sa liste d'envies (avec son lien perso ou son code)
  updateWish(req) {
    const ev = load(req.eventId);
    const p = findParticipant(ev, req, true);
    return { mw: setWish(ev.id, p.id, req.wish) };
  },

  adminGet(req) { return adminView(admin(req)); },

  // Configuration publique pour le site
  config() { return { googleClientId: GOOGLE_CLIENT_ID }; },

  // Les Secret Santa du compte Google connecté (sur tous les appareils)
  myEvents(req) {
    const email = googleEmail(req.idToken);
    return { email, events: allEvents().filter(ev => isOwner(ev, email)).map(ev => Object.assign(publicEvent(ev), { created: ev.created })) };
  },

  superStatus() { return { configured: !!props().getProperty("SUPER_KEY_HASH") }; },

  // Création unique du mot de passe administrateur (refusée s'il existe déjà)
  superSetup(req) {
    return withLock(() => {
      if (props().getProperty("SUPER_KEY_HASH")) throw new Error("Le mot de passe administrateur existe déjà.");
      const key = String(req.superKey || "");
      if (key.length < 8) throw new Error("Choisis un mot de passe d'au moins 8 caractères.");
      props().setProperty("SUPER_KEY_HASH", hash("super:" + key));
      return { ok: true };
    });
  },

  superList(req) {
    checkSuper(req.superKey);
    return { events: allEvents().map(ev => Object.assign(publicEvent(ev), { orgEmail: ev.orgEmail, created: ev.created })) };
  },

  // L'organisateur (ou le super-admin) supprime définitivement son Secret Santa
  adminDelete(req) {
    return withLock(() => {
      const ev = admin(req);
      deleteEventData(ev.id);
      return { ok: true };
    });
  },

  superDelete(req) {
    checkSuper(req.superKey);
    return withLock(() => {
      load(req.eventId);
      deleteEventData(req.eventId);
      return { ok: true };
    });
  },

  // Inscription forcée par l'organisateur, sans email : le code secret est envoyé à l'organisateur.
  // L'organisateur remplit ou modifie la liste d'envies d'une personne qu'il a inscrite lui-même (avant ou après le tirage)
  adminWish(req) {
    const ev = admin(req);
    const p = ev.participants.find(x => x.id === req.participantId);
    if (!p) throw new Error("Participant introuvable.");
    if (!p.byOrg) throw new Error("Seule la personne elle-même peut modifier sa liste d'envies.");
    setWish(ev.id, p.id, req.wish);
    return adminView(ev);
  },

  adminAdd(req) {
    return withLock(() => {
      const ev = admin(req);
      if (ev.status !== "open") throw new Error("Le tirage a déjà eu lieu.");
      const name = clean(req.name, 40);
      if (!name) throw new Error("Indique un prénom.");
      if (ev.participants.length >= MAX_PARTICIPANTS) throw new Error("Le nombre maximum de participants est atteint.");
      if (ev.participants.some(x => x.name.toLowerCase() === name.toLowerCase()))
        throw new Error("« " + name + " » est déjà inscrit. Ajoute l'initiale du nom, par exemple « " + name + " D. ».");
      const code = uniqueCode(ev);
      const p = { id: rand(8), name, email: "", codeHash: hash(ev.id + ":" + code), token: rand(24), byOrg: true };
      ev.participants.push(p);
      store(ev);
      if (req.wish) setWish(ev.id, p.id, req.wish);
      mail(ev.orgEmail, "Tu as inscrit " + name + " au Secret Santa « " + ev.name + " »", "Inscription de " + escHtml(name),
        "<p>Tu as bien inscrit <strong>" + escHtml(name) + "</strong> au Secret Santa <strong>" + escHtml(ev.name) + "</strong>.</p>" +
        "<p>Voici son code secret, qui lui servira à découvrir son tirage : <strong style=\"font-size:22px;letter-spacing:4px\">" + code + "</strong></p>" +
        "<p>Transmets-le-lui avec ce lien. Après le tirage, il ou elle n'aura qu'à entrer ce code sur cette page :<br>" +
        "<a href=\"" + SITE + "#e=" + ev.id + "\">" + SITE + "#e=" + ev.id + "</a></p>" +
        "<p style=\"color:#7a6f69;font-size:13px\">Pour garder la surprise, évite de l'utiliser toi-même 😉</p>");
      return adminView(ev);
    });
  },

  adminUpdate(req) {
    return withLock(() => {
      const ev = admin(req);
      if (ev.status !== "open") throw new Error("Le tirage a déjà eu lieu.");
      const ids = ev.participants.map(p => p.id);
      if (req.exclusions) ev.exclusions = req.exclusions.filter(([a, b]) => a !== b && ids.indexOf(a) >= 0 && ids.indexOf(b) >= 0);
      if (req.removeId) {
        ev.participants = ev.participants.filter(p => p.id !== req.removeId);
        ev.exclusions = ev.exclusions.filter(x => x.indexOf(req.removeId) < 0);
        props().deleteProperty(wishKey(ev.id, req.removeId));
      }
      ["name", "budget", "date"].forEach(k => { if (req[k] != null) ev[k] = clean(req[k], k === "name" ? 80 : 30); });
      if (req.date != null) ev.reminded = false;
      store(ev);
      return adminView(ev);
    });
  },

  adminDraw(req) {
    return withLock(() => {
      const ev = admin(req);
      if (ev.status !== "open") throw new Error("Le tirage a déjà eu lieu.");
      if (ev.participants.length < 3) throw new Error("Il faut au moins 3 participants.");
      const res = draw(ev.participants.map(p => p.id), ev.exclusions);
      if (!res) throw new Error("Impossible de faire un tirage avec ces exclusions. Retires-en une et réessaie.");
      ev.assign = res; ev.status = "drawn"; ev.drawnAt = new Date().toISOString();
      store(ev);
      let sent = 0, failed = [];
      const noEmail = ev.participants.filter(p => !p.email).map(p => p.name);
      ev.participants.forEach(p => {
        if (!p.email) return;
        try {
          mail(p.email, "🎁 Ton tirage du Secret Santa « " + ev.name + " »", "Le tirage est fait, " + escHtml(p.name) + " !",
            "<p>Clique sur le bouton pour découvrir à qui tu offres un cadeau, avec sa liste d'envies et des idées cadeaux. Vérifie que personne ne regarde ton écran 🤫</p>" +
            button(SITE + "#e=" + ev.id + "&t=" + p.token, "Découvrir mon tirage") +
            "<p style=\"color:#7a6f69;font-size:13px\">Tu peux aussi aller sur " + SITE + "#e=" + ev.id + " et entrer le code secret reçu à l'inscription.</p>");
          sent++;
        } catch (err) { failed.push(p.name); }
      });
      if (noEmail.length) {
        try {
          mail(ev.orgEmail, "Tirage fait : à transmettre à " + noEmail.join(", "), "Le tirage est fait !",
            "<p>Ces personnes n'ont pas d'email : <strong>" + escHtml(noEmail.join(", ")) + "</strong>.</p>" +
            "<p>Préviens-les qu'elles peuvent découvrir leur tirage sur le site avec <strong>le code secret</strong> que tu as reçu lors de leur inscription :</p>" +
            button(SITE + "#e=" + ev.id, "Page du Secret Santa"));
        } catch (err) {}
      }
      return Object.assign(adminView(ev), { sent, failed, noEmail });
    });
  },

  adminResend(req) {
    const ev = admin(req);
    if (ev.status !== "drawn") throw new Error("Le tirage n'a pas encore eu lieu.");
    const p = ev.participants.find(x => x.id === req.participantId);
    if (!p) throw new Error("Participant introuvable.");
    if (!p.email) throw new Error(p.name + " n'a pas d'email : il découvre son tirage sur le site avec son code.");
    sendDrawReminder(ev, p);
    return { ok: true };
  },

  // Relance par email tous ceux qui n'ont pas encore ouvert leur tirage
  adminRemindUnseen(req) {
    const ev = admin(req);
    if (ev.status !== "drawn") throw new Error("Le tirage n'a pas encore eu lieu.");
    const todo = ev.participants.filter(p => !p.seen && p.email);
    let sent = 0;
    todo.forEach(p => { try { sendDrawReminder(ev, p); sent++; } catch (e) {} });
    return { sent, noEmail: ev.participants.filter(p => !p.seen && !p.email).map(p => p.name) };
  }
};
function sendDrawReminder(ev, p) {
  mail(p.email, "🎁 Rappel : découvre ton tirage du Secret Santa « " + ev.name + " »", "Psst, " + escHtml(p.name) + " !",
    (p.seen ? "<p>Voici à nouveau ton lien pour revoir ton tirage.</p>"
            : "<p>Tu n'as pas encore découvert à qui tu offres un cadeau. Clique vite sur le bouton 🤫</p>") +
    button(SITE + "#e=" + ev.id + "&t=" + p.token, "Découvrir mon tirage"));
}
// À lancer depuis l'éditeur pour accorder toutes les autorisations (emails, service externe, déclencheurs)
function autoriser() {
  UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=test", { muteHttpExceptions: true });
  ScriptApp.getProjectTriggers();
  MailApp.getRemainingDailyQuota();
  Logger.log("Autorisations OK");
}
// ===== RAPPELS (déclencheur quotidien) =====
// À lancer une seule fois depuis l'éditeur : crée le déclencheur qui exécute sendReminders chaque matin.
function installReminders() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === "sendReminders") ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendReminders").timeBased().everyDays(1).atHour(9).inTimezone("Europe/Paris").create();
}
function daysUntil(date) {
  const today = Utilities.formatDate(new Date(), "Europe/Paris", "yyyy-MM-dd");
  return Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
}
// Envoie le rappel « J-7 » (rattrapé jusqu'au jour J si le déclencheur a manqué un jour)
function sendReminders() {
  // Ménage : les compteurs de créations des jours passés ne servent plus
  const today = new Date().toISOString().slice(0, 10), all = props().getProperties();
  Object.keys(all).forEach(k => {
    if (/^dayu?_/.test(k) && k.indexOf(today) < 0) props().deleteProperty(k);
    if (k.indexOf("mlr_") === 0) { try { if (Math.max.apply(null, JSON.parse(all[k]).concat([0])) < Date.now() - 3600000) props().deleteProperty(k); } catch (e) { props().deleteProperty(k); } }
    if (k.indexOf("sess_") === 0 || k.indexOf("magic_") === 0) { try { if (JSON.parse(all[k]).x < Date.now()) props().deleteProperty(k); } catch (e) { props().deleteProperty(k); } }
  });
  allEvents().forEach(ev => {
    if (!ev.date || ev.reminded || !/^\d{4}-\d{2}-\d{2}$/.test(ev.date)) return;
    const d = daysUntil(ev.date);
    if (d < 0 || d > 7) return;
    const when = d === 0 ? "aujourd'hui" : d === 1 ? "demain" : "dans " + d + " jours";
    const budget = ev.budget ? "<p>💰 Budget : <strong>" + escHtml(ev.budget) + "</strong></p>" : "";
    try {
      if (ev.status === "drawn") {
        ev.participants.forEach(p => {
          if (!p.email) return;
          try {
            mail(p.email, "⏰ Secret Santa « " + ev.name + " » " + when + " !", (d === 0 ? "C'est le grand jour, " : "Plus que " + d + " jour" + (d > 1 ? "s" : "") + ", ") + escHtml(p.name) + " !",
              "<p>L'échange de cadeaux du Secret Santa a lieu <strong>" + when + "</strong>. As-tu trouvé ton cadeau ? 🎁</p>" + budget +
              button(SITE + "#e=" + ev.id + "&t=" + p.token, "Revoir à qui j'offre"));
          } catch (err) {}
        });
        mail(ev.orgEmail, "⏰ Secret Santa « " + ev.name + " » " + when, "Rappel envoyé !",
          "<p>Les participants avec un email ont reçu un rappel : l'échange a lieu <strong>" + when + "</strong>.</p>" +
          (ev.participants.some(p => !p.email) ? "<p>Pense à prévenir ceux qui n'ont pas d'email : <strong>" + escHtml(ev.participants.filter(p => !p.email).map(p => p.name).join(", ")) + "</strong>.</p>" : ""));
      } else {
        mail(ev.orgEmail, "⏰ Secret Santa « " + ev.name + " » : le tirage n'est pas fait", "L'échange a lieu " + when + " !",
          "<p>Le tirage n'a pas encore été lancé (" + ev.participants.length + " inscrit" + (ev.participants.length > 1 ? "s" : "") + "). Pense à le faire vite pour laisser le temps à chacun de trouver un cadeau.</p>");
      }
    } catch (err) {}
    ev.reminded = true;
    try { store(ev); } catch (err) {}
  });
}
// À lancer depuis l'éditeur (menu des fonctions) pour remettre à zéro les compteurs de créations du jour
function debloquerCreations() {
  const all = props().getProperties();
  Object.keys(all).forEach(k => { if (/^dayu?_/.test(k)) props().deleteProperty(k); });
}
// À lancer depuis l'éditeur (menu des fonctions) pour remettre à zéro les compteurs de créations du jour
function debloquerCreations() {
  const all = props().getProperties();
  Object.keys(all).forEach(k => { if (/^dayu?_/.test(k)) props().deleteProperty(k); });
}
// ===== FIN =====
