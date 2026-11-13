// Hotte Surprise : petit serveur Secret Santa sur Google Apps Script.
// Déploiement : Déployer > Nouveau déploiement > Application Web
//   Exécuter en tant que : Moi · Qui a accès : Tout le monde
// FIN DU FICHIER : la dernière ligne est « // ===== FIN ===== ».
const SITE = "https://michael-jai.github.io/hotte-surprise/";
const CODE_DIGITS = 6;          // longueur du code secret envoyé à chaque participant
const MAX_PARTICIPANTS = 60;

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
function store(ev) { props().setProperty("ev_" + ev.id, JSON.stringify(ev)); }
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------- Outils ----------
function rand(n, alphabet) {
  alphabet = alphabet || "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
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
function admin(req) {
  const ev = load(req.eventId);
  if (hash(req.adminToken) !== ev.adminHash) throw new Error("Lien organisateur invalide.");
  return ev;
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
  list = list.filter(t => now - t < 15 * 60 * 1000);
  if (add) { list.push(now); props().setProperty(key, JSON.stringify(list)); }
  return list.length >= 20;
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
    const name = clean(req.name), orgEmail = normEmail(req.orgEmail);
    if (!name) throw new Error("Donne un nom au Secret Santa.");
    if (!isEmail(orgEmail)) throw new Error("Adresse email de l'organisateur invalide.");
    const ev = {
      id: rand(10), name, budget: clean(req.budget, 30), date: clean(req.date, 10), orgEmail,
      status: "open", participants: [], exclusions: [], assign: null, created: new Date().toISOString()
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
      const code = uniqueCode(ev);
      if (!p) { p = { id: rand(8), name, email }; ev.participants.push(p); }
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
      if (tooManyFailures(ev.id, false)) throw new Error("Trop d'essais. Réessaie dans 15 minutes.");
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
