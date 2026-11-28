// Shared behaviour for every page: the floating header, reveal on scroll,
// tabbed step panels, and FAQ answers that open smoothly. Pages read fine without it.
(() => {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const $ = (s, el = document) => el.querySelector(s);
  const all = (s, el = document) => [...el.querySelectorAll(s)];

  // Run fn every ms while el is on screen.
  const whileVisible = (el, ms, fn) => {
    if (!el) return;
    let t = null;
    new IntersectionObserver(([e]) => {
      clearInterval(t);
      if (e.isIntersecting && !still) t = setInterval(fn, ms);
    }).observe(el);
  };
  window.kh = { still, $, all, whileVisible };

  // ---------- Header: lifts off the page once you scroll ----------
  const header = $(".site-header");
  if (header) {
    header.classList.add("watch");
    const onScroll = () => header.classList.toggle("is-scrolled", scrollY > 8);
    addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  // ---------- Reveal on scroll ----------
  const seen = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      seen.unobserve(e.target);
    }
  }, { rootMargin: "0px 0px -6% 0px" });
  all(".reveal, .tile, .draw-mark").forEach((el) => seen.observe(el));

  // ---------- A framed product shot: its floating message drops in once it's on screen ----------
  all(".stage").forEach((stage) => {
    const ping = $(".ping-float", stage);
    if (!ping) return;
    new IntersectionObserver(([e], o) => {
      if (!e.isIntersecting) return;
      setTimeout(() => ping.classList.add("in"), still ? 0 : 700);
      o.disconnect();
    }, { threshold: 0.35 }).observe(stage);
  });

  // ---------- Tabbed step panels: tabs on top, the visual and its sentence beneath ----------
  const STEP_MS = 6500;
  all("[data-tabs]").forEach((panel) => {
    const tabs = all(".tp-tab", panel);
    const scenes = all(".scene", panel);
    panel.style.setProperty("--step-ms", `${STEP_MS}ms`);
    let step = 0, timer = null, visible = false, left = 0;
    const pick = (n, focus = false) => {
      step = n;
      tabs.forEach((t, i) => {
        t.classList.toggle("is-on", i === n);
        t.classList.remove("play");
        t.setAttribute("aria-selected", String(i === n));
        t.tabIndex = i === n ? 0 : -1;
      });
      scenes.forEach((s, i) => s.classList.toggle("is-on", i === n));
      if (focus) tabs[n].focus();
      schedule();
    };
    const schedule = (ms = STEP_MS) => {
      clearTimeout(timer);
      if (!visible || still) return;
      const t = tabs[step];
      void t.offsetWidth; // restart the bar
      t.classList.add("play");
      timer = setTimeout(() => pick((step + 1) % tabs.length), ms);
    };
    tabs.forEach((t, i) => {
      t.tabIndex = i === 0 ? 0 : -1;
      t.addEventListener("click", () => pick(i));
    });
    $(".tp-tabs", panel).addEventListener("keydown", (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
      if (!d) return;
      e.preventDefault();
      pick((step + d + tabs.length) % tabs.length, true);
    });
    new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible) schedule(); else { clearTimeout(timer); tabs[step].classList.remove("play"); }
    }, { threshold: 0.45 }).observe(panel);
    // Pointing at the panel pauses it, with the bar and the timer kept in step.
    panel.addEventListener("pointerenter", () => {
      if (!timer || still) return;
      panel.classList.add("paused");
      clearTimeout(timer);
      const anim = $(".bar i", tabs[step]).getAnimations()[0];
      left = anim ? STEP_MS - (anim.currentTime ?? 0) : STEP_MS;
    });
    panel.addEventListener("pointerleave", () => {
      if (!panel.classList.contains("paused")) return;
      panel.classList.remove("paused");
      if (!visible) return;
      clearTimeout(timer);
      timer = setTimeout(() => pick((step + 1) % tabs.length), Math.max(200, left));
    });
  });

  // ---------- Contents list: highlight the section you're reading ----------
  const toc = $(".toc");
  if (toc) {
    const links = all("a", toc);
    const targets = links.map((a) => $(a.getAttribute("href")));
    const mark = () => {
      let cur = 0;
      targets.forEach((t, i) => { if (t && t.getBoundingClientRect().top < 140) cur = i; });
      links.forEach((a, i) => a.classList.toggle("is-on", i === cur));
    };
    addEventListener("scroll", mark, { passive: true });
    mark();
  }

  // ---------- FAQ: open and close smoothly ----------
  if (!still) all(".faq-c details").forEach((d) => {
    const summary = $("summary", d), ans = $(".ans", d);
    if (!ans) return;
    summary.addEventListener("click", (e) => {
      e.preventDefault();
      if (d.open) {
        const a = ans.animate([{ height: `${ans.offsetHeight}px`, opacity: 1 }, { height: "0px", opacity: 0 }], { duration: 260, easing: "cubic-bezier(.2,.8,.2,1)" });
        a.onfinish = () => { d.open = false; };
      } else {
        d.open = true;
        ans.animate([{ height: "0px", opacity: 0 }, { height: `${ans.offsetHeight}px`, opacity: 1 }], { duration: 320, easing: "cubic-bezier(.16,1,.3,1)" });
      }
    });
  });
})();
