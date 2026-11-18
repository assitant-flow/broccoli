/**
 * Broccoli 白名单 egress proxy（FR-H2）。
 * 沙箱容器唯一出口：HTTPS CONNECT 按 {阶段: [允许域名]} 白名单过滤；
 * 判定逐条写审计日志（stdout）。阶段由挂载卷中的 current-phase 文件驱动（Runner 侧改写）。
 * 说明：MVP 以 proxy env + 白名单代理实现；进程绕过代理 env 的直连路径由
 * 容器 internal 网络 + v2 透明拦截（Linux iptables）收敛（design §12 残余风险已声明）。
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");

const STATE_DIR = process.env.STATE_DIR || "/state";
const PHASE_FILE = path.join(STATE_DIR, "current-phase");
const ALLOWLIST = JSON.parse(fs.readFileSync(path.join(__dirname, "allowlist.json"), "utf8"));

let phase = "execute";
try {
  phase = fs.readFileSync(PHASE_FILE, "utf8").trim() || "execute";
} catch {
  /* 默认 execute */
}
function refreshPhase() {
  try {
    const next = fs.readFileSync(PHASE_FILE, "utf8").trim();
    if (next && next !== phase) {
      phase = next;
      console.log(`[egress][audit] phase=${phase}`);
    }
  } catch {
    /* 保持原阶段 */
  }
}
fs.watchFile(PHASE_FILE, { interval: 500 }, refreshPhase);

function hostAllowed(host) {
  const list = ALLOWLIST[phase] || [];
  return list.some((d) => host === d || host.endsWith(`.${d}`));
}
function audit(host, allowed, kind) {
  console.log(`[egress][audit] ${new Date().toISOString()} ${kind} ${host} -> ${allowed ? "ALLOW" : "DENY"} (phase=${phase})`);
}

const server = http.createServer((req, res) => {
  // 非 CONNECT 的明文代理请求：按 Host 头判定后一律断开（当前容器内出站均为 HTTPS/CONNECT）
  const host = (req.headers.host || "").split(":")[0];
  audit(host, hostAllowed(host), "plain");
  res.destroy();
});

server.on("connect", (req, socket, head) => {
  const host = (req.headers.host || "").split(":")[0];
  const allowed = hostAllowed(host);
  audit(host, allowed, "connect");
  if (!allowed) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  const upstream = net.connect(443, host, () => {
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head?.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
  socket.setTimeout(60000, () => {
    socket.destroy();
    upstream.destroy();
  });
});

server.listen(8080, () => console.log(`[egress] proxy listening :8080 phase=${phase}`));
