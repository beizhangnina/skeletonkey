# SkeletonKey design system

The system behind `public/index.html`. It is deliberately small: one accent, two
neutral ramps, one spacing scale, five components. Every value used on the page
resolves to a token listed here.

Sources: Part B of Elaya's `landing-page-design` skill (type scale, spacing,
radius formula, states, motion, ship checklist) and the anti AI slop rules from
the GitTrend design roundup (no purple or blue gradients, no card inside a card,
no Inter plus purple default, no glassmorphism, no emoji icons). Where the two
conflict with the brief's "extremely minimal, no web fonts" constraint, the
brief wins; every such case is listed under **Deviations**.

---

## 1. Color

### 1.1 The accent: brass

One accent color, used for the key mark, numerals, the primary button, inline
emphasis and every focus ring. Nothing else is colored.

| Token | Dark | Light |
|---|---|---|
| `--accent` | `#E8B04B` | `#8A5A0F` |
| `--accent-ink` (text on accent) | `#0B0B0C` | `#FFFFFF` |
| `--accent-wash` (hover fill) | `rgba(232,176,75,0.10)` | `rgba(138,90,15,0.08)` |

Why brass and not the default:

- **It is the product.** SkeletonKey is a vault and a key. Brass is what a
  physical key is made of, so the color carries the metaphor without an
  illustration.
- **It is not the AI tool default.** Purple and blue gradients are the tell of a
  generated page. Warm metal sits in the opposite corner of the wheel from the
  category default and makes the page recognizable at thumbnail size.
- **Developer tool heritage.** Amber is the color of an old terminal phosphor.
  The audience is people who read a ledger and a loopback address, and amber on
  near black is the oldest version of that surface.
- **It survives both themes.** `#E8B04B` reaches 10.06:1 on the dark background.
  The same hue darkened to `#8A5A0F` reaches 5.62:1 on the light background, so
  one accent covers both modes at AA without a second brand color.

The light mode value is a darkened variant of the same hue rather than a
different color: `#E8B04B` on a light background is only 1.7:1 and unusable.

### 1.2 Neutrals

Warm grays, not blue grays, so nothing on the page fights the brass.

**Dark (default theme)**

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0B0B0C` | page background |
| `--surface` | `#131209` | code block, cards (a warm near black from the skill's approved dark list) |
| `--border` | `#2A2927` | hairlines, card and code outlines |
| `--border-strong` | `#3A3835` | input and secondary button outlines, muted tagline text |
| `--text` | `#F2F0ED` | headings and body |
| `--muted` | `#A8A49D` | secondary body copy |
| `--meta` | `#948F88` | eyebrows, captions, footer |

**Light**

| Token | Value | Use |
|---|---|---|
| `--bg` | `#FAF9F7` | page background |
| `--surface` | `#F2F0EC` | code block, cards |
| `--border` | `#E2DFD9` | hairlines |
| `--border-strong` | `#D2CEC6` | input outlines, muted tagline text |
| `--text` | `#17161A` | headings and body |
| `--muted` / `--meta` | `#5C5853` | secondary copy, captions |

Backgrounds are flat. There are no gradients anywhere on the page, including the
hero heading.

### 1.3 Contrast ratios

Measured with the WCAG 2.1 relative luminance formula. Everything carrying text
clears 4.5:1; large text and non text borders are marked.

**Dark theme**

| Pair | Ratio | Verdict |
|---|---|---|
| `--text` `#F2F0ED` on `--bg` `#0B0B0C` | 17.30:1 | AAA |
| `--text` on `--surface` `#131209` | 16.51:1 | AAA |
| `--muted` `#A8A49D` on `--bg` | 7.93:1 | AAA |
| `--meta` `#948F88` on `--bg` | 6.13:1 | AAA |
| `--meta` on `--surface` | 5.85:1 | AA |
| `--accent` `#E8B04B` on `--bg` | 10.06:1 | AAA |
| `--accent` on `--surface` | 9.61:1 | AAA |
| `--accent-ink` `#0B0B0C` on `--accent` (primary button) | 10.06:1 | AAA |
| `--border` `#2A2927` on `--bg` | 1.35:1 | decorative hairline only |

**Light theme**

| Pair | Ratio | Verdict |
|---|---|---|
| `--text` `#17161A` on `--bg` `#FAF9F7` | 17.12:1 | AAA |
| `--text` on `--surface` `#F2F0EC` | 15.82:1 | AAA |
| `--muted` `#5C5853` on `--bg` | 6.71:1 | AAA |
| `--muted` on `--surface` | 6.20:1 | AA |
| `--accent` `#8A5A0F` on `--bg` | 5.62:1 | AA |
| `--accent` on `--surface` | 5.20:1 | AA |
| `--accent-ink` `#FFFFFF` on `--accent` (primary button) | 5.92:1 | AA |
| `--border` `#E2DFD9` on `--bg` | 1.26:1 | decorative hairline only |

The focus ring is `--accent` in both themes, so it clears 3:1 against every
surface it can appear on.

---

## 2. Type

### 2.1 Stacks

No web fonts, no CDN, no network request for type. Two stacks:

