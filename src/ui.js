// DOM layer of the collection game: stat cards, the trait encyclopedia
// ("squishipedia"), lineage trees, toasts, and the evolution celebration.
import { extractTraits, extractStats, gradeOf, GRADE_META, ALL_TRAITS, traitById, TIER_POINTS } from './traits.js';

const el = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------------------------------------------------------------------------
// card building
function chipHTML(trait, isNew = false, pop = null) {
  const popCls = pop ? ` pop pop-${trait.tier}` : '';
  const popStyle = pop ? ` style="--d:${pop.delay.toFixed(2)}s"` : '';
  return `<span class="chip tier-${trait.tier}${popCls}"${popStyle} title="${esc(trait.hint || trait.tier)}">
    ${esc(trait.label)}${isNew ? '<i class="new-tag">NEW</i>' : ''}</span>`;
}

function statRowHTML(row) {
  if (row.bar !== undefined) {
    const w = Math.round(Math.max(0.04, Math.min(1, row.bar)) * 100);
    return `<div class="stat"><span>${esc(row.label)}</span>
      <span class="bar"><i style="width:${w}%"></i></span></div>`;
  }
  return `<div class="stat"><span>${esc(row.label)}</span><b>${esc(row.value)}</b></div>`;
}

function lineageHTML(lin, depth = 0) {
  if (!lin || depth > 4) return '';
  const kids = lin.parents
    ? `<div class="lin-kids">${lin.parents.map((p) => lineageHTML(p, depth + 1)).join('')}</div>`
    : '';
  return `<div class="lin-node">
    <div class="lin-row">
      <span class="lin-dot" style="background:${lin.color}"></span>
      <span class="lin-name">${esc(lin.name)}</span>
      <span class="chip tiny tier-badge-${lin.tier}">${lin.tier}</span>
    </div>${kids}</div>`;
}

export function cardHTML(creature, newTraitIds = new Set(), opts = {}) {
  const g = creature.g;
  const grade = gradeOf(g);
  const stats = extractStats(g, { absorbed: creature.absorbedCount });
  const lin = creature.lineage;
  let traits = grade.traits;
  let chips;
  if (opts.pop) {
    // reveal common traits first, save the rarest for last — gacha drama
    traits = [...traits].sort((a, b) => TIER_POINTS[a.tier] - TIER_POINTS[b.tier]);
    let delay = 0.35;
    chips = traits.map((t) => {
      const html = chipHTML(t, newTraitIds.has(t.id), { delay });
      delay += 0.16 + TIER_POINTS[t.tier] * 0.06; // linger before rare reveals
      return html;
    });
  } else {
    chips = traits.map((t) => chipHTML(t, newTraitIds.has(t.id)));
  }
  return `
    <div class="card-grade tier-badge-${grade.tier}">${grade.tier}</div>
    <h3>${esc(lin?.name || '???')}</h3>
    <p class="card-sub">${esc(g.plan)} · gen ${g.generation || 0} · ${grade.points} pts</p>
    <div class="card-traits">${chips.join('')}</div>
    <div class="card-stats">${stats.map(statRowHTML).join('')}</div>
    ${lin?.parents ? `<div class="card-lineage"><h4>Lineage</h4>${lineageHTML(lin)}</div>` : ''}
  `;
}

// ---------------------------------------------------------------------------
let cardVisible = false;
export function showCard(creature) {
  const card = el('card');
  card.innerHTML = cardHTML(creature);
  card.classList.add('show');
  cardVisible = true;
}
export function hideCard() {
  if (!cardVisible) return;
  el('card').classList.remove('show');
  cardVisible = false;
}
// dodge: keep the card on the opposite side of the dragged squishling
export function setCardSide(side) {
  el('card').classList.toggle('left', side === 'left');
}

