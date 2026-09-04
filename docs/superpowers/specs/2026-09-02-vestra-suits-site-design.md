# VESTRA — Suit Company Marketing Site

**Date:** 2026-09-02
**Status:** Approved design, ready for implementation planning
**Scope:** Frontend only. Single long-scroll landing page. No backend, no CMS, no payments.

## 1. Purpose

Build a marketing site for a luxury made-to-measure suit company whose centerpiece is a
scroll-driven 3D suit on a tailor's mannequin, followed by an animated grid of the
collection. The site must read as a flagship fashion house, not a template.

Success criteria:

- The hero holds attention through a full pinned scroll without the visitor scrubbing past it.
- The 3D suit is frame-perfect at every scroll position, on every viewport.
- The collection cards are genuinely 3D, not static images pretending to animate.
- The page is fully usable with motion disabled, with WebGL unavailable, and by keyboard.
- `next build` passes clean and the browser console is empty.

Explicit non-goals: routing beyond `/`, product detail pages, cart, checkout, auth, CMS,
form submission to a real backend, i18n, blog.

## 2. Brand

**Name:** VESTRA (from *vestire*, to dress). Defined once in `src/data/brand.ts` so renaming
is a single-line change.

**Palette:**

| Token | Value | Use |
|---|---|---|
| `pearl` | `#F8F5F0` | Page background, the cyclorama |
| `bone` | `#EDE6DA` | Recessed panels, card surfaces |
| `ink` | `#14151A` | Primary type |
| `ash` | `#6B6B70` | Secondary type, meta labels |
| `brass` | `#B08D57` | Hairlines, active/focus states, primary CTA. Nothing else. |

No decorative gradients, no glass, no shadow stacks. Luxury is restraint plus one expensive
detail, and brass is the detail.

**Typography:** Two families, loaded via `next/font`.

- Display: **Instrument Serif**. Hero word set 8–12vw, tight leading, optical margin.
- Body/UI: **Inter**. Micro-labels are uppercase, 0.2em tracking, `ash`, ~11px.

**The governing visual rule:** the 3D suit must sit *in* the cream page, not float on it.
Its contact shadow lands on the same background color as the surrounding HTML, so the
mannequin looks physically present on the paper.

## 3. Architecture

**Stack:** Next.js 15 (App Router) · TypeScript · Tailwind v4 · react-three-fiber + drei ·
Lenis (smooth scroll) · Framer Motion (DOM animation) · shadcn primitives (heavily restyled).

**The single-canvas rule.** Exactly one `<Canvas>` is mounted, fixed behind the entire
document, with `eventSource` bound to the app root. Every 3D surface on the page — the hero
mannequin and each suit card — is a drei `<View>` portalling into that one renderer.

```
<Canvas fixed inset-0 eventSource={root}>
  <View.Port />          <- one WebGL context, one lighting rig
</Canvas>

DOM scrolls above it:
  <HeroView />     ─┐
  <CardView x8 />   ├─ tracked <View> regions
  <DetailView />   ─┘
```

Consequences, which are the reason for the choice: one WebGL context instead of ten (browsers
cap around sixteen); the studio lighting is literally the same light in the hero and in every
card; cards can rotate on hover at 60fps without allocating a renderer.

**Rendering:** the canvas is client-only, dynamically imported with SSR disabled, mounted
after first paint. All copy is real server-rendered HTML and never depends on the canvas.

## 4. Page composition

Order, top to bottom:

1. **Nav** — wordmark left, three anchors right. Transparent at rest, backdrop blur + brass
   hairline after 40px of scroll.
2. **Hero** — pinned ~300vh, the scroll timeline in §5.
3. **Story** — three pinned beats on craftsmanship. Text-led and typographic in the
   shipping build; the beats are laid out to accept fabric macro imagery in the optional
   asset pass (§11) without a layout change.
4. **Collection** — the animated card grid, §7.
5. **Craft** — fabric and construction detail. Ships driven by the shared 3D material
   system (a rotating close detail: button, lapel, cuff), so it needs no imagery to be
   complete.
6. **Book a fitting** — CTA band with a frontend-only form, §8.
7. **Footer** — wordmark, address, hours, legal line.

## 5. Hero scroll timeline

The hero pins and one normalized progress value `p` (0→1) drives the entire scene. All
animation is a pure function of `p`; nothing is time-based, so any scroll position is
reproducible and reversible.

| `p` | Camera / scene | DOM |
|---|---|---|
| 0.00–0.20 | Front elevation. Jacket panels settle onto the form; contact shadow resolves. | Wordmark at full scale. |
| 0.20–0.45 | Orbits to three-quarter; camera dollies in. | Headline crossfades to the positioning line. |
| 0.45–0.70 | Continues to profile. | Lapel, stitch, and cuff callouts pin and release against the rotating form. |
| 0.70–1.00 | Camera pulls back; mannequin scales down and translates toward the grid's first cell. | Section label for the collection fades up. |

The handoff at `p ≥ 0.9` is a shared-element transition: the hero `View` interpolates toward
the bounding box of the first collection card, so the suit appears to *become* the first
card. This is the moment the site earns its keep and should be treated as a first-class
requirement, not a flourish.