```css
--font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
--font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
```

Sans carries prose. Mono carries the things that are literally typed: the
wordmark, install commands, tool names (`find_api`, `request_access`), step
numerals, eyebrows and the version string. Mono is never decorative.

Weights: 400 for body, 500 for the wordmark, 600 for headings, labels and
buttons. Nothing heavier than 600. No italics anywhere.

### 2.2 Scale

Tailwind's default steps, size paired with its line height. No value off this
table appears in the stylesheet.

| Token | Size | Line height | Used by |
|---|---|---|---|
| `--t-xs` | 12px | 16px | eyebrows, captions, copy button, honeypot note |
| `--t-sm` | 14px | 20px | code, card body, form, footer, header link |
| `--t-base` | 16px | 24px | body, buttons |
| `--t-lg` | 18px | 28px | hero subline below 768px |
| `--t-xl` | 20px | 28px | step and card headings, hero subline at 768px |
| `--t-2xl` | 24px | 32px | tagline below 480px |
| `--t-3xl` | 30px | 36px | hero h1 below 480px, tagline from 480px |
| `--t-4xl` | 36px | 40px | hero h1 from 480px, tagline from 768px |
| `--t-5xl` | 48px | 1 | hero h1 from 768px |

Headings step through breakpoints rather than using `clamp()`, so every rendered
size is still a step on the table.

Tracking: `-0.02em` on the hero h1 and the tagline, `-0.01em` on h3, `0.08em`
with uppercase on eyebrows. Line height is never set independently of its step.

### 2.3 Copy rules

`text-wrap: balance` on headings, `text-wrap: pretty` on body, so no word is
left alone on a last line. The hero heading and subline are capped at 680px and
the heading breaks at the thought, not at the edge. Sentence case everywhere.
Hyphens are avoided inside sentences. The only one left in visible copy is the
card heading `Self-host, free`, which is the brief's own wording for that path.

---

## 3. Spacing

A 4px based scale. Nothing between the steps, nothing outside them.

| Token | Value | Typical use |
|---|---|---|
| `--s-25` | 2px | — |
| `--s-50` | 4px | copy button vertical padding |
| `--s-75` | 8px | button vertical padding, form gaps, inline gaps |
| `--s-100` | 12px | button horizontal padding, input padding |
| `--s-200` | 16px | code block padding, header gap |
| `--s-300` | 24px | card padding, page gutter, card grid gap |
| `--s-400` | 32px | desktop gutter, step grid gap, footer padding |
| `--s-500` | 40px | — |
| `--s-600` | 48px | hero snippet offset |
| `--s-700` | 64px | section padding |
| `--s-800` | 80px | hero and tagline padding |
| `--s-900` | 96px | hero and tagline padding from 768px |

Page container: 960px max width, 24px gutter, 32px from 768px. Text measure:
680px for the hero heading, subline, code block and tagline.

---

## 4. Radius

Tailwind steps only: 2, 4, 6, 8, 12, 16.

| Element | Radius |
|---|---|
| Card | 16px |
| Code block | 12px |
| Button, input, header link, skip link | 8px |
| Copy button | 4px |
| Focus ring | 2px |

**Nested radius.** When a shape sits inside another and the gap is under 32px,
inner radius equals outer radius minus the gap, applied only when the result is
above 2. The copy button sits 8px inside the 12px code block, so it gets 4px.
Inside the 24px padded cards the formula returns a negative number, so the
buttons and input keep their own 8px rather than being squared off.

---

## 5. Components

**Button, primary** — accent fill, `--accent-ink` label, 8px radius, 8px by 12px
padding, 16px semibold. Hover brightens the fill 8%. Active scales to 0.98.
Focus shows the 2px accent ring at 2px offset. Disabled drops to 0.6 opacity and
stops the transform. Used twice, both below the fold: "Read the code on GitHub"
and "Join the waitlist".

**Button, secondary** — transparent fill, `--border-strong` outline, text label.
Hover switches the outline to accent and fills with `--accent-wash`. Same
active, focus and disabled behaviour. Defined for later use; the page itself
needs only the header text link.

**Code block** — `--surface` fill, 1px `--border` outline, 12px radius, 16px
padding, 14px mono, horizontal scroll rather than wrapping. The `$` prompts are
accent and not selectable; the `# alias: skk` comment is `--meta`. The copy
button sits at the top right on wide screens and moves below the code under
480px so it never covers a command. It copies the commands only, stripping
prompts and comments, then reads `copied` for two seconds through an
`aria-live` region. If the clipboard API is unavailable it says `press ctrl c`
instead of failing silently.

**Point** — used for the three steps and the two path cards. A step is an accent
mono numeral, a 20px heading and a 16px muted paragraph, with no container at
all. A card is `--surface`, a 1px border on all four sides, 16px radius and 24px
padding, holding an accent mono tag, a heading, body copy and one action. Cards
never nest inside other cards or panels.

**Input** — `--bg` fill, 1px `--border-strong` outline, 8px radius, 14px mono so
an address is easy to proofread. It carries a visible `<label>`, hover and focus
states, and `aria-invalid` plus an inline message on a bad address. Validation
messages are plain sentences: no `alert()`, no exclamation marks, no "Oops".

