// Footlight site — nav state + scroll reveals
(function () {
  var nav = document.getElementById("nav");
  var onScroll = function () {
    if (window.scrollY > 8) nav.classList.add("scrolled");
    else nav.classList.remove("scrolled");
  };
  onScroll();
  window.addEventListener("scroll", onScroll, { passive: true });

  // mobile nav toggle
  var toggle = document.getElementById("navToggle");
  var navLinks = document.getElementById("navLinks");
  if (toggle && navLinks) {
    // add a GitHub entry into the mobile menu (the header button is hidden < 760px)
    var gh = document.createElement("a");
    gh.className = "lk gh-mobile";
    gh.href = "https://github.com/tjbaker/footlight";
    gh.target = "_blank"; gh.rel = "noopener";
    gh.textContent = "GitHub ↗";
    navLinks.appendChild(gh);

    var setOpen = function (open) {
      nav.classList.toggle("open", open);
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    };
    toggle.addEventListener("click", function () {
      setOpen(!nav.classList.contains("open"));
    });
    navLinks.addEventListener("click", function (e) {
      if (e.target.closest("a")) setOpen(false);
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") setOpen(false);
    });
  }

  // reveal-on-scroll
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var els = document.querySelectorAll(".reveal");
  if (reduce || !("IntersectionObserver" in window)) {
    els.forEach(function (el) { el.classList.add("in"); });
    return;
  }
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -8% 0px" });
  els.forEach(function (el) { io.observe(el); });

  // hero waveform motif — ember bars, taller = louder, with a swell mid-strip
  var wave = document.getElementById("heroWave");
  if (wave) {
    var n = Math.min(96, Math.max(48, Math.floor(window.innerWidth / 16)));
    for (var i = 0; i < n; i++) {
      var bar = document.createElement("span");
      bar.className = "bar";
      var base = 0.32 + 0.24 * Math.sin(i / 7) + 0.18 * Math.sin(i / 2.6);
      var swell = (i > n * 0.62 && i < n * 0.78) ? 0.42 : 0;
      var hi = Math.max(0.16, Math.min(1, base + swell + Math.random() * 0.16));
      var lo = Math.max(0.1, hi - 0.28 - Math.random() * 0.12);
      bar.style.setProperty("--hi", hi.toFixed(2));
      bar.style.setProperty("--lo", lo.toFixed(2));
      bar.style.setProperty("--dur", (1.8 + Math.random() * 1.6).toFixed(2) + "s");
      bar.style.animationDelay = (-Math.random() * 2).toFixed(2) + "s";
      wave.appendChild(bar);
    }
  }

  // copy-to-clipboard on the quickstart block
  document.querySelectorAll(".copy-btn").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var text = btn.getAttribute("data-copy") || "";
      var done = function () {
        btn.classList.add("copied");
        var lbl = btn.querySelector(".lbl");
        var prev = lbl ? lbl.textContent : "";
        if (lbl) lbl.textContent = "Copied";
        setTimeout(function () {
          btn.classList.remove("copied");
          if (lbl) lbl.textContent = prev;
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(done);
      } else {
        var ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); } catch (e) {}
        document.body.removeChild(ta); done();
      }
    });
  });
})();
