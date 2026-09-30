const http = require("http");
const crypto = require("crypto");
const fs = require("fs");

const DB_FILE = __dirname + "/db.json";
const UPLOAD_DIR = __dirname + "/uploads";
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

let db = fs.existsSync(DB_FILE) ? JSON.parse(fs.readFileSync(DB_FILE))
  : { users: {}, tokens: {}, messages: [], mid: 0, dm: {}, dmid: 0, typing: {} };
if (!db.messages) db.messages = [];
if (!db.mid) db.mid = 0;
if (!db.dm) db.dm = {};
if (!db.dmid) db.dmid = 0;
if (!db.typing) db.typing = {};
const save = () => fs.writeFileSync(DB_FILE, JSON.stringify(db));
const hash = (p, s) => crypto.scryptSync(p, s, 64).toString("hex");
const now = () => Date.now();
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9а-яё]/gi, "");
const pairKey = (a, b) => [a, b].sort().join("|");
const touch = (login) => { if (db.users[login]) db.users[login].lastSeen = now(); };

const LIM = { image: 4000000, video: 20000000, voice: 2000000, audio: 20000000 };
const mediaOk = (m) => {
  if (!m || !m.type || !m.data) return false;
  const lim = LIM[m.type];
  return lim ? String(m.data).length <= lim : false;
};
const storeMedia = (m) => {
  if (!m || !m.data) return m;
  try {
    const id = crypto.randomBytes(8).toString("hex");
    fs.writeFileSync(UPLOAD_DIR + "/" + id, Buffer.from(String(m.data), "base64"));
    const out = { type: m.type, file: id };
    if (m.dur) out.dur = m.dur;
    if (m.name) out.name = m.name;
    return out;
  } catch (e) { return m; }
};
const loadMedia = (m) => {
  if (!m || m.data) return m;
  if (m.file) {
    try {
      const b = fs.readFileSync(UPLOAD_DIR + "/" + m.file);
      const out = { type: m.type, data: b.toString("base64") };
      if (m.dur) out.dur = m.dur;
      if (m.name) out.name = m.name;
      return out;
    } catch (e) { return { type: m.type, data: "" }; }
  }
  return m;
};