---

## 6. Motion

One easing curve, `cubic-bezier(0.32, 0.72, 0, 1)`, on every transition.

| Token | Duration | Use |
|---|---|---|
| `--dur-fast` | 160ms | hover and active on buttons, links, inputs |
| `--dur-ui` | 200ms | skip link |
| `--dur-reveal` | 800ms | scroll reveals |

Scroll reveals move an element from `translateY(16px)`, `blur(3px)`, opacity 0
to rest, driven by `IntersectionObserver`, never a scroll listener. Steps and
cards stagger 80ms apart. The tagline warms word by word in reading order, 55ms
apart, from `--border-strong` to full text color.

Nothing is hidden before JavaScript runs: the hiding rules only apply once the
document carries the `js` class, so with scripting off the whole page renders at
full contrast. Everything inside `@media (prefers-reduced-motion: no-preference)`
is skipped when a visitor asks for less motion, and the script then reveals
every element immediately instead of animating it.

---

## 7. Wordmark

**Lockup.** The key mark, a 12px gap, then `skeletonkey` set in the mono stack at
19px, weight 500, tracking `-0.3`, all lowercase. Never title case, never
`SkeletonKey` inside the lockup; prose uses SkeletonKey, the mark does not.

**Mark geometry**, on a 24 unit grid with 2.5 unit strokes and square caps:

- bow: circle, center `(8, 12)`, radius 4.5
- shaft: horizontal line from `x 12.5` to `x 21.5` at `y 12`
- teeth: two vertical lines down from the shaft to `y 16.75`, at `x 16.75` and
  `x 20.5`

That is the whole drawing: a circle, a line and two teeth. It stays legible at
16px, which is why the favicon can reuse it unchanged.

**Color.** The mark is always `--accent`. The word is always `currentColor`, so
the lockup inverts with the theme without a second file.

**Clear space.** At least the height of the bow, 9 grid units, on every side.

**Files**

| File | Contents |
|---|---|
| `assets/logo.svg` | full lockup, mark in brass, word in `currentColor` |
| `assets/mark.svg` | mark only, 24x24 |
| `assets/favicon.svg` | mark on a `#0B0B0C` rounded square, 32x32, copied to `public/favicon.svg` |

The lockup is also inlined in the page header so it costs no request and picks
up the theme through `currentColor`.

---

## 8. Deviations

Each one is a deliberate conflict resolution, not an oversight.

| Rule | What the page does | Why |
|---|---|---|
| B1: use Geist, Manrope, Poppins | system sans plus system mono | The brief requires no web fonts. Shipping zero font bytes beats the named families, and the mono stack is the one the skill already allows for code and data. |
| B1: never use Inter | honored | `system-ui` resolves to the platform UI face, never a downloaded Inter. |
| B5: gradient on the hero heading | flat `--text` | It is the one gradient the skill allows, but a fading heading is itself an AI slop tell, and the brief asks for extremely minimal. The hero earns attention from size and measure instead. |
| B6: Phosphor, Solar or Iconamoon icons | no icon set | Icons would mean a package or a CDN, both excluded. The steps are numbered `01 02 03` in mono and the sections carry their own words. No emoji is used as an icon. |
| A2: proof signal, benefits, FAQ, testimonials, final CTA | omitted | v0.1 has no users, stars, metrics or prices, and inventing them is off limits. Layout type C, the minimal conversion page, is the brief's choice precisely because there is nothing to prove yet. |
| B10: privacy policy and terms links | one inline sentence under the form | Linking to pages that do not exist would create the dead links B9 forbids. The form states exactly what is stored, which is what the policy would have said. |
| B11: per word `IntersectionObserver` | one observer on the section, per word delay | Identical result, one observer instead of twenty six, which matters more on a page this size. |
| B7: 700ms on every transition | 160ms on hover and active, 800ms on reveals | 700ms on a button hover feels broken. The curve is the skill's; only the duration is tuned to the gesture. |

---

# Addendum: v2 surface

`public/` in this directory is **v2**. Sections 1–8 above describe v0.1 and are
left as written: the key geometry (§7), the spacing scale (§3), the radius steps
(§4) and the motion curve (§6) are unchanged. What follows is only what v2
changes, and why. The full asset kit lives in `skeletonkey-branding/`
(`BRAND.md`, `brand-guide.html`).

## A1. Light first

v0.1 was dark by default with a light theme behind `prefers-color-scheme`. v2
inverts that: warm cream paper is the default surface and dark is the secondary
theme. The reason is the subject. A key, a ledger and a printed plate are paper
objects, and the engraving in the hero only reads as an engraving on paper.

| Token | v0.1 light | v2 light | v2 dark |
|---|---|---|---|
| `--bg` | `#FAF9F7` | `#F1ECE2` | `#14110C` |
| `--surface` | `#F2F0EC` | `#F7F4EC` | `#1E1A12` |
| `--border` | `#E2DFD9` | `#D5CBB6` | `#322C22` |
| `--text` | `#17161A` | `#16130E` | `#F2F0ED` |
| `--muted` | `#5C5853` | `#554E43` | `#A8A49D` |
| `--accent` | `#8A5A0F` | `#8A5A0F` | `#E8B04B` |
| `--accent-deep` | — | `#63400A` | `#F0C676` |