// ---------------------------------------------------------------------------
let toastTimer = 0;
export function showToast(msg) {
  const t = el('toast');
  t.innerHTML = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------------------
// celebration: the gacha reveal of a freshly evolved squishling. The card sits
// to the side; main.js swings the camera onto the newborn at the same time.
let celebrateTimer = 0;
let celebrateDismissCb = null;
export function celebrationLinger(tier) {
  return tier === 'SSR' ? 5.6 : tier === 'SR' ? 4.8 : 3.6;
}
export function showCelebration(creature, newTraitIds, onDismiss = null) {
  const grade = gradeOf(creature.g);
  const wrap = el('celebrate');
  wrap.className = `tier-glow-${grade.tier}`;
  wrap.innerHTML = `
    <div class="celebrate-card tier-border-${grade.tier}">
      <div class="celebrate-banner">✦ EVOLUTION ✦</div>
      ${cardHTML(creature, newTraitIds, { pop: true })}
    </div>`;
  wrap.hidden = false;
  void wrap.offsetWidth; // reflow so the entry transition runs
  wrap.classList.add('show');
  celebrateDismissCb = onDismiss;
  clearTimeout(celebrateTimer);
  celebrateTimer = setTimeout(hideCelebration, celebrationLinger(grade.tier) * 1000);
  wrap.onclick = hideCelebration;
}
export function hideCelebration() {
  const wrap = el('celebrate');
  if (wrap.hidden) return;
  wrap.classList.remove('show');
  clearTimeout(celebrateTimer);
  setTimeout(() => { wrap.hidden = true; }, 300);
  if (celebrateDismissCb) {
    const cb = celebrateDismissCb;
    celebrateDismissCb = null;
    cb();
  }
}

// ---------------------------------------------------------------------------
// encyclopedia
export function renderDex(unlocked) {
  const body = el('dex-body');
  const cats = [...new Set(ALL_TRAITS.map((t) => t.cat))];
  body.innerHTML = cats.map((cat) => {
    const traits = ALL_TRAITS.filter((t) => t.cat === cat);
    return `<section><h4>${esc(cat)}</h4><div class="dex-grid">
      ${traits.map((t) => unlocked.has(t.id)
        ? `<div class="dex-item tier-border-${t.tier}">
             <b>${esc(t.label)}</b><span class="chip tiny tier-badge-${t.tier}">${t.tier}</span>
             ${t.hint ? `<p>${esc(t.hint)}</p>` : ''}</div>`
        : `<div class="dex-item locked"><b>???</b><span class="chip tiny">${t.tier}</span></div>`).join('')}
    </div></section>`;
  }).join('');
  el('dex-progress').textContent = `${unlocked.size} / ${ALL_TRAITS.length}`;
}

// ---------------------------------------------------------------------------
// lineage overlay: every living squishling's family tree
export function renderLineage(creatures) {
  const body = el('lineage-body');
  const alive = creatures.filter((c) => !c.dead && c.dieT < 0 && c.lineage);
  if (!alive.length) {
    body.innerHTML = '<p class="empty">no squishlings yet…</p>';
    return;
  }
  body.innerHTML = alive.map((c) => {
    const grade = gradeOf(c.g);
    return `<div class="lin-tree tier-border-${grade.tier}">${lineageHTML(c.lineage)}</div>`;
  }).join('');
}

// ---------------------------------------------------------------------------
export function initUI({ getCreatures, getDex, onReset }) {
  const dexOverlay = el('overlay-dex');
  const linOverlay = el('overlay-lineage');
  const setOverlay = el('overlay-settings');
  const open = (overlay, render) => {
    if (render) render();
    overlay.hidden = false;
    void overlay.offsetWidth; // reflow so the entry transition runs
    overlay.classList.add('show');
  };
  const close = (overlay) => {
    overlay.classList.remove('show');
    setTimeout(() => { overlay.hidden = true; }, 250);
  };
  el('btn-dex').addEventListener('click', () => open(dexOverlay, () => renderDex(getDex())));
  el('btn-lineage').addEventListener('click', () => open(linOverlay, () => renderLineage(getCreatures())));
  el('btn-settings').addEventListener('click', () => open(setOverlay));
  for (const overlay of [dexOverlay, linOverlay, setOverlay]) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || e.target.closest('[data-close]')) close(overlay);
    });
  }
  // reset needs a second, angrier click
  const resetBtn = el('btn-reset');
  let armed = false;
  resetBtn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      resetBtn.textContent = 'really? everything? tap again';
      resetBtn.classList.add('confirm');
      setTimeout(() => {
        armed = false;
        resetBtn.textContent = 'reset everything';
        resetBtn.classList.remove('confirm');
      }, 3000);
    } else {
      onReset();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { close(dexOverlay); close(linOverlay); close(setOverlay); hideCelebration(); }
  });
}
