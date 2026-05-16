# Development Notes

Thanks for working on this project. A few notes keep the loop pleasant and reliable:

- Prefer small, focused changes that preserve the current Vue/Vite shape.
- Let Pi own agent sessions; the frontend should display Pi-managed state rather than inventing its own session store.
- Keep the backend thin. Use Pi APIs where they exist, and add wrapper logic only when it improves the web experience.
- Treat the chat UI as an app surface, not a demo page: clear loading states, quiet controls, and no raw internal IDs unless they are intentionally shown in details.
- Use Lucide Vue icons for small controls, and keep icon buttons accessible with labels and titles.
- Run `npm test`, `npm run typecheck`, `npm run build`, and `npm run test:e2e` before calling UI or protocol work done.
- For local development, start the app with `HOST=0.0.0.0 npm run dev`.
