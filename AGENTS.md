# AGENTS.md

## Project Scope

- Main application code lives in `app/`.
- The app is an Electron + Vite + React desktop pet project.
- Keep changes scoped to the requested behavior and match the existing TypeScript/React style.

## Frontend Animation

- `gsap` is installed in `app` and should be the default animation library for non-trivial UI motion.
- Prefer GSAP timelines over chained timers, manual `requestAnimationFrame` loops, or scattered CSS animation classes when sequencing or cancellation matters.
- In React components, scope animations to component lifetime and clean them up. Prefer `gsap.context(...).revert()` inside effects.
- Respect reduced-motion preferences before adding decorative motion.
- Animate `transform` and `opacity` where possible; avoid layout-heavy animation of size or position unless there is a clear reason.
- Import GSAP from `gsap`, and register optional GSAP plugins explicitly before use.
