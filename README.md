# squishlings — merge & collection game

https://squishlings-one.vercel.app/

**The game loop**: the hatch meter 🥚 fills slowly on its own — clicking it
(or tapping the ground) adds a quarter with a juicy bounce, so four taps
hatch a small squishling. Throw two of **similar size** into each other and they
goo-merge into an evolved child — volume-conserving, so your collection grows
katamari-style. Throw a small one at a **much bigger** one and it just gets
gulped (with a toast explaining why): the big one grows, but no evolution —
so rare hunting means matching sizes. Merge luck (size closeness ×
generation) boosts the odds of rare traits: tri-antennae, lantern feelers,
dragonfly double wings, octopods, third eyes, cyclopses, and the void /
golden colorways. Antennae also vary in tip (ball / point / pom / lantern),
curl, and segment count; tails, ears and antennae carry a **floppiness** gene
that drives their ragdoll physics (and shows as a stat).

- **Card**: grab any squishling to slide in its stat card — volume, height,
  antenna length, floppiness, stat bars, gacha grade (N / R / SR / SSR),
  trait chips, and its family tree. The card hops to the other side of the
  screen whenever you drag the squishling behind it.
- **Squishipedia** (book button): every discoverable trait with rarity,
  locked entries shown as "???".
- **Lineages** (tree button): the family tree of every living squishling.
- **Stage growth**: as your biggest squishling grows, the world grows —
  bushes → trees → forest → mountains, each with a pop-in fanfare.
- **Eat the scenery**: throw a squishling at a rock / bush / tree — if it's
  at least twice the prop's volume it gulps it and grows a little (rocks are
  the starter snack). Too small? **BONK** — screen shake, bounce, and a dizzy
  spell: stars orbit its head and its pupils roll in circles for a few
  seconds. Eaten props regrow on a timer up to a per-kind cap.
- **Evolution celebration**: goo swirl → pop → confetti/star burst scaled by
  rarity, a **cinematic camera** swings onto the newborn — who floats up,
  faces the camera, and turntable-spins with limbs dangling — while its card
  slides in beside it, and trait chips pop in one by one — rarest last, with
  bigger, flashier pops for SR/SSR.
- **Persistence**: the whole crowd (genomes, names, lineage, sizes),
  squishipedia and stage autosave to localStorage; the settings page (gear)
  has a two-tap reset-everything.

Ragdoll-ish creatures built entirely from primitive shapes that render as **one
seamless squishy body**, with fully procedural animation for two-legged,
four-legged, six-legged, no-legged (hopping) and flying body plans. Every
creature is generated from a single 32-bit seed. Built with Three.js.

```bash
npm install
npm run dev
```

## Controls

- **Drag** a squishling to pick it up (it dangles, panics, and splats when dropped)
- **Throw one into another** — they squish together and merge into a new creature
- **Tap/click** a squishling to pet it (hearts!)
- **Tap/click the ground** to call the nearest squishling over
- **Drag empty space** to orbit, scroll/pinch to zoom
- **Space** or the dice button reshuffles the whole crowd; **+ / −** add and remove

## Merging

Releases keep the fling velocity, and thrown squishlings get a gentle
aim-assist curve toward nearby friends. A fast hit merges; a soft bump just
bonks them apart (bystanders see it coming and flinch). On a merge, both
creatures are replaced by a **goo blob rendered in one SDF material**, so the
two bodies genuinely melt together: slam → two-lobe swirl (colors visibly
orbiting, dizzy googly eyes poking out of the goo) → collapse → inflate → pop,
and the child bursts out (`src/merge.js`).

The child genome "makes sense" (`mergeGenomes` in `src/genome.js`):

- **Volume is conserved**: child scale = ∛(a³ + b³), capped at 2.2 — merging
  grows them, katamari-style
- The **bigger parent dominates** the body plan and proportions
  (volume-weighted), with a 14% chance of a body-plan mutation surprise
- **Hues pigment-mix** along the shortest arc; the smaller parent's color
  survives as the child's accent (feet, hands, wings), so ancestry stays visible
- Snouts, tails, and ears are inherited from either parent; bounciness takes
  the max; each generation gets slightly more saturated

## How the seamless bodies work

Each creature is **one draw call**: a bounding box whose fragment shader
raymarches a signed distance field made of ≤32 *round cones* (tapered
capsules; spheres are the degenerate case). Primitives are unioned with a
polynomial smooth-min that blends **distance, color, and material id**
simultaneously, so limbs melt into torsos with smooth color gradients and no
geometry seams — the "made of primitives but looks like one blob" trick
(`src/blob-material.js`).

Everything else about the look is derived from the same SDF in the same pass:

- **Toon shading**: banded ramp with a cool plum shadow tint, jelly specular, warm rim
- **Ink outlines**: silhouette-grazing normals (`dot(n, v)`), suppressed inside
  concave creases so folds don't flood with black
- **Crease AO**: two field taps along the normal darken where blobs meet
- **Googly eyes**: eye primitives use a flat material; the pupil is a cap of the
  eye sphere facing a per-creature look direction, with a sparkle offset — so
  pupils track targets for free
- **Correct depth**: `gl_FragDepth` from the hit point, so creatures sort
  against the world and each other

Mobile notes: no post-processing passes, blob shadows instead of shadow maps,
adaptive pixel-ratio scaling under load, ~72 march steps against tight boxes.
A numerically **stable round-cone SDF** (radial/axial 2D form) is used because
the textbook closed form cancels catastrophically near the axis in float32 and
paints ring artifacts over the body.

## Procedural animation (`src/creature.js`)

- **Any-legged gait**: distance-triggered, phase-gated stepping. Feet stay
  planted in world space; a leg steps when its foot drifts too far from its
  predicted home, gated by a gait clock (alternating pairs for bipeds,
  diagonal trot for quads, tripod for hexapods). Parabolic swing arcs +
  analytic 2-bone IK with per-plan knee bend hints. Idle repositioning falls
  out of the same rule.
- **Hoppers**: sit → windup (squash) → launch (stretch, ballistic) → land
  (squash impulse, dust ring) state machine.
- **Flyers**: spring-driven hover with sine bob, flap frequency tied to speed
  and climb, wingtip lag ("wing whip"), banking into turns, feet dangling.
- **Ragdoll bits**: tails, bunny ears and antennae are verlet chains with a
  rest-pose pull — they flop, follow through, and overshoot on every hop and
  turn. Held creatures dangle their legs; dropped creatures windmill their
  arms and air-run, then squash, bounce, and recover.
- **Life**: breathing, blinks (eyes sink and take the skin color), pupil
  saccades, looking at neighbours/the camera, acceleration lean, squash
  spreads the body (volume-ish preservation).

## Files

- `src/traits.js` — trait catalog, rarity grading, stats, name generator
- `src/ui.js` — cards, squishipedia, lineage trees, toasts, celebrations
- `src/genome.js` — seed → body plan, proportions, palette, personality
- `src/blob-material.js` — the raymarched SDF material
- `src/creature.js` — rig, locomotion, interactions, prim packing
- `src/anim-helpers.js` — springs, verlet chains, 2-bone IK, easing
- `src/world.js` — sky, meadow, grass, rocks, motes, blob shadows
- `src/fx.js` — dust, confetti, hearts, ground rings
- `src/main.js` — scene, input, spawn lifecycle, adaptive quality

Debug: `window.__dbg` exposes `{ renderer, scene, camera, creatures, controls,
step(dt) }` — `step` advances the sim manually (handy in hidden tabs where
`requestAnimationFrame` is paused).