Brass is now three steps rather than one per theme. `--accent` `#8A5A0F` is
5.02:1 on cream and carries text. `--accent-deep` `#63400A` is 7.86:1, for the
tiny mono labels and for hover. `--accent-hi` `#E8B04B` is **fill only** on
paper — 1.66:1 — and becomes the text-safe accent only on ink, at 9.63:1. Body
text is 15.73:1. Every ratio is measured, and the full table is in `BRAND.md` §06.

The page also carries a tiled SVG `feTurbulence` grain at 0.11 opacity. It is a
background image on `body`, not a fixed overlay, so it covers a full-page capture.

## A2. Three faces, self hosted

§2 and the B1 deviation in §8 recorded a "no web fonts" constraint, which the
brief has since lifted. v2 ships three variable faces from `public/fonts/`, so
there is still **no CDN and no third party request** — the original point of the
constraint:

| Face | File | Job |
|---|---|---|
| Fraunces (var `opsz`, `wght`) | `fraunces.woff2`, 44 KB | the hero, step headings, the tagline |
| Manrope (var `wght`) | `manrope.woff2`, 15 KB | every paragraph and label |
| JetBrains Mono (var `wght`) | `jetbrainsmono.woff2`, 31 KB | commands, and the uppercase tracked micro-labels |

Plus a 17 KB italic subset of Fraunces cut to the lowercase run used by the two
italic phrases. 107 KB of type in total, all `font-display: swap`, with the two
faces above the fold preloaded. Fraunces is pinned to `SOFT 0, WONK 1` and
driven through `font-variation-settings`; note its `wght` axis defaults to 900,
so weight is always set explicitly.

Mono is now narrower in scope than §2 allowed: install commands, tool names, and
the 11px uppercase `0.16em` labels. It no longer sets the wordmark's
surroundings, and never a paragraph.

## A3. The hero plate

`public/index.html` inlines an original line-art engraving of an antique skeleton
key, generated rather than drawn by hand: outlines from circles, collar bands and
a cut bit path, and real engraving hatching — parallel line sets clipped to each
region with nested `clipPath`, cross-hatched where the form turns away. Light is
treated as coming from the upper right, so every shadow falls lower-left. Over it
sit a Fibonacci-square golden spiral at 0.16–0.30 opacity, hairline plate
furniture, and three leader lines that name the key's parts after the product's:
A the bow / the vault, B the shank / the proxy, C the bit / the ledger.

It is one `<svg>` with no raster fallback, themed entirely through the page's own
custom properties, and described for screen readers by `<title>` and `<desc>`.

## A4. Motion

Three additions to §6, all of them inside `prefers-reduced-motion:
no-preference` or guarded in the script, and all three sharing a single
`requestAnimationFrame`:

- **The tagline is scrubbed, not triggered.** v0.1 warmed the words once, 55ms
  apart, on intersection. v2 maps word opacity to how far the paragraph has
  travelled through the viewport, so scrolling back up un-darkens it. Words rest
  at 0.22 and reach 1.
- **The key turns.** `.pl-key` pivots on its bow: it settles in from −7° on load,
  then rotates up to +6° over the first 1.2 viewports of scroll.
- **A brass cursor dot** lags the pointer at 0.16 per frame. It is only created
  on a fine pointer that supports hover, and it stays hidden until a pointermove
  that carries real `movementX`/`movementY` — scrolling emits a pointermove at the
  resting cursor position, and that must not light it.

With scripting off, the tagline is never split into words and renders at full
contrast; with reduced motion asked for, every word and every reveal is shown at
rest and no transform is applied.

## A5. Unchanged

The waitlist is untouched: `functions/api/waitlist.ts` is byte identical, and the
client still POSTs `{email, company}` as JSON to `/api/waitlist` and reads the
same 200 `ok`/`exists`, 400, 429 and 500 responses, the same honeypot field, the
same `aria-live` messages and the same plain-sentence validation copy. The three
section structure, every heading and every sentence of body copy are as shipped.
No metric, testimonial, price or date has been added.

One layout note worth keeping: the hero is now a two-column grid, and the
horizontally scrolling code block inside it would otherwise set the track's
automatic minimum and push a phone page to 564px wide. The columns are
`minmax(0, …)` with `min-width: 0` on the items for exactly that reason.

---

# Addendum: v2.1 install surface

v2 opened with a headline and a single "install from source" snippet, and put
the two ways in — open source and hosted — in their own section near the foot of
the page. v2.1 moves the decision up: **install is the hero action.** This
supersedes the "three section structure" sentence in A5; the waitlist contract
itself is still untouched.

## B1. Two doors, inside the hero

A nested `<section id="install">` sits under the headline grid, inside the hero,
so the two cards are part of the first screen rather than a scroll away. It
carries the same `.sec-head` rule and coordinate as every other section, labelled
`§ 00 — INSTALL / MIT`, and the hero section's own padding and border are taken
back off it.

