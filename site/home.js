// Homepage only: headline tokens, the live demo and the story switch.
// Shared behaviour (header, reveal, step tabs, FAQ) lives in site.js, which loads first.
(() => {
  const { still, $, all: $$, whileVisible } = window.kh;

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
  const L = (id, label, size = 16) => `<span class="src" aria-label="${label}"><svg width="${size}" height="${size}"><use href="#${id}"/></svg></span>`;
  const src = {
    mail: L("lg-gmail", "Email"), in: L("lg-linkedin", "LinkedIn"), x: L("lg-x", "X", 14),
    board: L("lg-greenhouse", "Job board"), wf: L("lg-wellfound", "Wellfound"),
  };
  const roles = [
    null, // the first role is already in the page
    {
      tile: ["L", "co-l"], title: "Product Marketing Manager", meta: "Lumen Health · you applied last week", fit: "Good fit",
      items: [
        ["mail", "<strong>Priya Shah</strong>, the recruiter, asked when you're free to talk", "3 days ago"],
        ["mail", "Priya followed up: the team would like to meet this week", "Yesterday"],
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
        ["wf", "Also listed on Wellfound, with the salary range", "Today"],
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

  // ---------- Story: how it went, and how it goes with kindahired ----------
  const segs = $$(".seg button");
  const tline = $(".tline");
  let segTouched = false;
  const mode = (m) => {
    segs.forEach((b, i) => { b.classList.toggle("is-on", i === m); b.setAttribute("aria-selected", String(i === m)); });
    tline.dataset.mode = String(m);
    $$("li", tline).forEach((li) => { li.style.animation = "none"; void li.offsetWidth; li.style.animation = ""; });
  };
  segs.forEach((b, i) => b.addEventListener("click", () => { segTouched = true; mode(i); }));
  whileVisible($(".story-visual"), 4500, () => { if (!segTouched) mode(tline.dataset.mode === "0" ? 1 : 0); });

})();
