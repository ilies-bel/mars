/**
 * Tiny browser client for the bus daemon.
 *
 * Compile with:
 *   pnpm tsc --target ES2022 --module ES2022 --moduleResolution bundler \
 *     --outDir examples/bus/dist examples/bus/browser-client.ts
 *
 * Then serve `examples/bus/` over any static HTTP server (e.g.
 * `python3 -m http.server 8080`) and open `index.html`. The page will
 * connect to the daemon at ws://localhost:7777, subscribe to '*', and
 * append every event it receives to the DOM.
 */

interface BusEnvelope {
  id: number;
  type: string;
  payload: unknown;
  ts: number;
}

const url = 'ws://localhost:7777';
const list = document.getElementById('events');
const status = document.getElementById('status');

function setStatus(s: string): void {
  if (status) status.textContent = s;
}

function append(env: BusEnvelope): void {
  if (!list) return;
  const li = document.createElement('li');
  const when = new Date(env.ts * 1000).toISOString();
  li.textContent = `#${env.id} ${env.type} @ ${when} ${JSON.stringify(env.payload)}`;
  list.prepend(li);
}

function connect(): void {
  setStatus(`connecting ${url}…`);
  const ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    setStatus('connected');
    ws.send(JSON.stringify({ action: 'subscribe', types: ['*'] }));
  });

  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') return;
    try {
      append(JSON.parse(ev.data) as BusEnvelope);
    } catch {
      /* ignore malformed frame */
    }
  });

  ws.addEventListener('close', () => {
    setStatus('disconnected — retrying in 1s');
    setTimeout(connect, 1000);
  });

  ws.addEventListener('error', () => {
    setStatus('error');
  });
}

connect();