The grid is `minmax(0, 1.12fr) minmax(0, 0.88fr)` from 680px with
`align-items: start`: the open source door is the page's primary action and gets
the wider track, and the hosted card sits to its own height rather than
stretching to match a much taller neighbour. Both tracks are `minmax(0, …)` and
every child carries `min-width: 0`, for the same reason the hero grid does — a
command that scrolls would otherwise set the track's automatic minimum and push a
360px page sideways.

Cards still never nest inside cards. The code blocks, tabs and form inside a door
are plain blocks, not panels.

## B2. Tabs — Claude Code and Codex

Two tabs, no more. The list is a real `role="tablist"` with an `aria-label`, each
tab a `<button type="button">` carrying `aria-selected` and `aria-controls`, each
panel a `role="tabpanel"` with `aria-labelledby` and `tabindex="0"` so a keyboard
can reach a scrolling command.

- **Roving tabindex.** The selected tab is `tabindex="0"`, the other `-1`, so one
  Tab press moves past the whole list into the panel.
- **Arrow keys select as they move**, wrapping at both ends; `Home` and `End` jump
  to the first and last tab. Click does the same thing without moving focus.
- **Without scripting nothing is lost.** `html:not(.js) .tablist { display: none }`
  hides the controls, every panel stays visible, and each one is introduced by its
  own label — `Claude Code`, `Codex`. The script hides the inactive panel only
  after it has taken over.

Visually a tab is the same 11px uppercase mono label as every other eyebrow, with
a 2px accent underline when selected, so the component adds no new type step.

## B3. The commands

Each panel holds one line, copyable with its own button — the copy script now
binds every `[data-copy]` on the page instead of the first one:

```
npx skeletonkey init && claude mcp add skeletonkey -- npx skeletonkey mcp
npx skeletonkey init && codex mcp add skeletonkey -- npx skeletonkey mcp
```

Both are **labelled as a target, not a working install**: npm publishing is off
for v0.1, the label says `— target once published to npm`, and the note under the
tabs repeats it in a sentence before pointing at the source build. The `git clone
… && npm install && npm run build && npm link` block from the v2 hero is kept
verbatim underneath, under a `From source` label, with its own copy button.

One deviation from §5: inside a door, `pre` wraps (`white-space: pre-wrap`)
instead of scrolling. A primary action that is cut off mid-flag is worse than a
command on two lines. `--` is wrapped in a `nowrap` span because UAX #14 allows a
break after a hyphen, which would otherwise split the separator across lines.

## B4. FAQ

The A2 deviation said a FAQ was omitted because v0.1 has nothing to prove. Four
questions are now answered — security model, where keys live, how this differs
from an aggregator, and cost — and the reasoning holds: none of them is a proof
signal. Every answer restates something already in this document or the brief, and
the cost answer says plainly that the hosted endpoint has no price and no date.
No metric, testimonial, star count or customer has been added.

Markup is a `<dl>` of `.qa` blocks, two columns from 680px, `dt` in the Display M
step and `dd` in Body S at a 52ch measure.

## B5. Unchanged

`functions/api/waitlist.ts` is still byte identical. The form keeps its id, its
`email` and honeypot `company` fields, its JSON `{email, company}` POST to
`/api/waitlist`, the same 200 `ok`/`exists`, 400, 429 and 500 handling, the same
`aria-live` messages and the same plain-sentence validation copy — it has only
moved up the page into the hosted door. The key mark, the palette, the type scale,
the spacing and radius steps and the motion curve are all as in §1–§7 and A1–A4.

---

# Addendum: v3 — the photographic hero

v2.1 opened on an inlined SVG engraving of a key (§A3) beside the headline. v3
replaces that whole opening with a full-screen photograph and rebuilds the type
scale around a single dominant headline. Everything in §1–§7 and A1–A2 still
holds: the palette, the spacing and radius steps, the easing curve, the
wordmark, the three self-hosted faces. The waitlist contract, the tabs and the
copy buttons are byte-for-byte what A5 and B5 describe.

## C1. The plate is gone

`svg.plate` and every `.pl-*` rule are deleted, along with the scroll handler
that rotated `.pl-key` and the brass cursor follower.

The reason is a failure mode, not a taste: an SVG with no `fill` presentation
attribute falls back to `fill: black`. When the stylesheet was stale or missing
— a cached `/styles.css` on a Mac that had already visited the site — the plate
rendered as a solid black rectangle roughly 460px wide in the middle of the
page. **The rule this sets: nothing in the hero may depend on CSS to avoid a
black fill.** The hero is now a `<picture>`, which degrades to a plain image,
and the one SVG above it — the wordmark — carries `stroke="#E8B04B"` as a
presentation attribute so it draws with no stylesheet at all.

The cursor follower went with it for a different reason: §6 asks for one
authored moment, and v3 spends it on the hero.

## C2. The hero

`100svh`, `min-height: 640px`, `background-color: #14110C` underneath, so a
failed image request still leaves cream text on warm black rather than cream on
white.

