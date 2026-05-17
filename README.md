# Pi Agent Web

A Vue/Vite frontend for running the `pi` coding agent through RPC mode.

The browser connects to the web service at `/rpc`. The web service keeps that browser protocol stable and forwards work to a local runner service, which owns `pi --mode rpc`, sends JSON-RPC-style commands over stdin, and streams Pi events back to the UI over WebSocket. Pi must already be installed and available on the machine running the runner service.

## Install

```sh
npm install
npx playwright install chromium
```

## Run

```sh
npm run dev:runner
npm run dev
```

Run those commands in separate terminals. Open `http://127.0.0.1:4177` to start chatting or open a saved Pi session from the sidebar. The browser connects to `/rpc` when it needs the runner. The default command is `pi`; set `PI_COMMAND` on the runner service if you need a different executable.

The web service binds to `127.0.0.1:4177` by default. Set `HOST` or `PORT` if you need a different web bind address. WebSocket origins are limited to the configured host and built-in local names, including `kodama.local`.

The runner service binds to `127.0.0.1:4178` by default, exposes `GET /health`, and accepts the internal WebSocket at `/runner`. Set `RUNNER_HOST` or `RUNNER_PORT` to change that address. Set `RUNNER_URL` on the web service if it should connect to a specific runner URL. Set `PI_CODING_AGENT_SESSION_DIR` on the runner service when saved Pi sessions live outside the default location.

## Scripts

```sh
npm test
npm run test:e2e
npm run typecheck
npm run build
npm run dev:runner
npm run dev:web
npm run preview
```

## Notes

- Browser `/rpc` messages stay shaped as `{ type: "command", command, payload }`; the web-to-runner protocol adds local routing metadata and a versioned handshake.
- RPC framing to Pi is handled with strict LF-delimited JSON records, matching Pi's RPC docs.
- The UI supports prompts, new chats, saved-session browsing, session metadata, optional thinking and tool details, queued-command and stderr details, and extension UI dialogs.
- The local components under `src/components/ai-elements` follow the Conversation, Message, and Prompt Input patterns from AI Elements Vue without requiring generated component downloads.
