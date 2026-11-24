/** A small Chrome DevTools Protocol client, for the proof to read and drive the real window. */
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Target {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

interface Reply {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly result?: {
    readonly result?: { readonly value?: unknown };
    readonly exceptionDetails?: unknown;
    readonly data?: string;
  };
  readonly error?: { readonly message: string };
}

export class Cdp {
  readonly #ws: WebSocket;
  readonly #waiting = new Map<number, (r: Reply) => void>();
  #next = 1;
  /** Every protocol event since attaching (`Network.enable` and the like turn them on). */
  readonly events: { readonly method: string; readonly params: Record<string, unknown> }[] = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (m: MessageEvent<string>) => {
      const d = JSON.parse(m.data) as Reply;
      if (d.id !== undefined) {
        this.#waiting.get(d.id)?.(d);
        this.#waiting.delete(d.id);
      } else if (d.method !== undefined) {
        this.events.push({ method: d.method, params: d.params ?? {} });
      }
    };
  }

  /** Attaches to the app's own page, waiting for it to appear. */
  static async attach(port: number, timeoutMs: number): Promise<Cdp> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      try {
        const res = await fetch(`http://127.0.0.1:${String(port)}/json/list`);
        const list = (await res.json()) as Target[];
        const page = list.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1:'));
        if (page !== undefined) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            ws.onopen = () => {
              resolve();
            };
            ws.onerror = () => {
              reject(new Error('the debugger socket failed'));
            };
          });
          return new Cdp(ws);
        }
      } catch {
        // Not up yet.
      }
      await sleep(500);
    }
    throw new Error('the app page did not appear');
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<Reply> {
    return new Promise((resolve) => {
      const id = this.#next++;
      this.#waiting.set(id, resolve);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Runs `expression` in the page. The page's CSP applies to anything it evals. */
  async eval<T>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      allowUnsafeEvalBlockedByCSP: false,
    });
    if (r.error !== undefined) throw new Error(r.error.message);
    if (r.result?.exceptionDetails !== undefined)
      throw new Error(`in the page: ${JSON.stringify(r.result.exceptionDetails).slice(0, 600)}`);
    return r.result?.result?.value as T;
  }

  async waitFor(expression: string, timeoutMs: number, what: string): Promise<void> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      if ((await this.eval<unknown>(expression).catch(() => false)) === true) return;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(250);
    }
  }

  /** A real mouse click at the centre of the element `elementExpr` evaluates to. */
  async click(elementExpr: string): Promise<void> {
    const box = await this.eval<{ x: number; y: number } | null>(`(() => {
      const el = ${elementExpr};
      if (!el) return null;
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (box === null) throw new Error(`nothing to click: ${elementExpr}`);
    const at = { x: box.x, y: box.y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...at });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...at });
  }

  /** A JPEG of the window, base64. */
  async screenshot(): Promise<string> {
    const r = await this.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 30,
      clip: { x: 0, y: 0, width: 1280, height: 800, scale: 0.4 },
    });
    return r.result?.data ?? '';
  }

  close(): void {
    this.#ws.close();
  }
}