| Source | File | Serves |
|---|---|---|
| `(max-width: 700px)` | `hero-mobile.webp` 640×1024 | portrait crop, key in the lower half |
| default | `hero-960.webp` 960w, `hero-1536.webp` 1536w | 3:2, key and lit door on the right |

`object-fit: cover` with `object-position: 72% 52%` on desktop and `55% 50%` on
the portrait crop, so the key stays in frame at every aspect ratio the crop can
meet. `fetchpriority="high"`, intrinsic `width`/`height` on every source, and a
`<link rel="preload" as="image">` per breakpoint. The alt text is empty: the
photograph is atmosphere, and the headline already says what it says.

**The scrim** (`.hero-veil`) is three stacked gradients: a shade under the
header band, a shade along the foot, and the main wash — left to right on
desktop, top to bottom on the portrait crop, in `rgb(20 17 12)`, the dark
theme's own `--bg`. It is tuned per breakpoint band (≤700, 701–959, ≥960)
because the copy occupies a different share of the frame in each.

Measured against the rendered photograph, under every text line, at 360×740,
390×844, 768×1024, 834×1024, 1024×1000, 1440×900 and 1920×1080, the worst
single background pixel under any hero glyph gives:

| Element | Colour | Worst ratio observed |
|---|---|---|
| headline | `--ink` `#F6F1E6` | 6.33:1 |
| headline accent | `--accent-hi` `#E8B04B` | 7.49:1 |
| lede | `--ink-soft` `#D8D1C2` | 5.86:1 |
| foot line | `--ink-meta` `#C7BEAC` | 4.79:1 |
| header link | `--ink` | 8.17:1 |

All clear 4.5:1, including the ones the size rules would let off at 3:1.

The header is `position: absolute` over the hero rather than sticky: it is cream
on the photograph for one screen and then gone, which avoids a colour it would
have to switch halfway down a cream page.

## C3. The type scale

Explicit, modular, and the source of every size on the page. The ratio is 1.2 at
a 375px viewport and 1.25 at 1440px; each step is one `clamp()` interpolating
between those two ends.

| Token | 375px | 1440px | Used by |
|---|---|---|---|
| `--f--2` | 11 | 11 | mono micro-labels, tabs, copy button, coordinates |
| `--f--1` | 14 | 14 | body S, card and FAQ copy, footer, form |
| `--f-0` | 16 | 16 | body, buttons, mobile lede |
| `--f-1` | 19 | 20 | hero lede |
| `--f-2` | 23 | 25 | every section-level heading: `.point h3`, `.card h3`, `.qa summary` |
| `--f-3` | 28 | 31 | reserved |
| `--f-4` | 34 | 39 | `.statement` |
| `--f-5` | 40 | 49 | `.tagline` |
| `--f-hero` | 44 | 104 | the headline, and nothing else |

`--f-hero` is `clamp(2.75rem, min(1.43rem + 5.63vw, 10.4svh), 6.5rem)`. Width
drives it, but a short window caps it, because the headline, its lede and the
foot line all have to live inside one screen.

The gap from 49px to 104px is the point: one dominant idea. The headline is
Fraunces at `'opsz' 144, 'wght' 300`, leading 0.99, tracking −0.025em, with the
key phrase *your keys* in brass italic. Every section heading is the same step,
`--f-2`. Body is Manrope. Mono is now only the install commands and the 11px
tracked labels.

## C4. Faces, and the stale-cache failure

The headline rendered in a sans on at least one machine. Three changes:

1. **The stack can no longer reach a sans.**
   `"Fraunces", "Fraunces Fallback", ui-serif, Georgia, "Times New Roman", serif`.
2. **A metric-matched fallback.** `@font-face { font-family: "Fraunces Fallback";
   src: local("Georgia"), local("Times New Roman"), local("Times") }` with
   `size-adjust: 88%`, `ascent-override: 111%`, `descent-override: 29%`,
   `line-gap-override: 0%`. The width factor is measured — the headline string
   set in Fraunces at `'opsz' 144, 'wght' 300` is 0.88x its width in Georgia —
   and the vertical overrides are Fraunces' own metrics (2000 upm, ascender
   1956, descender −510) divided by that factor, so the swap barely moves the
   line.
3. **Cache busting.** `?v=3` on the stylesheet link, on all four `@font-face`
   URLs, and on both preloads — which still carry `crossorigin`, so the preload
   and the `@font-face` fetch are the same request.

## C5. Motion

One authored moment, in the hero: the photograph settles from `scale(1.085)` to
rest over 32s while the headline, the lede and the foot line rise and unblur in
sequence (60ms, 220ms, 360ms). Both are CSS animations on elements that are
visible by default, so they run with scripting off and change nothing if the
stylesheet never arrives. Below the fold, the v2 reveals and the scroll-scrubbed
tagline are unchanged.

Everything above sits inside `@media (prefers-reduced-motion: no-preference)`,
including the Ken Burns and the cue's hairline drop; `scroll-behavior` returns
to `auto` under the same query.

## C6. Deviations from the craft floor

