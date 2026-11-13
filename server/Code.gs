// Hotte Surprise : petit serveur Secret Santa sur Google Apps Script.
// Déploiement : Déployer > Nouveau déploiement > Application Web
//   Exécuter en tant que : Moi · Qui a accès : Tout le monde
// FIN DU FICHIER : la dernière ligne est « // ===== RAPPELS (déclencheur quotidien) =====
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
// ===== FIN ===== ».
const SITE = "https://michael-jai.github.io/hotte-surprise/";
const CODE_DIGITS = 6;          // longueur du code secret envoyé à chaque participant
const MAX_PARTICIPANTS = 40;     // limite liée à la taille de stockage (9 Ko par Secret Santa)
const MAX_EVENTS_PER_DAY = 10;   // anti-abus : créations de Secret Santa par jour sur tout le site
const MAX_CODE_FAILURES = 10;
// Connexion Google pour les organisateurs : ID client OAuth (public). Vide = création libre sans connexion.
const GOOGLE_CLIENT_ID = "";    // anti-devinette : codes faux tolérés par heure et par Secret Santa

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
function googleEmail(idToken) {
  if (!GOOGLE_CLIENT_ID) throw new Error("La connexion Google n'est pas configurée.");
  if (!idToken) throw new Error("Connecte-toi avec Google.");
  const res = UrlFetchApp.fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(idToken), { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error("Connexion Google expirée. Reconnecte-toi.");
  const t = JSON.parse(res.getContentText());
  if (t.aud !== GOOGLE_CLIENT_ID || ["accounts.google.com", "https://accounts.google.com"].indexOf(t.iss) < 0 ||
      String(t.email_verified) !== "true" || Number(t.exp) * 1000 < Date.now())
    throw new Error("Connexion Google invalide. Reconnecte-toi.");
  return String(t.email).toLowerCase();
}

function admin(req) {
  const ev = load(req.eventId);
  if (req.superKey) { checkSuper(req.superKey); return ev; }
  if (req.idToken) {
    if (ev.owner && googleEmail(req.idToken) === ev.owner) return ev;
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
    participants: ev.participants.map(p => ({ id: p.id, name: p.name, email: p.email })),
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
    const dayKey = "day_" + new Date().toISOString().slice(0, 10);
    const today = Number(props().getProperty(dayKey) || 0);
    if (today >= MAX_EVENTS_PER_DAY) throw new Error("Trop de Secret Santa créés aujourd'hui. Réessaie demain.");
    props().setProperty(dayKey, String(today + 1));
    // Avec la connexion Google activée, il faut être connecté pour créer, et l'email du compte devient celui de l'organisateur
    const owner = GOOGLE_CLIENT_ID ? googleEmail(req.idToken) : "";
    const name = clean(req.name), orgEmail = owner || normEmail(req.orgEmail);
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
      mail(email, "Ton inscription au Secret Santa « " + ev.name + " »", "Bienvenue " + escHtml(p.name) + " !",
        "<p>Tu es bien inscrit·e au Secret Santa <strong>" + escHtml(ev.name) + "</strong>" +
        (ev.budget ? " (budget : " + escHtml(ev.budget) + ")" : "") + ".</p>" +
        "<p>Ton code secret : <strong style=\"font-size:22px;letter-spacing:4px\">" + code + "</strong></p>" +
        "<p>Garde ce mail. Quand l'organisateur aura lancé le tirage, tu recevras un autre email. Tu pourras aussi découvrir ton tirage à tout moment sur le site avec ce code.</p>" +
        button(SITE + "#e=" + ev.id, "Voir le Secret Santa"));
      return { ok: true, again, name: p.name };
    });
  },

  reveal(req) {
    const ev = load(req.eventId);
    let p;
    if (req.token) p = ev.participants.find(x => x.token && x.token === req.token);
    else {
      // Le code secret seul suffit (il est unique dans ce Secret Santa)
      if (tooManyFailures(ev.id, false)) throw new Error("Trop d'essais. Réessaie dans une heure.");
      const code = clean(req.code, 12).replace(/\D/g, ""), h = hash(ev.id + ":" + code);
      p = ev.participants.find(x => x.codeHash === h);
      if (!p) { tooManyFailures(ev.id, true); throw new Error("Code secret incorrect."); }
    }
    if (!p) throw new Error("Ce lien n'est plus valable. Utilise ton code secret.");
    if (ev.status !== "drawn") return { waiting: true, name: p.name, event: publicEvent(ev) };
    const r = ev.participants.find(x => x.id === ev.assign[p.id]);
    return { g: p.name, r: r.name, b: ev.budget, d: ev.date, e: ev.name };
  },

  adminGet(req) { return adminView(admin(req)); },

  // Configuration publique pour le site
  config() { return { googleClientId: GOOGLE_CLIENT_ID }; },

  // Les Secret Santa du compte Google connecté (sur tous les appareils)
  myEvents(req) {
    const email = googleEmail(req.idToken);
    return { email, events: allEvents().filter(ev => ev.owner === email).map(ev => Object.assign(publicEvent(ev), { created: ev.created })) };
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

  superDelete(req) {
    checkSuper(req.superKey);
    return withLock(() => {
      load(req.eventId);
      props().deleteProperty("ev_" + req.eventId);
      props().deleteProperty("fail_" + req.eventId);
      return { ok: true };
    });
  },

  // Inscription forcée par l'organisateur, sans email : le code secret est envoyé à l'organisateur.
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
            "<p>Clique sur le bouton pour découvrir à qui tu offres un cadeau. Vérifie que personne ne regarde ton écran 🤫</p>" +
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
    mail(p.email, "🎁 Ton tirage du Secret Santa « " + ev.name + " »", "Rappel, " + escHtml(p.name) + " !",
      "<p>Voici à nouveau ton lien pour découvrir ton tirage.</p>" + button(SITE + "#e=" + ev.id + "&t=" + p.token, "Découvrir mon tirage"));
    return { ok: true };
  }
};
// ===== FIN =====
