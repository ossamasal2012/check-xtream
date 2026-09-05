const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

function send(res, code, type, body) {
  res.writeHead(code, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(body);
}

function json(res, code, obj) {
  send(res, code, "application/json; charset=utf-8", JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", c => {
      b += c;
      if (b.length > 100000) req.destroy();
    });
    req.on("end", () => {
      try { resolve(JSON.parse(b || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function checkXtream(body) {
  let { host, username, password, timeout = 12000 } = body;
  if (!host || !username || !password) return {status:"invalid", error:"Missing host, username or password"};
  try {
    const u = new URL(host);
    if (!["http:","https:"].includes(u.protocol)) throw Error("Only HTTP/HTTPS is supported");
    u.pathname = "/player_api.php";
    u.search = new URLSearchParams({username, password}).toString();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(Math.max(Number(timeout)||12000,2000),60000));
    let r;
    try {
      r = await fetch(u, {
        signal: controller.signal,
        redirect: "follow",
        headers: {"User-Agent":"Xtream-Checker/1.0"}
      });
    } finally { clearTimeout(timer); }

    const text = await r.text();
    if (!r.ok) return {status:"unreachable", error:`HTTP ${r.status}`};

    let data;
    try { data = JSON.parse(text); }
    catch { return {status:"unreachable", error:"Response is not valid JSON"}; }

    const ui = data.user_info || {};
    const auth = Number(ui.auth);
    const status = String(ui.status || "").toLowerCase();

    if (auth !== 1) return {status:"auth_error", error:"Xtream API rejected authentication"};
    if (status && !["active","enabled"].includes(status)) {
      if (["banned","disabled","blocked"].includes(status)) return {status:"blocked", error:`Account status: ${status}`};
      return {status:"auth_error", error:`Account status: ${status}`};
    }

    let exp = ui.exp_date;
    if (exp !== null && exp !== undefined && exp !== "") exp = Number(exp);
    else exp = null;

    if (exp && exp * 1000 < Date.now()) {
      return {
        status:"expired",
        exp_date:exp,
        account:{username:ui.username || username,status:ui.status,created_at:ui.created_at||null,max_connections:ui.max_connections||null},
        server:data.server_info||null
      };
    }

    return {
      status:"active",
      exp_date:exp,
      account:{username:ui.username || username,status:ui.status,created_at:ui.created_at||null,max_connections:ui.max_connections||null},
      server:data.server_info||null
    };
  } catch (e) {
    if (e.name === "AbortError") return {status:"timeout", error:"Request timed out"};
    return {status:"unreachable", error:e.message || "Connection failed"};
  }
}

const server = http.createServer(async (req,res) => {
  if (req.method === "POST" && req.url === "/api/check") {
    try {
      const body = await readBody(req);
      return json(res,200,await checkXtream(body));
    } catch (e) {
      return json(res,400,{status:"invalid",error:"Invalid JSON"});
    }
  }

  if (req.method === "GET") {
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    const file = pathname === "/" ? "index.html" : pathname.replace(/^\/+/,"");
    const full = path.resolve(ROOT,file);
    if (!full.startsWith(path.resolve(ROOT)) || !fs.existsSync(full)) return send(res,404,"text/plain","Not found");
    const ext=path.extname(full);
    const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
    return send(res,200,types[ext]||"application/octet-stream",fs.readFileSync(full));
  }
  json(res,405,{error:"Method not allowed"});
});

server.listen(PORT,()=>console.log(`Xtream Checker running on http://localhost:${PORT}`));