| Rule | What the page does | Why |
|---|---|---|
| Body leading ≥ 1.3 | `--lh-display: 1.14` on `.statement` and `.tagline` | They are display statements at 34–49px, not body text; 1.14 is the leading that size wants. Body is 1.65. |
| "Fraunces is an overused face" | kept | Pinned by the brief and already the brand's display face. The brief wins. |
| No eyebrow above a heading | `.sec-head` kept | The eyebrow *is* the `<h2>`, paired with a right-hand coordinate datum on a hairline. There is no second, larger heading under it for it to kick. |
| FAQ hairline flush under the last question | kept | The rule line closing a section is the same device as `.sec-head` and `.point`; the question keeps 16px of air above it. |


---

# Addendum: v4 — editorial plates, and the air between them

v3 built the hero. v4 is the rest of the page: the sections below it read as a
magazine rather than a column of blocks, and the hero gains the one moment of
ambient motion the brief asked for. Everything in §1–§7, A1–A2 and C1–C4 still
holds — the palette, the radius steps, the easing curve, the wordmark, the four
self-hosted faces, the photographic hero and its contrast measurements. The
waitlist contract, the tabs and the copy buttons are byte-for-byte what A5 and
B5 describe; the form, its ids, its payload and its handlers are untouched.

## D1. The twelve column grid

`--page` is 1200px with a 24 / 32 / 40px gutter. From 960px every section below
the hero lands on `repeat(12, minmax(0, 1fr))` with a 40px column gap, and
nothing lands symmetrically:

| Section | Left | Right |
|---|---|---|
| The problem | statement `1 / span 6` | prose `8 / span 5` |
| What you get | plates `1/7`, `8/5` | then `1/5`, `6/7` — mirrored across the row |
| Install | open source door `1 / span 7` | hosted door `8 / span 5` |
| The pull quote | one column in (`margin-left: 8.333%`) | — |
| The detail | questions at 75% width | three empty tracks |

The empty tracks are the point: the dead column beside the FAQ and the air under
the problem statement are what the page is spending its width on.

## D2. Air

Section padding steps 80 → 112 → 160px (`--s-800`, `--s-1000`, `--s-1200`), so
two neighbouring sections put 320px between their content at desktop. The pull
quote takes 200px (`--s-1400`). `.sec-head` now clears 80px before its section's
first element, up from 40.

Three new steps join the 4px scale: `--s-1000` 112, `--s-1100` 128, `--s-1200`
160, `--s-1400` 200.

## D3. Section furniture

A section opens with a numbered mono micro-label on a hairline — `01 — The
problem`, the numeral in `--accent`, the words in `--text` — and a short datum
in `--meta` at the right end (`Why it exists`, `Four things`, `MIT license`,
`v0.1 notes`). The first 32px of that hairline is brass (`.sec-head::after`).
The old `§ 01 — PROBLEM` coordinate is gone; the number moved to the left where
it reads as a sequence.

## D4. The dissolve out of the hero

`.hem`, a `clamp(88px, 12vh, 160px)` band between the hero and the first
section, carrying a five-stop ramp from the photograph's own `#14110C` through
warm browns into `var(--bg)`. It is the one soft edge on the page; every other
section boundary is a hairline or the hard edge of an ink plate. In the dark
theme `--bg` is already that black, so the band is flat and the rule
`.hem + section { border-top: 0 }` keeps the join clean either way.

## D5. The ink plates

Three surfaces are now cream type on `--panel` `#14110C` (`#0E0C08` in the dark
theme, so they still read as plates when the page is already dark):

- **The pull quote.** `.tagline` is a full-bleed band, `--f-6` (42 → 77px)
  Fraunces at 17ch, offset one column in, over a 56px brass rule. The word by
  word scroll scrub of A4 is unchanged and needed no retheming: it only sets
  opacity.
- **Every command block.** `.code` is `--code-bg` with `--code-ink` `#EDE6D7`
  (14.6:1), brass `$` prompts (9.5:1) and `--code-hint` `#9A907C` (5.6:1) for
  the alias comment. The copy button is an outline on the ink, brass on hover.
  Inline `<code>` inside an answer stays page ink; `.code code` inherits the
  block's cream, which is the bug this pass fixed.
- **The footer.** The lockup at `clamp(32px, 8.4vw, 76px)` tall sits alone over
  128px of plate, then a hairline, then the version, the licence and the two
  links. `--ink-soft` links, brass underline on hover, brass focus ring.

## D6. Crafted plates for the benefits

A benefit is no longer a hairline and a paragraph. It is a `--surface` plate,
1px border, 16px radius, 40 → 48px padding, with `--shadow-card` (a real offset
and blur, not a halo) deepening to `--shadow-lift` and rising 2px on hover.

The numeral carries the card's weight: Fraunces at `clamp(3.5rem, 7vw, 5.25rem)`
in the top right, drawn as an outline with `-webkit-text-stroke` behind an
`@supports` guard that leaves a solid `--border` figure where the property is
missing. It is `aria-hidden`; the heading clears it with
`padding-right: clamp(68px, 8vw, 116px)`.

The two door cards keep the same plate but split on fill: the open source door
is `--surface` with the shadow, the hosted door is an outline on the page. The
hierarchy is visible before a word is read. Cards still never nest.