The mapping from `p` to camera azimuth, dolly, model scale, and callout visibility lives in a
pure module, `src/lib/heroTimeline.ts`, and is unit tested independently of React.

## 6. The 3D system

**Geometry.** A stylized mannequin torso built procedurally — lathed shoulders and chest,
extruded lapels, notch collar, sleeves, a turned stand and base. No downloaded GLB: the
geometry is authored in code, so it ships as a few KB, is ours to modify, and every suit
variant is a material swap rather than a separate asset.

**Material.** A custom physical material per suit: high roughness with an anisotropic sheen
for wool, a procedurally generated fine woven normal pattern, per-fabric sheen and roughness
values. Navy flannel and ivory linen must look like different *cloth*, not different hex
values.

**Lighting.** A soft key, a broad fill, and a rim, plus a low-intensity studio environment,
defined once in `components/canvas/Studio.tsx` and shared by every `View`. Contact shadow via
a soft shadow plane tinted to `pearl`.

## 7. Collection grid

Eight suits from `src/data/suits.ts`. Each card is a `<View>` into the shared scene.

- **Enter:** staggered mask reveal (clip-path wipe upward), 60ms apart, triggered once on
  intersection.
- **Hover/focus:** that suit rotates ~25°, rim light intensity lifts, the name's underline
  draws left to right. Pointer-driven, spring-damped, reverses cleanly.
- **Click/Enter key:** opens the detail overlay.

**Detail overlay:** shadcn `Dialog` as the accessibility substrate, restyled to a full-bleed
cream panel. Contains a larger drag-to-rotate `View` of that suit, the spec list (cut,
fabric, weight, construction, lining, price), and a fitting CTA. Escape closes, focus is
trapped and restored, body scroll is locked.

Only cards intersecting the viewport render their `View`; offscreen cards are skipped in the
render loop.

## 8. Booking form

Frontend only. Fields: name, email, preferred date, preferred location, notes. Client-side
validation with inline errors, a pending state, and a confirmation state. On submit it
resolves locally after a short delay — there is no network call and no data leaves the
browser. A comment marks the exact function where a real endpoint would be wired in.

## 9. Degradation and accessibility

Non-negotiable, verified before completion:

- **`prefers-reduced-motion: reduce`** — no pinning, no scrub, no scroll hijack. The hero
  renders one composed static frame; cards appear without stagger; hovers are instant state
  changes. The page becomes a normal document.
- **No WebGL** — feature-detected. Falls back to a layered SVG suit hero. Nothing appears
  broken and no error surfaces to the user.
- **Mobile** — device pixel ratio clamped to 2, reduced geometry segment counts, at most
  three card `View`s rendering at once, no drag-to-rotate on the hero.
- **Semantics** — the canvas is `aria-hidden`; all meaning lives in real headings and text.
  Cards are buttons, reachable and operable by keyboard. Focus rings are brass and always
  visible. Color contrast meets AA against `pearl`.
- **Motion safety** — no strobing, no rotation faster than one revolution per second.

## 10. File layout

```
src/
  app/            layout.tsx · page.tsx · globals.css
  components/
    canvas/       Scene.tsx · Studio.tsx · Mannequin.tsx · SuitMaterial.tsx
                  HeroView.tsx · CardView.tsx · DetailView.tsx · FallbackHero.tsx
    sections/     Nav.tsx · Hero.tsx · Story.tsx · Collection.tsx
                  Craft.tsx · BookFitting.tsx · Footer.tsx
    motion/       Reveal.tsx · SplitText.tsx
    ui/           shadcn primitives
  hooks/          useScrollProgress.ts · useReducedMotion.ts · useWebGLSupport.ts
  lib/            heroTimeline.ts · utils.ts
  data/           brand.ts · suits.ts
scripts/          generate-assets.ts (Higgsfield, added only if used)
```

Every product and brand fact lives in `src/data/`. Changing the collection or the company
name must never require touching a component.

## 11. Asset strategy

The site ships complete with zero external assets. Generated imagery (Higgsfield or
otherwise) is a later, optional pass covering exactly four surfaces: craftsmanship fabric
macros, atelier lifestyle imagery, an ambient loop behind the booking CTA, and the Open Graph
image. Deliberately excluded from the hero: scroll-scrubbed video seeks poorly in browsers,
and generated turntable footage drifts between frames, which is the one flaw a visitor to a
tailoring site would notice. If used, credentials go in a git-ignored `.env.local` as
`HF_API_KEY_ID` / `HF_API_KEY_SECRET`.

## 12. Verification

**Unit (Vitest, written before implementation):** `heroTimeline` mapping at boundary and
midpoint progress values, monotonic and clamped outside 0–1; `suits` data conforms to its
type; scroll-progress normalization.

**Visual and behavioral, run for real before any completion claim:** dev server driven with
Playwright — screenshots at progress 0, 0.25, 0.5, 0.75, 1.0 at desktop and mobile widths;
card hover and overlay open/close; keyboard-only traversal of nav, cards, overlay, and form;
the reduced-motion and no-WebGL paths forced on; console asserted clean; `next build` and
`tsc --noEmit` pass.
