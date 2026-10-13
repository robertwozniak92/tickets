(() => {
  "use strict";

  // ---------- Geometry (Figma design units: one ticket is 281 × 646) ----------
  const TW = 281;            // ticket width
  const RECT = 442;          // rectangular body height = strip pitch
  const COM = { x: 140.5, y: 300 }; // rough centre of mass
  const DESIGN_H = 1117;     // Figma frame height the ticket was drawn against

  // The bottom tab of one ticket is exactly the V-notch cut into the next one,
  // so tickets tessellate into a continuous strip with a perforated V between them.
  const PATH_OUTLINE =
    "M0 0H27L109.5 183.4A34 34 0 0 0 171.5 183.4L254 0H281V442H254L171.5 625.4A34 34 0 0 1 109.5 625.4L27 442H0Z";
  const PATH_CUT = "M0 0H27L109.5 183.4A34 34 0 0 0 171.5 183.4L254 0H281";
  const PATH_MARK = "M103.5 546H177.5L140.5 627Z";

  const ISSUES = [
    "Laptop won’t power on",
    "Printer jammed again",
    "Can’t connect to VPN",
    "Forgot my password",
    "Wi‑Fi keeps dropping",
    "Monitor is flickering",
    "Outlook won’t sync",
    "Need admin rights",
    "Zoom audio broken",
    "Spilled coffee on keyboard",
    "Blue screen of death",
    "Mouse not working",
    "New hire laptop setup",
    "Locked out of SSO",
    "Shared drive missing",
    "Phone won’t charge",
  ];

  // ---------- Tuning ----------
  const TEAR = 240;            // design units of pull before the perforation gives
  const STRIP_K = 140, STRIP_C = 8;     // strip spring (underdamped → recoil)
  const SWAY_K = 50, SWAY_C = 3.2;      // strip pendulum
  const GRAB_K = 1100;                  // hand → paper spring
  const GRAB_C = 2 * Math.sqrt(GRAB_K) * 0.7;
  const LIFT_Z = 60;                    // px a held ticket rises toward the viewer
  const MAX_TILT = 0.38;                // rad, 3D paper tilt clamp
  const MAX_FREE = 14;
  const PILE_MAX = 8;                   // fixed tickets kept visible on the done pile
  const PILE_SCALE = 0.42;              // size of a filed ticket relative to a live one
  const FILE_DELAY = 1000;              // ms to admire the FIXED stamp before it's filed
  const FILE_TIME = 650;                // ms flight to the pile
  const SUBSTEPS = 6;

  // ---------- State ----------
  const stage = document.getElementById("stage");
  // Tickets still joined in the machine live in one layer so the strip casts a
  // single shadow (per-ticket shadows would bleed into each perforated notch).
  const stripLayer = document.createElement("div");
  stripLayer.className = "strip-layer";
  stage.appendChild(stripLayer);
  const hint = document.getElementById("hint");
  const PAPERS = [
    { name: "Blue", hex: "#9bcfe0" },   // the colour from the Figma design
    { name: "Pink", hex: "#f4b6c9" },
    { name: "Yellow", hex: "#f3e08a" },
    { name: "Mint", hex: "#a8e0c0" },
    { name: "Orange", hex: "#f6b783" },
    { name: "Lilac", hex: "#c8b8ec" },
    { name: "White", hex: "#ecebe6" },
  ];
  const palette = document.getElementById("palette");
  const swatchBox = document.getElementById("swatches");
  const paletteToggle = document.getElementById("palette-toggle");
  const counts = {
    new: document.getElementById("count-open"),
    working: document.getElementById("count-working"),
    fixed: document.getElementById("count-fixed"),
  };

  const view = { W: 0, H: 0, s: 1, rest: 0 };
  const pointer = { id: null, x: 0, y: 0, vx: 0, vy: 0, t: 0, downX: 0, downY: 0, downT: 0 };
  const strip = { y: 0, v: 0, a: 0, va: 0, tilt: 0, tickets: [], drag: null };
  const free = [];
  const pile = [];          // fixed tickets, oldest first
  let fixedTotal = 0;
  let held = null;           // free ticket currently in hand
  let nextNum = 970;
  let issueIdx = 0;
  let zTop = 100;           // free tickets stack above the pile (z 1..PILE_MAX)
  let tornCount = 0;
  let startedWork = false;
  let lastInteraction = performance.now();

  // ---------- DOM ----------
  const railText = Array(12).fill("Fixify · ").join("");

  function createTicket() {
    const num = nextNum++;
    const issue = ISSUES[issueIdx++ % ISSUES.length];
    const el = document.createElement("div");
    el.className = "ticket";
    el.dataset.status = "new";
    applyPaper(el, paperColor);
    el.innerHTML = `
      <div class="paper">
        <svg width="281" height="646" viewBox="0 0 281 646" aria-hidden="true">
          <path class="fill" d="${PATH_OUTLINE}"/>
          <path class="mark" d="${PATH_MARK}"/>
          <path class="cut" d="${PATH_CUT}"/>
        </svg>
        <div class="rail rail-l"><span>${railText}</span></div>
        <div class="rail rail-r"><span>${railText}</span></div>
        <div class="num">T<b>${num}</b></div>
        <div class="desc">${issue}</div>
        <div class="stamp"><span class="stamp-label"></span><small class="stamp-time"></small></div>
        <div class="sheen"></div>
      </div>`;
    const paper = el.querySelector(".paper");
    paper.style.clipPath = `path("${PATH_OUTLINE}")`;
    el.setAttribute("aria-label", `Ticket T${num}: ${issue}`);
    stage.appendChild(el);
    return {
      el,
      paper,
      sheen: el.querySelector(".sheen"),
      stampLabel: el.querySelector(".stamp-label"),
      stampTime: el.querySelector(".stamp-time"),
      num,
      issue,
      status: "new",
      startedAt: 0,
      shownSecs: -1,
      // free-body state (px, rad)
      x: 0, y: 0, a: 0, vx: 0, vy: 0, va: 0,
      tx: 0, ty: 0, z: 0, // 3D tilt + lift
      grab: null,
    };
  }

  function refreshStripClasses() {
    strip.tickets.forEach((t, i) => {
      t.el.classList.toggle("is-grabbable", i === 0);
      t.el.style.zIndex = String(10000 - i);
    });
  }

  function setSheen(t, tx, ty, base) {
    // Light comes from the upper left; tilting toward it brightens, away darkens.
    const lx = 30 - ty * 120;
    const ly = 20 + tx * 120;
    const shade = Math.min(0.35, base + Math.abs(tx) * 0.5 + Math.abs(ty) * 0.5);
    t.sheen.style.background =
      `radial-gradient(120% 70% at ${lx.toFixed(1)}% ${ly.toFixed(1)}%, rgba(255,255,255,0.32), rgba(255,255,255,0) 60%),` +
      `linear-gradient(rgba(0,20,30,${shade.toFixed(3)}), rgba(0,20,30,${shade.toFixed(3)}))`;
  }

  // ---------- Layout ----------
  function layout() {
    view.W = window.innerWidth;
    view.H = window.innerHeight;
    view.s = Math.max(0.42, Math.min(view.H / DESIGN_H, (view.W * 0.46) / TW, 1.15));
    // At rest the hanging ticket's tip sits just under half the screen height.
    view.rest = view.H * 0.49 - 645 * view.s;
    stage.style.perspective = `${Math.round(Math.max(view.W, view.H) * 1.1)}px`;
    stage.style.perspectiveOrigin = "50% 0%";
    stripLayer.style.perspective = stage.style.perspective;
    stripLayer.style.perspectiveOrigin = "50% 0%";
    document.documentElement.style.setProperty("--s", view.s.toFixed(4));
  }

  function fillStrip() {
    while (strip.tickets.length < 4) {
      const t = createTicket();
      stripLayer.appendChild(t.el);
      strip.tickets.push(t);
    }
    refreshStripClasses();
  }

  // ---------- Strip ----------
  function stripLocalToWorld(lx, ly) {
    // strip-local coords are relative to the slot pivot (W/2, 0), unrotated
    const c = Math.cos(strip.a), sn = Math.sin(strip.a);
    return { x: view.W / 2 + lx * c - ly * sn, y: lx * sn + ly * c };
  }

  function worldToStripLocal(x, y) {
    const dx = x - view.W / 2, dy = y;
    const c = Math.cos(-strip.a), sn = Math.sin(-strip.a);
    return { x: dx * c - dy * sn, y: dx * sn + dy * c };
  }

  function stepStrip(dt) {
    const s = view.s;
    if (strip.drag) {
      const d = strip.drag;
      // Pull length is measured radially from the slot so sideways tugs swing the strip.
      const r = Math.hypot(pointer.x - view.W / 2, pointer.y);
      let pull = r - d.r0;
      if (pull < 0) pull *= 0.25; // can't push it back into the machine
      const target = d.y0 + pull;
      strip.v = (target - strip.y) / dt;
      strip.y = target;

      const local = { x: d.lx, y: d.ly + (strip.y - d.y0) };
      let aT = Math.atan2(pointer.y, pointer.x - view.W / 2) - Math.atan2(local.y, local.x);
      aT = clamp(aT, -0.32, 0.32);
      const prev = strip.a;
      strip.a += (aT - strip.a) * Math.min(1, dt * 22);
      strip.va = (strip.a - prev) / dt;

      const over = (strip.y - view.rest) / s;
      if (over > TEAR * 0.75) {
        // tension shiver just before it tears
        strip.a += (Math.random() - 0.5) * 0.006 * (over / TEAR);
      }
      if (over > TEAR) tear();
    } else {
      strip.v += (STRIP_K * (view.rest - strip.y) - STRIP_C * strip.v) * dt;
      strip.y += strip.v * dt;
      strip.va += (-SWAY_K * strip.a - SWAY_C * strip.va) * dt;
      strip.a += strip.va * dt;
    }
    // Lean the strip toward the viewer the further it's pulled out of the slot.
    const pullFrac = clamp((strip.y - view.rest) / (TEAR * s), -1, 1.2);
    const tiltT = 0.05 + pullFrac * 0.22;
    strip.tilt += (tiltT - strip.tilt) * Math.min(1, dt * 12);
  }

  function renderStrip() {
    const s = view.s;
    const yawFromSway = clamp(-strip.va * 0.04, -0.15, 0.15);
    strip.tickets.forEach((t, i) => {
      t.el.style.transform =
        `translate3d(${view.W / 2}px,0,0) rotate(${strip.a}rad) rotateX(${strip.tilt}rad) rotateY(${yawFromSway}rad)` +
        ` translate(${-COM.x * s}px, ${strip.y - i * RECT * s}px) scale(${s})`;
      if (i < 2) setSheen(t, strip.tilt * 0.6, yawFromSway, 0);
    });
  }

  function tear() {
    const s = view.s;
    const t = strip.tickets.shift();
    stage.appendChild(t.el); // leaves the strip layer and becomes its own sheet
    strip.drag = null;

    // Hand the bottom ticket over to free-body physics without a visual jump.
    const comLocalY = strip.y + COM.y * s;
    const com = stripLocalToWorld(0, comLocalY);
    t.x = com.x; t.y = com.y; t.a = strip.a;
    t.vx = pointer.vx; t.vy = Math.min(strip.v, 2500 * s);
    t.va = strip.va;
    t.tx = strip.tilt; t.ty = 0; t.z = LIFT_Z * 0.6;
    t.grab = grabPointFor(t, pointer.x, pointer.y);
    t.el.classList.remove("is-grabbable");
    t.el.classList.add("is-free", "is-grabbable", "is-held");
    t.el.style.zIndex = "20000";
    free.push(t);
    held = t;

    // Remaining strip snaps up (tension released), then the machine feeds it back down.
    strip.y -= RECT * s;
    strip.v = -1100 * s;
    strip.va += (Math.random() - 0.5) * 1.2;
    fillStrip();

    tornCount++;
    if (tornCount === 1) setHint("Tap a ticket to start working on it");
    trimFree();
    updateCounts();
  }

  // ---------- Free tickets ----------
  function grabPointFor(t, px, py) {
    const s = view.s;
    const dx = px - t.x, dy = py - t.y;
    const c = Math.cos(-t.a), sn = Math.sin(-t.a);
    return { lx: (dx * c - dy * sn) / s, ly: (dx * sn + dy * c) / s };
  }

  function stepFree(t, dt) {
    const s = view.s;
    const w = TW * s, h = 646 * s;
    const I = (w * w + h * h) / 12;
    let fx = 0, fy = 0, tq = 0;

    if (t.grab) {
      const c = Math.cos(t.a), sn = Math.sin(t.a);
      const rx = (t.grab.lx * c - t.grab.ly * sn) * s;
      const ry = (t.grab.lx * sn + t.grab.ly * c) * s;
      const gvx = t.vx - t.va * ry, gvy = t.vy + t.va * rx;
      const Fx = GRAB_K * (pointer.x - (t.x + rx)) + GRAB_C * (pointer.vx - gvx);
      const Fy = GRAB_K * (pointer.y - (t.y + ry)) + GRAB_C * (pointer.vy - gvy);
      fx += Fx; fy += Fy;
      tq += rx * Fy - ry * Fx;
    }

    // Desk friction acts at the centre of mass, so paper pulled by a corner trails behind the hand.
    const lin = t.grab ? 5 : 2.6;
    const ang = t.grab ? 3 : 3.5;
    fx -= lin * t.vx; fy -= lin * t.vy;

    t.vx += fx * dt; t.vy += fy * dt;
    t.va += (tq / I - ang * t.va) * dt;

    if (!t.grab) {
      // a little dry friction so things actually come to rest
      const sp = Math.hypot(t.vx, t.vy);
      if (sp > 0) {
        const k = Math.max(0, sp - 420 * s * dt) / sp;
        t.vx *= k; t.vy *= k;
      }
      t.va -= Math.sign(t.va) * Math.min(Math.abs(t.va), 2.5 * dt);
    }

    t.x += t.vx * dt; t.y += t.vy * dt; t.a += t.va * dt;

    // keep the centre on screen; bounce softly off the edges
    if (t.x < 0) { t.x = 0; t.vx = Math.abs(t.vx) * 0.4; }
    if (t.x > view.W) { t.x = view.W; t.vx = -Math.abs(t.vx) * 0.4; }
    if (t.y < 0) { t.y = 0; t.vy = Math.abs(t.vy) * 0.4; }
    if (t.y > view.H) { t.y = view.H; t.vy = -Math.abs(t.vy) * 0.4; }
  }

  function step3D(t, dt) {
    // Target tilt: the spot under your finger lifts toward you and the rest droops,
    // plus the sheet leans into the direction it's travelling (air catching it).
    let txT = 0, tyT = 0, zT = 0;
    const s = view.s;
    const c = Math.cos(-t.a), sn = Math.sin(-t.a);
    const lvx = (t.vx * c - t.vy * sn) / s, lvy = (t.vx * sn + t.vy * c) / s;
    if (t.grab) {
      txT = (t.grab.ly / 323) * 0.22;
      tyT = -(t.grab.lx / 140) * 0.22;
      zT = LIFT_Z;
    }
    txT += clamp(-lvy * 0.00018, -0.2, 0.2);
    tyT += clamp(lvx * 0.00018, -0.2, 0.2);
    txT = clamp(txT, -MAX_TILT, MAX_TILT);
    tyT = clamp(tyT, -MAX_TILT, MAX_TILT);
    const k = Math.min(1, dt * (t.grab ? 10 : 7));
    t.tx += (txT - t.tx) * k;
    t.ty += (tyT - t.ty) * k;
    t.z += (zT - t.z) * Math.min(1, dt * 12);
  }

  function renderFree(t) {
    const s = view.s;
    t.el.style.transform =
      `translate3d(${t.x}px,${t.y}px,${t.z}px) rotate(${t.a}rad) rotateX(${t.tx}rad) rotateY(${t.ty}rad)` +
      ` scale(${s}) translate(${-COM.x}px,${-COM.y}px)`;
    setSheen(t, t.tx, t.ty, 0);

    if (t.status === "working") {
      const secs = Math.floor((performance.now() - t.startedAt) / 1000);
      if (secs !== t.shownSecs) {
        t.shownSecs = secs;
        t.stampTime.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
      }
    }
  }

  function advanceStatus(t) {
    if (t.status === "new") {
      t.status = "working";
      t.startedAt = performance.now();
      t.shownSecs = -1;
      t.stampLabel.textContent = "Working";
      if (!startedWork) {
        startedWork = true;
        setHint("Tap again when it’s fixed");
        setTimeout(() => tornCount > 0 && setHint(""), 3500);
      }
    } else if (t.status === "working") {
      t.status = "fixed";
      const secs = Math.floor((performance.now() - t.startedAt) / 1000);
      t.stampLabel.textContent = "Fixed";
      t.stampTime.textContent = `in ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
      t.fileAt = performance.now() + FILE_DELAY;
      fixedTotal++;
    }
    t.el.dataset.status = t.status;
    // a little hop so the stamp feels physical
    t.z = 30;
    t.va += (Math.random() - 0.5) * 0.8;
    updateCounts();
  }

  function trimFree() {
    while (free.length > MAX_FREE) {
      const idx = free.findIndex((t) => t.status === "fixed" && t !== held);
      const victim = free.splice(idx >= 0 ? idx : 0, 1)[0];
      if (victim === held) { free.push(victim); break; }
      victim.el.style.transition = "opacity .4s ease";
      victim.el.style.opacity = "0";
      setTimeout(() => victim.el.remove(), 450);
    }
  }

  // ---------- Done pile ----------
  function fileTicket(t, now) {
    free.splice(free.indexOf(t), 1);
    t.el.classList.remove("is-grabbable", "is-held");
    t.anim = { t0: now, x: t.x, y: t.y, a: t.a, tx: t.tx, ty: t.ty, z: t.z };
    // each filed ticket lands slightly askew, like a real stack of stubs
    t.pileA = -0.06 + (Math.random() - 0.5) * 0.22;
    t.pileDx = (Math.random() - 0.5) * 10;
    pile.push(t);
    while (pile.length > PILE_MAX) {
      const old = pile.shift();
      old.el.style.transition = "opacity .4s ease";
      old.el.style.opacity = "0";
      setTimeout(() => old.el.remove(), 450);
    }
    pile.forEach((p, i) => { p.el.style.zIndex = String(i + 1); });
  }

  function renderPile(now) {
    const s = view.s, k1 = PILE_SCALE;
    pile.forEach((t, i) => {
      const tx = view.W - 28 - (TW / 2) * s * k1 + t.pileDx;
      const ty = view.H - 22 - (646 - COM.y) * s * k1 - i * 4;
      const p = Math.min(1, (now - t.anim.t0) / FILE_TIME);
      const e = 1 - Math.pow(1 - p, 3);
      let from = t.anim.a;
      while (from - t.pileA > Math.PI) from -= 2 * Math.PI;
      while (from - t.pileA < -Math.PI) from += 2 * Math.PI;
      const x = t.anim.x + (tx - t.anim.x) * e;
      const y = t.anim.y + (ty - t.anim.y) * e;
      const a = from + (t.pileA - from) * e;
      const k = 1 + (k1 - 1) * e;
      const z = t.anim.z * (1 - e) + Math.sin(Math.PI * p) * 70; // arcs up toward you mid-flight
      const rx = t.anim.tx * (1 - e), ry = t.anim.ty * (1 - e);
      t.el.style.transform =
        `translate3d(${x}px,${y}px,${z}px) rotate(${a}rad) rotateX(${rx}rad) rotateY(${ry}rad)` +
        ` scale(${s * k}) translate(${-COM.x}px,${-COM.y}px)`;
      if (p < 1) setSheen(t, rx, ry, 0);
    });
  }

  function updateCounts() {
    const c = { new: 0, working: 0, fixed: 0 };
    free.forEach((t) => { if (t.status !== "fixed") c[t.status]++; });
    c.fixed = fixedTotal;
    for (const k in c) counts[k].textContent = c[k];
  }

  function setHint(text) {
    if (!text) { hint.classList.add("is-hidden"); return; }
    hint.textContent = text;
    hint.classList.remove("is-hidden");
  }

  // ---------- Input ----------
  function findTicket(target) {
    const el = target.closest && target.closest(".ticket");
    if (!el) return null;
    return free.find((t) => t.el === el) || strip.tickets.find((t) => t.el === el) || null;
  }

  stage.addEventListener("pointerdown", (e) => {
    if (pointer.id !== null) return;
    const t = findTicket(e.target);
    if (!t) return;
    e.preventDefault();
    pointer.id = e.pointerId;
    pointer.x = pointer.downX = e.clientX;
    pointer.y = pointer.downY = e.clientY;
    pointer.vx = pointer.vy = 0;
    pointer.t = pointer.downT = performance.now();
    lastInteraction = pointer.t;

    if (strip.tickets[0] === t) {
      const local = worldToStripLocal(e.clientX, e.clientY);
      strip.drag = { y0: strip.y, lx: local.x, ly: local.y, r0: Math.hypot(e.clientX - view.W / 2, e.clientY) };
      t.el.classList.add("is-held");
    } else {
      held = t;
      t.grab = grabPointFor(t, e.clientX, e.clientY);
      t.el.classList.add("is-held");
      t.el.style.zIndex = "20000";
    }
  });

  window.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointer.id) return;
    const now = performance.now();
    const dt = Math.max(1, now - pointer.t) / 1000;
    // smoothed pointer velocity for throws
    pointer.vx += ((e.clientX - pointer.x) / dt - pointer.vx) * 0.5;
    pointer.vy += ((e.clientY - pointer.y) / dt - pointer.vy) * 0.5;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.t = now;
  });

  function release(e) {
    if (e.pointerId !== pointer.id) return;
    const moved = Math.hypot(e.clientX - pointer.downX, e.clientY - pointer.downY);
    const quick = performance.now() - pointer.downT < 350;
    if (strip.drag) {
      strip.drag = null;
      if (strip.tickets[0]) strip.tickets[0].el.classList.remove("is-held");
      if (moved < 6) strip.v += 500 * view.s; // a tap gives the strip a little tug
    }
    if (held) {
      const t = held;
      // fade out the pointer velocity if the hand had stopped before letting go
      if (performance.now() - pointer.t > 80) { pointer.vx = 0; pointer.vy = 0; }
      t.grab = null;
      t.el.classList.remove("is-held");
      t.el.style.zIndex = String(++zTop);
      if (moved < 6 && quick) advanceStatus(t);
      held = null;
    }
    pointer.id = null;
    lastInteraction = performance.now();
  }
  window.addEventListener("pointerup", release);
  window.addEventListener("pointercancel", release);
  window.addEventListener("resize", () => {
    const oldRest = view.rest;
    layout();
    strip.y += view.rest - oldRest;
  });

  // ---------- Loop ----------
  let last = performance.now();
  function frame(now) {
    const dt = Math.min(1 / 30, (now - last) / 1000);
    last = now;

    // pointer velocity decays when the mouse is held still
    if (pointer.id !== null && now - pointer.t > 50) { pointer.vx *= 0.8; pointer.vy *= 0.8; }

    // the machine nudges a ticket out now and then until someone takes one
    if (tornCount === 0 && !strip.drag && now - lastInteraction > 4500) {
      strip.v += 380 * view.s;
      lastInteraction = now;
    }

    const h = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) {
      stepStrip(h);
      for (const t of free) stepFree(t, h);
    }
    for (const t of free.slice()) {
      if (t.fileAt && now >= t.fileAt && t !== held) fileTicket(t, now);
    }
    for (const t of free) { step3D(t, dt); renderFree(t); }
    renderPile(now);
    renderStrip();
    requestAnimationFrame(frame);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ---------- Paper colour ----------
  function inkFor(hex) {
    const n = parseInt(hex.slice(1), 16);
    const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
    return L < 0.22 ? "#fff" : "#000";
  }

  function applyPaper(el, hex) {
    el.style.setProperty("--paper", hex);
    el.style.setProperty("--ink", inkFor(hex));
  }

  function setPaper(hex, save = true) {
    paperColor = hex;
    // Only tickets still in the machine change; torn-off ones keep their colour.
    strip.tickets.forEach((t) => applyPaper(t.el, paperColor));
    document.documentElement.style.setProperty("--paper", paperColor);
    swatchBox.querySelectorAll(".swatch").forEach((b) => {
      const on = b.dataset.hex === paperColor;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    if (save) { try { localStorage.setItem("fixify-paper", paperColor); } catch (e) { /* storage blocked */ } }
  }

  // Mouse users get the colours on hover; touch users tap the dot to open/close.
  const canHover = window.matchMedia("(hover: hover) and (pointer: fine)");
  let closeTimer = 0;
  function setPaletteOpen(open) {
    clearTimeout(closeTimer);
    if (open) {
      // Animate to the real content size so closing starts moving immediately.
      // (layout offsets ignore the swatches' tucked-away transforms)
      const first = swatchBox.firstElementChild, last = swatchBox.lastElementChild;
      swatchBox.style.setProperty("--full-w", last.offsetLeft + last.offsetWidth - first.offsetLeft + "px");
      swatchBox.style.setProperty("--full-h", last.offsetTop + last.offsetHeight - first.offsetTop + "px");
    }
    palette.classList.toggle("is-open", open);
    paletteToggle.setAttribute("aria-expanded", String(open));
  }
  palette.addEventListener("pointerenter", (e) => { if (e.pointerType === "mouse" && canHover.matches) setPaletteOpen(true); });
  palette.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "mouse" && canHover.matches) closeTimer = setTimeout(() => setPaletteOpen(false), 250);
  });
  // Act on touch release straight away (iOS Safari can delay or swallow the
  // synthetic click); mouse and keyboard still go through the normal click.
  function onTap(el, fn) {
    let handled = false;
    el.addEventListener("pointerup", (e) => {
      if (e.pointerType === "mouse") return;
      e.preventDefault();
      handled = true;
      setTimeout(() => { handled = false; }, 600);
      fn();
    });
    el.addEventListener("click", () => { if (!handled) fn(); });
  }
  onTap(paletteToggle, () => setPaletteOpen(!palette.classList.contains("is-open")));
  palette.addEventListener("focusout", (e) => { if (!palette.contains(e.relatedTarget)) setPaletteOpen(false); });
  palette.addEventListener("keydown", (e) => { if (e.key === "Escape") { setPaletteOpen(false); paletteToggle.focus(); } });
  document.addEventListener("pointerdown", (e) => { if (!palette.contains(e.target)) setPaletteOpen(false); });

  PAPERS.forEach((p, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch";
    b.dataset.hex = p.hex;
    b.style.setProperty("--c", p.hex);
    b.style.setProperty("--i", i);
    b.setAttribute("role", "radio");
    b.setAttribute("aria-label", p.name);
    b.title = p.name;
    onTap(b, () => {
      setPaper(p.hex);
      if (!canHover.matches) setTimeout(() => setPaletteOpen(false), 220);
    });
    swatchBox.appendChild(b);
  });
  swatchBox.addEventListener("keydown", (e) => {
    const dir = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!dir) return;
    e.preventDefault();
    const i = PAPERS.findIndex((p) => p.hex === paperColor);
    const next = PAPERS[(Math.max(0, i) + dir + PAPERS.length) % PAPERS.length];
    setPaper(next.hex);
    swatchBox.querySelector(`[data-hex="${next.hex}"]`).focus();
  });

  let paperColor = PAPERS[0].hex;
  try {
    const saved = localStorage.getItem("fixify-paper");
    if (PAPERS.some((p) => p.hex === saved)) paperColor = saved;
  } catch (e) { /* storage blocked */ }

  layout();
  fillStrip();
  setPaper(paperColor, false);
  strip.y = view.rest - 120 * view.s; // feed in from the slot on load
  strip.v = 0;
  requestAnimationFrame(frame);
})();
