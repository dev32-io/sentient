#!/usr/bin/env node
/** Capture canonical SVG states at deterministic animation times in Chromium. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, globSync } from 'node:fs';

function browser() {
  if (process.env.SENTIENT_RIVE_BROWSER) return process.env.SENTIENT_RIVE_BROWSER;
  for (const candidate of [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ]) if (existsSync(candidate)) return candidate;
  for (const root of [join(homedir(), 'Library/Caches/ms-playwright'), join(homedir(), '.cache/ms-playwright')]) {
    const candidates = [
      ...globSync('chromium-*/chrome-mac-*/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', { cwd: root }),
      ...globSync('chromium-*/chrome-linux/chrome', { cwd: root }),
    ].sort().reverse();
    if (candidates.length) return join(root, candidates[0]);
  }
  throw new Error('Chrome/Chromium is required for deterministic SVG reference capture');
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
    };
    await new Promise((resolveOpen, reject) => { this.ws.onopen = resolveOpen; this.ws.onerror = reject; });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolveCommand, reject) => {
      this.pending.set(id, { resolve: resolveCommand, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.ws.close(); }
}

async function endpoint(child) {
  return await new Promise((resolveEndpoint, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`Chromium did not expose DevTools: ${stderr}`)), 15000);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
    });
    child.on('exit', code => reject(new Error(`Chromium exited before capture (${code}): ${stderr}`)));
  });
}

async function capture(chrome, svgPath, seconds, output) {
  const work = await mkdtemp(join(tmpdir(), 'sentient-svg-capture-'));
  const profile = join(work, 'profile');
  const markup = await readFile(svgPath, 'utf8');
  const html = `<!doctype html><meta charset=utf-8><style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#2b2621}svg{display:block;width:512px;height:512px}</style>${markup}`;
  const pagePath = join(work, 'capture.html');
  await writeFile(pagePath, html);
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--hide-scrollbars', '--disable-dev-shm-usage', '--force-device-scale-factor=1', `--user-data-dir=${profile}`], { stdio: ['ignore', 'ignore', 'pipe'] });
  let browserCdp;
  let pageCdp;
  try {
    const browserUrl = await endpoint(child);
    browserCdp = new Cdp(browserUrl); await browserCdp.open();
    const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
    const debugOrigin = browserUrl.replace(/^ws:/, 'http:').replace(/\/devtools\/browser\/.*$/, '');
    const targets = await (await fetch(`${debugOrigin}/json/list`)).json();
    const target = targets.find(item => item.id === targetId);
    pageCdp = new Cdp(target.webSocketDebuggerUrl); await pageCdp.open();
    await pageCdp.send('Page.enable');
    await pageCdp.send('Emulation.setDeviceMetricsOverride', { width: 512, height: 512, deviceScaleFactor: 1, mobile: false });
    await pageCdp.send('Page.navigate', { url: pathToFileURL(pagePath).href });
    await new Promise(r => setTimeout(r, 250));
    await pageCdp.send('Runtime.evaluate', { expression: `(() => { const svg=document.querySelector('svg'); svg.pauseAnimations(); svg.setCurrentTime(${seconds}); for (const animation of document.getAnimations()) { animation.pause(); animation.currentTime=${seconds}*1000; } })()` });
    await new Promise(r => setTimeout(r, 50));
    const { data } = await pageCdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await writeFile(output, Buffer.from(data, 'base64'));
  } finally {
    pageCdp?.close(); browserCdp?.close(); child.kill('SIGKILL'); await rm(work, { recursive: true, force: true });
  }
}

if (process.argv.length !== 4) throw new Error(`usage: ${process.argv[1]} ASSET_DIR OUTPUT_DIR`);
const assets = resolve(process.argv[2]); const output = resolve(process.argv[3]); await mkdir(output, { recursive: true });
const chrome = browser();
for (const [name, seconds, filename] of [['sentient-mark.svg', 0, 'idle.png'], ['sentient-avatar-thinking.svg', 1, 'thinking-1.0s.png'], ['sentient-avatar-responding.svg', 2, 'responding-2.0s.png']]) await capture(chrome, join(assets, name), seconds, join(output, filename));
console.log(`deterministic SVG references: ${output}`);