## D7. Hero motion — dust, a breathing seam, and scroll

The analogue of emergences.ai's ambient sky, built from scratch for this
photograph. Nothing is borrowed; no library is loaded.

**The dust.** A `<canvas>` created by the script and inserted between the
photograph (`z-index: -3`) and the scrim (`-1`). 2D context, never WebGL;
`devicePixelRatio` capped at 2; 96 motes on desktop, 44 under 760px, never more
than 120. One 36px radial-gradient sprite is rendered once and stamped per mote
with `drawImage` under `globalCompositeOperation: 'lighter'`, so there are no
per-frame gradients and the glow is additive.

Their x is drawn from three averaged uniforms — a cheap bell curve centred on
the shaft of light at 82% of the frame (80% on the portrait crop), with every
fifth mote placed anywhere for depth — and each mote's base alpha falls off with
its distance from that centre. They rise 0.055–0.225px a frame, sway on a sine
of their own period, twinkle on another, and reseed at the bottom when they
leave the top.

The rules that keep it safe:

- `clearRect` every frame, and the visible canvas is **never** filled. The one
  `fillRect` in the script paints the 36px offscreen sprite, whose gradient ends
  at alpha 0. The element also carries `background: transparent` in both CSS and
  an inline style. Measured in both engines at 1440x900: computed background
  `rgba(0,0,0,0)`, and `getImageData` on the live canvas returns `[0,0,0,0]`.
  There is no path by which it renders as a black box in WebKit or Chromium.
- No 2D context, or `prefers-reduced-motion: reduce` — it is never created, and
  the static photograph is the whole hero.
- Built after `load`, on `requestIdleCallback` with a 2500ms timeout, falling
  back to `setTimeout(1000)`.
- An `IntersectionObserver` on the hero and `document.hidden` both gate one
  `running` flag; the rAF is cancelled whenever the hero is off screen or the
  tab is in the background.
- It fades in over 2s from first frame and multiplies out by the hero's scroll
  progress, so it costs nothing once the hero is gone.

**The seam.** `.hero-glow`, a warm radial at 86% / 30% of the frame (84% / 27%
on the portrait crop), breathing between 0.40 and 0.95 opacity over 11s. Pure
CSS, under the scrim, inside the reduced-motion query.

**The scroll.** One `p` — hero scroll progress, 0 to 1 — computed in the single
existing rAF and shared with the canvas. `transform` and `opacity` only, passive
listeners:

| Element | At p = 1 |
|---|---|
| `.hero-media` | `translateY(4.5%)`, `scale(1.04)` |
| `.hero-copy` | `translateY(-76px)`, opacity 0 by p = 0.67 |
| `.hero-foot` | `translateY(-36px)`, opacity 0 by p = 0.5 |

`.hero-media` is inset `top: -5%; height: 110%` so the translate can never
expose an edge, and the Ken Burns animation stays on the `<img>` inside it: a
CSS animation outranks an inline style, so the two must not share an element.
For the same reason the `rise` entrance moved off `.hero-foot` onto its two
children, leaving the parent's transform to the scroll.

## D8. Type

`--f-4` (the statement) widens to 34 → 46px and `--f-6` is new at 42 → 77px for
the pull quote. `--f-hero` is unchanged at 44 → 104px, and the gap from 46 to
104 is still the page's one dominant idea. Mono is still only the install
commands, the micro-labels and the wordmark.

## D9. Deviations

The C6 table still applies. Two entries change:

| Rule | What the page does | Why |
|---|---|---|
| Section numbers unless the sequence carries information | `01`–`04` on every section label | Asked for by name in the brief. They also do work here: the page is a single scroll with no navigation, and the numbers are the only indication of how much is left. |
| Same-size cards as the page structure | four benefit plates | Asked for by name in the brief. They are not same-size — 7/5 then 5/7 — they carry no icon, and the page's other sections are a split, a band and a list, so a plate is not *the* structure. |

## D10. What the detector flags, and why it stays

`impeccable detect` returns six findings on the finished page. Each is a
deliberate conflict resolution, not an oversight:

| Finding | Where | Why it stays |
|---|---|---|
| `tight-leading` 1.14 | `.statement`, `.tagline p` | The C6 entry still applies: these are 46px and 77px display statements, not body text. Body is 1.65, the lede 1.55. |
| `cramped-padding` on `.tagline` | the ink band | The band is full bleed by design; its child `.wrap` carries the 24–40px gutter and the quote sits a further column in. Nothing is ever flush with an edge. |
| `cramped-padding` on `.faq` | the closing hairline | The C6 entry still applies: the rule closes the list, and the last question keeps 24px of air above it. |
| `overused-font` Fraunces ×4 | the display face | Pinned by the brief and already the brand's face. The brief wins. |
| `dark-glow` `#2c210e` | `--shadow-card` | It is a warm shadow on warm paper, with a 1px offset and a 34px blur at a −20px spread — an elevation shadow, not a zero-offset halo. A neutral grey shadow on cream reads as dirt. In the dark theme the same token is plain black. |
| `em-dash-overuse`, advisory | body copy | The copy is the shipped copy and is out of scope for this pass. |
