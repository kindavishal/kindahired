// Homepage motion and the live demo. The page reads fine without this file.
(() => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];

  // ---------- Header: lifts off the page once you scroll ----------
  const header = $(".site-header");
  header.classList.add("watch");
  const onScroll = () => header.classList.toggle("is-scrolled", scrollY > 8);
  addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  // ---------- Reveal on scroll ----------
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      seen.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -12% 0px" });
  $$(".reveal, .tile, .graph, .draw-mark").forEach((el) => seen.observe(el));

  // Run fn every ms while el is on screen.
  const whileVisible = (el, ms, fn) => {
    let t = null;
    new IntersectionObserver(([e]) => {
      clearInterval(t);
      if (e.isIntersecting && !still) t = setInterval(fn, ms);
    }).observe(el);
  };

  // ---------- Headline tokens ----------
  const faces = $$("[data-cycle] .tok-face");
  let face = 0;
  whileVisible($(".display"), 1800, () => {
    const cur = faces[face];
    face = (face + 1) % faces.length;
    cur.classList.replace("is-on", "is-out");
    faces[face].classList.remove("is-out");
    faces[face].classList.add("is-on");
    setTimeout(() => cur.classList.remove("is-out"), 500);
  });
  const sts = $$("[data-status] .st");
  let stIdx = 0;
  whileVisible($(".display"), 2600, () => {
    sts[stIdx].classList.remove("is-on");
    stIdx = (stIdx + 1) % sts.length;
    sts[stIdx].classList.add("is-on");
  });

  // ---------- Product demo ----------
  const I = (id, label, cls) => `<span class="src ${cls}" aria-label="${label}"><svg width="16" height="16"><use href="#${id}"/></svg></span>`;
  const src = {
    mail: I("i-mail", "Email", "src-mail"), in: I("i-in", "LinkedIn", "src-in"),
    x: I("i-x", "X", "src-x"), cal: I("i-cal", "Calendar", "src-cal"), board: I("i-board", "Job board", "src-x"),
  };
  const roles = [
    null, // the first role is already in the page
    {
      tile: ["L", "co-l"], title: "Product Marketing Manager", meta: "Lumen Health · you applied last week", fit: "Good fit",
      items: [
        ["mail", "<strong>Priya Shah</strong>, the recruiter, asked when you're free to talk", "3 days ago"],
        ["cal", "You're free Thursday at 4 pm and Friday morning", "This week"],
        ["in", "Priya's team lead looked at your profile", "Yesterday"],
      ],
      next: "You owe Priya a reply. It's been 3 days. A reply with two times that work for you is ready.",
      b1: "Open the email", b2: "Remind me tomorrow",
      ping: "Priya at Lumen Health asked for times 3 days ago. Your reply is ready.",
    },
    {
      tile: ["P", "co-p"], title: "Community Manager", meta: "Parcel · closes Friday", fit: "Strong fit",
      items: [
        ["board", "Posted on Parcel's careers page", "Today"],
        ["in", "<strong>Ana Ruiz</strong>, from your old team, works there now", "Since 2024"],
        ["x", "Parcel's founder posted about growing the community team", "3 days ago"],
      ],
      next: "Ask Ana for a referral before you apply. Your resume and cover note are ready, made from your own experience.",
      b1: "Copy note to Ana", b2: "Open the application",
      ping: "Parcel is hiring a Community Manager, and Ana from your old team works there. Ask her first.",
    },
  ];
  const detail = $(".app-detail");
  const f = (k) => $(`[data-f="${k}"]`);
  // Capture the first role from the page so we can come back to it.
  roles[0] = {
    tile: ["N", "co-n"], title: f("title").textContent, meta: f("meta").textContent, fit: f("fit").textContent.trim(),
    itemsHTML: f("items").innerHTML, next: f("next").textContent, b1: f("b1").textContent, b2: f("b2").textContent, ping: f("ping").textContent,
  };
  const tabs = $$(".q");
  let current = 0;
  let touched = false;
  const show = (n) => {
    if (n === current) return;
    current = n;
    tabs.forEach((t, i) => { t.classList.toggle("is-on", i === n); t.setAttribute("aria-selected", String(i === n)); });
    const r = roles[n];
    detail.classList.add("swap");
    setTimeout(() => {
      const tile = f("tile");
      tile.textContent = r.tile[0];
      tile.className = `co-tile ${r.tile[1]}`;
      f("title").textContent = r.title;
      f("meta").textContent = r.meta;
      f("fit").lastElementChild.textContent = r.fit;
      f("items").innerHTML = r.itemsHTML ?? r.items.map(([s, what, when]) => `<li>${src[s]}<span class="what">${what}</span><span class="when">${when}</span></li>`).join("");
      $$("li", f("items")).forEach((li, i) => li.style.setProperty("--i", i));
      f("next").textContent = r.next;
      f("b1").textContent = r.b1;
      f("b1").classList.remove("is-done");
      f("b2").textContent = r.b2;
      f("ping").textContent = r.ping;
      requestAnimationFrame(() => requestAnimationFrame(() => detail.classList.remove("swap")));
    }, still ? 0 : 220);
  };
  tabs.forEach((t, i) => t.addEventListener("click", () => { touched = true; show(i); }));
  // Arrow keys move between tabs.
  $(".queue").addEventListener("keydown", (e) => {
    const d = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key];
    if (!d) return;
    e.preventDefault();
    touched = true;
    const n = (current + d + tabs.length) % tabs.length;
    show(n);
    tabs[n].focus();
  });
  f("b1").addEventListener("click", (e) => {
    const b = e.currentTarget;
    if (!b.textContent.startsWith("Copy")) return;
    const was = b.textContent;
    b.textContent = "Copied. Paste it in LinkedIn";
    b.classList.add("is-done");
    setTimeout(() => { if (b.textContent.startsWith("Copied")) { b.textContent = was; b.classList.remove("is-done"); } }, 2200);
  });
  // The Telegram ping drops in once the stage is on screen; the demo moves on by itself until someone clicks.
  const stage = $(".stage");
  new IntersectionObserver(([e], o) => {
    if (!e.isIntersecting) return;
    setTimeout(() => $(".ping-float").classList.add("in"), still ? 0 : 700);
    o.disconnect();
  }, { threshold: 0.35 }).observe(stage);
  whileVisible(stage, 6500, () => { if (!touched) show((current + 1) % roles.length); });
  if (!still) stage.addEventListener("pointerenter", () => { touched = true; }, { once: true });

  // ---------- Steps with a scene for each ----------
  const steps = $$(".step-c");
  const scenes = $$(".scene");
  const list = $("#steps");
  const STEP_MS = 6000;
  list.style.setProperty("--step-ms", `${STEP_MS}ms`);
  let step = 0, timer = null, visible = false;
  const pick = (n) => {
    step = n;
    steps.forEach((s, i) => {
      s.classList.toggle("is-on", i === n);
      s.classList.remove("play");
      $("button", s).setAttribute("aria-expanded", String(i === n));
    });
    scenes.forEach((s, i) => s.classList.toggle("is-on", i === n));
    schedule();
  };
  const schedule = () => {
    clearTimeout(timer);
    if (!visible || still) return;
    const s = steps[step];
    void s.offsetWidth; // restart the bar
    s.classList.add("play");
    timer = setTimeout(() => pick((step + 1) % steps.length), STEP_MS);
  };
  steps.forEach((s, i) => $("button", s).addEventListener("click", () => pick(i)));
  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    if (visible) schedule(); else { clearTimeout(timer); steps[step].classList.remove("play"); }
  }, { threshold: 0.4 }).observe($(".flow"));
  // Pausing on hover keeps the bar and the timer in step.
  let left = 0;
  list.addEventListener("pointerenter", () => {
    if (!timer || still) return;
    list.classList.add("paused");
    clearTimeout(timer);
    const anim = steps[step].querySelector(".bar i").getAnimations()[0];
    left = anim ? STEP_MS - (anim.currentTime ?? 0) : STEP_MS;
  });
  list.addEventListener("pointerleave", () => {
    if (!list.classList.contains("paused")) return;
    list.classList.remove("paused");
    if (!visible) return;
    timer = setTimeout(() => pick((step + 1) % steps.length), Math.max(200, left));
  });

  // ---------- FAQ: open and close smoothly ----------
  if (!still) $$(".faq-c details").forEach((d) => {
    const summary = $("summary", d), ans = $(".ans", d);
    summary.addEventListener("click", (e) => {
      e.preventDefault();
      if (d.open) {
        const a = ans.animate([{ height: `${ans.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
        d.classList.add("closing");
        a.onfinish = () => { d.open = false; d.classList.remove("closing"); };
      } else {
        d.open = true;
        ans.animate([{ height: "0px", opacity: 0 }, { height: `${ans.offsetHeight}px`, opacity: 1 }], { duration: 320, easing: "cubic-bezier(.16,1,.3,1)" });
      }
    });
  });
})();