const send = (res, code, obj) => {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((ok) => {
  let d = "";
  req.on("data", (c) => (d += c));
  req.on("end", () => { try { ok(JSON.parse(d || "{}")); } catch { ok({}); } });
});
const q = (req, key) => {
  const m = req.url.split(key + "=")[1];
  return m ? decodeURIComponent(m.split("&")[0]) : "";
};

const main = async (req, res) => {
  const url = req.url.split("?")[0];

  if (req.method === "GET" && url === "/")
    return send(res, 200, { ok: true, name: "Gode on the Go ☯", big: true });

  if (req.method === "POST" && url === "/register") {
    const { login, password } = await readBody(req);
    const low = String(login || "").trim().toLowerCase();
    if (!low || !password) return send(res, 400, { error: "Введите логин и пароль" });
    if (Object.keys(db.users).some((u) => norm(u) === norm(low)))
      return send(res, 409, { error: "Юз занят или слишком похож на существующий" });
    const salt = crypto.randomBytes(16).toString("hex");
    db.users[low] = { salt, hash: hash(password, salt), name: low, bio: "", avatar: "", lastSeen: now() };
    save();
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url === "/login") {
    const { login, password } = await readBody(req);
    const low = String(login || "").trim().toLowerCase();
    const u = db.users[low];
    if (!u || hash(password || "", u.salt) !== u.hash)
      return send(res, 401, { error: "Неверный логин или пароль" });
    const token = crypto.randomBytes(24).toString("hex");
    db.tokens[token] = low;
    u.lastSeen = now();
    save();
    return send(res, 200, { ok: true, token, login: low });
  }

  if (req.method === "GET" && url === "/users") {
    const me = db.tokens[q(req, "token")];
    if (!me) return send(res, 401, { error: "Не авторизован" });
    touch(me); save();
    return send(res, 200, {
      users: Object.entries(db.users).map(([login, u]) => ({
        login, name: u.name || login, lastSeen: u.lastSeen || 0
      }))
    });
  }

  if (req.method === "GET" && url === "/profile") {
    const who = q(req, "login");
    const u = db.users[who];
    if (!u) return send(res, 404, { error: "Нет такого пользователя" });
    return send(res, 200, { ok: true, name: u.name || who, bio: u.bio || "",
      avatar: u.avatar || "", lastSeen: u.lastSeen || 0,
      banner: loadMedia(u.banner) || null, music: loadMedia(u.music) || null });
  }

  if (req.method === "POST" && url === "/profile/set") {
    const { token, name, bio, avatar, banner, music } = await readBody(req);
    const who = db.tokens[token];
    if (!who) return send(res, 401, { error: "Не авторизован" });
    const u = db.users[who];
    if (name !== undefined) u.name = String(name).slice(0, 40);
    if (bio !== undefined) u.bio = String(bio).slice(0, 300);
    if (avatar !== undefined) u.avatar = String(avatar).slice(0, 1500000);
    if (banner !== undefined) {
      if (banner === null) u.banner = null;
      else if (banner.data && String(banner.data).length <=
          (banner.type === "video" ? 20000000 : 4000000)) u.banner = storeMedia(banner);
    }
    if (music !== undefined) {
      if (music === null) u.music = null;
      else if (music.data && String(music.data).length <= 20000000) u.music = storeMedia(music);
    }
    touch(who); save();
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url === "/profile/rename") {
    const { token, newLogin } = await readBody(req);
    const who = db.tokens[token];
    if (!who) return send(res, 401, { error: "Не авторизован" });
    const low = String(newLogin || "").trim().toLowerCase();
    if (!low) return send(res, 400, { error: "Пустой юз" });
    if (low === who) return send(res, 200, { ok: true, login: low });
    if (Object.keys(db.users).some((u) => u !== who && norm(u) === norm(low)))
      return send(res, 409, { error: "Юз занят или слишком похож на существующий" });
    db.users[low] = db.users[who];
    delete db.users[who];
    for (const t of Object.keys(db.tokens)) if (db.tokens[t] === who) db.tokens[t] = low;
    for (const m of db.messages) if (m.login === who) m.login = low;
    const newDm = {};
    for (const key of Object.keys(db.dm)) {
      const parts = key.split("|").map((p) => (p === who ? low : p));
      newDm[parts.sort().join("|")] = (db.dm[key] || []).map((m) => {
        if (m.from === who) m.from = low;
        return m;
      });
    }
    db.dm = newDm;
    db.typing = {};
    save();
    return send(res, 200, { ok: true, login: low });
  }

  if (req.method === "GET" && url === "/messages") {
    const me = db.tokens[q(req, "token")];
    if (me) { touch(me); save(); }
    const since = parseInt(req.url.split("since=")[1] || "0", 10) || 0;
    return send(res, 200, {
      messages: db.messages.filter((m) => m.id > since)
        .map((m) => ({ ...m, media: loadMedia(m.media) }))
    });
  }

  if (req.method === "POST" && url === "/messages/send") {
    const { token, text, media } = await readBody(req);
    const who = db.tokens[token];
    if (!who) return send(res, 401, { error: "Не авторизован" });
    const t = String(text || "").slice(0, 1000);
    if ((!t || !t.trim()) && !media) return send(res, 400, { error: "Пустое сообщение" });
    if (media && !mediaOk(media)) return send(res, 413, { error: "Файл слишком большой" });
    db.messages.push({ id: ++db.mid, login: who, text: t, time: now(),
      media: media ? storeMedia(media) : null });
    if (db.messages.length > 500) db.messages = db.messages.slice(-500);
    touch(who); save();
    return send(res, 200, { ok: true, id: db.mid });
  }

  if (req.method === "POST" && url === "/messages/delete") {
    const { token, id } = await readBody(req);
    const who = db.tokens[token];
    if (!who) return send(res, 401, { error: "Не авторизован" });
    const m = db.messages.find((x) => x.id === id);
    if (!m) return send(res, 404, { error: "Не найдено" });
    if (m.login !== who) return send(res, 403, { error: "Только свои сообщения" });
    m.deleted = true; m.text = ""; m.media = null;
    save();
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url === "/typing") {
    const { token, to } = await readBody(req);
    const who = db.tokens[token];
    if (!who || !to) return send(res, 401, { error: "Не авторизован" });
    db.typing[pairKey(who, to)] = { who, t: now() };
    return send(res, 200, { ok: true });
  }

  if (req.method === "POST" && url === "/dm/send") {
    const { token, to, text, media } = await readBody(req);
    const from = db.tokens[token];
    if (!from) return send(res, 401, { error: "Не авторизован" });
    if (!db.users[to]) return send(res, 404, { error: "Нет такого пользователя" });
    const t = String(text || "").slice(0, 1000);
    if ((!t || !t.trim()) && !media) return send(res, 400, { error: "Пустое сообщение" });
    if (media && !mediaOk(media)) return send(res, 413, { error: "Файл слишком большой" });
    const key = pairKey(from, to);
    if (!db.dm[key]) db.dm[key] = [];
    db.dm[key].push({ id: ++db.dmid, from, text: t, time: now(),
      media: media ? storeMedia(media) : null });
    if (db.dm[key].length > 500) db.dm[key] = db.dm[key].slice(-500);
    touch(from); save();
    return send(res, 200, { ok: true, id: db.dmid });
  }

  if (req.method === "GET" && url === "/dm/get") {
    const me = db.tokens[q(req, "token")];
    if (!me) return send(res, 401, { error: "Не авторизован" });
    const withWho = q(req, "with");
    const since = parseInt(req.url.split("since=")[1] || "0", 10) || 0;
    const key = pairKey(me, withWho);
    const t = db.typing[key];
    const typing = !!(t && t.who !== me && now() - t.t < 5000);
    touch(me); save();
    return send(res, 200, {
      messages: (db.dm[key] || []).filter((m) => m.id > since)
        .map((m) => ({ ...m, media: loadMedia(m.media) })),
      typing,
      lastSeen: db.users[withWho] ? db.users[withWho].lastSeen || 0 : 0
    });
  }

  if (req.method === "GET" && url === "/dm/dialogs") {
    const me = db.tokens[q(req, "token")];
    if (!me) return send(res, 401, { error: "Не авторизован" });
    touch(me);
    const dialogs = [];
    for (const key of Object.keys(db.dm)) {
      if (!key.split("|").includes(me)) continue;
      const arr = db.dm[key];
      if (!arr.length) continue;
      const last = arr[arr.length - 1];
      dialogs.push({ with: key.split("|").find((x) => x !== me),
        lastText: last.deleted ? "🗑 сообщение удалено"
          : (last.media ? { image: "📷 Фото", video: "🎬 Видео", voice: "🎙 ГС", audio: "🎵" }[last.media.type] || "..." : last.text),
        lastTime: last.time, lastFrom: last.from });
    }
    dialogs.sort((a, b) => b.lastTime - a.lastTime);
    save();
    return send(res, 200, { dialogs });
  }

  if (req.method === "POST" && url === "/dm/delete") {
    const { token, id, with: withWho } = await readBody(req);
    const me = db.tokens[token];
    if (!me) return send(res, 401, { error: "Не авторизован" });
    const arr = db.dm[pairKey(me, withWho)] || [];
    const m = arr.find((x) => x.id === id);
    if (!m) return send(res, 404, { error: "Не найдено" });
    if (m.from !== me) return send(res, 403, { error: "Только свои сообщения" });
    m.deleted = true; m.text = ""; m.media = null;
    save();
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: "Не найдено" });
};

http.createServer((req, res) => {
  main(req, res).catch((e) => {
    console.log("HANDLER ERR:", e.message);
    try { send(res, 500, { error: "Сервер: " + e.message }); } catch (_) {}
  });
}).listen(process.env.PORT || 3000, "0.0.0.0", () =>
  console.log("Сервер запущен (BIG): http://127.0.0.1:3000"));
