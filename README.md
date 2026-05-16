# Pi Agent Web

A Vue/Vite frontend for running the `pi` coding agent through RPC mode.

The browser connects to a local Node bridge at `/rpc`. The bridge starts `pi --mode rpc`, sends JSON-RPC-style commands over stdin, and streams Pi events back to the UI over WebSocket. Pi must already be installed and available on the machine running the server.

## Install

```sh
npm install
npx playwright install chromium
```

## Run

```sh
npm run dev
```

Open `http://127.0.0.1:4177`, choose the Pi options you need, then connect. The default command is `pi`; set `PI_COMMAND` on the server if you need a different executable. Provider, model, session directory, `--no-session`, and extra Pi flags are configurable from the sidebar.

The server binds to `127.0.0.1` by default because it can start a local process. Set `HOST` if you intentionally need another bind address, and set `PORT` if you need a different port. WebSocket origins are limited to the configured host and built-in local names, including `kodama.local`.

## Scripts

```sh
npm test
npm run test:e2e
npm run typecheck
npm run build
npm run preview
```

## Notes

- RPC framing is handled with strict LF-delimited JSON records, matching Pi's RPC docs.
- The UI supports prompts, steering, follow-ups, aborts, new sessions, compaction, retry and compaction toggles, tool activity, queue updates, stderr, and extension UI dialogs.
- The local components under `src/components/ai-elements` follow the Conversation, Message, and Prompt Input patterns from AI Elements Vue without requiring generated component downloads.
