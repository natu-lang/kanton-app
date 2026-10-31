(() => {
  const $ = (id) => document.getElementById(id);
  const state = { cat: CATEGORIES[0].id, idx: 0, recording: false, pitch: [], best: JSON.parse(localStorage.getItem("kg-best") || "{}") };
  const list = () => PHRASES.filter((p) => p.cat === state.cat);
  const cur = () => list()[state.idx];
  const tonesOf = (p) => p.jyut.split(" ").map((s) => +s.slice(-1));

  /* ---------- UI ---------- */
  function renderTabs() {
    $("tabs").innerHTML = "";
    CATEGORIES.forEach((c) => {
      const b = document.createElement("button");
      b.textContent = c.label; b.id = "tab-" + c.id;
      b.className = c.id === state.cat ? "on" : "";
      b.onclick = () => { state.cat = c.id; state.idx = 0; renderTabs(); render(); };
      $("tabs").appendChild(b);
    });
  }

  function render() {
    const p = cur();
    $("card").style.animation = "none"; void $("card").offsetWidth; $("card").style.animation = "";
    $("counter").textContent = `${state.idx + 1} / ${list().length}` + (state.best[p.id] ? `　BEST ${state.best[p.id]}` : "");
    $("hanzi").textContent = p.hanzi;
    $("jyut").innerHTML = p.jyut.split(" ").map((s) => {
      const t = +s.slice(-1);
      return `<span class="syl"><b style="color:${TONES[t].color}">${s.slice(0, -1)}<sup>${t}</sup></b><i style="background:${TONES[t].color}">${TONES[t].name}</i></span>`;
    }).join("");
    $("jp").textContent = p.jp;
    $("scene").textContent = p.scene;
    $("tip").textContent = p.tip;
    $("result").hidden = true;
    state.pitch = [];
    drawGraph();
  }

  /* ---------- Graph ---------- */
  // 期待カーブ：各音節の声調(1-5の音高)を連結
  function expectedCurve(p, n = 60) {
    const tones = tonesOf(p), per = Math.max(2, Math.floor(n / tones.length)), out = [];
    tones.forEach((t) => {
      const [a, b] = TONES[t].contour;
      for (let i = 0; i < per; i++) out.push(a + (b - a) * (i / (per - 1)));
    });
    return out;
  }

  function drawGraph() {
    const c = $("graph"), g = c.getContext("2d"), W = c.width, H = c.height, pad = 16;
    g.clearRect(0, 0, W, H);
    const y = (v) => H - pad - ((v - 1) / 4) * (H - pad * 2);
    g.strokeStyle = "rgba(255,255,255,.08)"; g.fillStyle = "rgba(255,255,255,.3)"; g.font = "11px Outfit";
    for (let v = 1; v <= 5; v++) { g.beginPath(); g.moveTo(24, y(v)); g.lineTo(W, y(v)); g.stroke(); g.fillText(v, 6, y(v) + 4); }

    const p = cur(), tones = tonesOf(p), exp = expectedCurve(p);
    const x = (i, len) => 24 + (i / (len - 1)) * (W - 32);
    // 音節ごとに色分けしたお手本
    const per = exp.length / tones.length;
    tones.forEach((t, k) => {
      g.beginPath(); g.lineWidth = 8; g.lineCap = "round"; g.strokeStyle = TONES[t].color + "99";
      for (let i = Math.round(k * per); i < Math.round((k + 1) * per); i++) i === Math.round(k * per) ? g.moveTo(x(i, exp.length), y(exp[i])) : g.lineTo(x(i, exp.length), y(exp[i]));
      g.stroke();
    });
    // ユーザー
    const u = normalizeUser(state.pitch);
    if (u.length > 1) {
      g.beginPath(); g.lineWidth = 3; g.strokeStyle = "#ff4d8d";
      u.forEach((v, i) => (i ? g.lineTo(x(i, u.length), y(v)) : g.moveTo(x(i, u.length), y(v))));
      g.stroke();
    }
  }

  /* ---------- Playback ---------- */
  let voice = null;
  const pickVoice = () => { voice = speechSynthesis.getVoices().find((v) => /zh[-_]HK|yue/i.test(v.lang)) || null; };
  if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

  function play(rate = 1) {
    const p = cur(); $("btn-play").classList.add("on");
    const done = () => $("btn-play").classList.remove("on");
    // ネイティブ録音があれば優先
    const audio = new Audio(`audio/${p.id}.mp3`);
    audio.playbackRate = rate; audio.onended = done;
    audio.play().catch(() => {
      const u = new SpeechSynthesisUtterance(p.hanzi.replace(/[a-z]+/gi, (m) => m));
      u.lang = "zh-HK"; if (voice) u.voice = voice; u.rate = rate * 0.9; u.onend = done; u.onerror = done;
      speechSynthesis.cancel(); speechSynthesis.speak(u);
      if (!voice) console.warn("広東語(zh-HK)音声が見つかりません。OSに広東語音声を追加してください。");
    });
  }

  /* ---------- Recording + Pitch ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let ctx, stream, analyser, raf, recog, transcript = "";

  function autoCorrelate(buf, sr) {
    let rms = 0; for (const v of buf) rms += v * v;
    if (Math.sqrt(rms / buf.length) < 0.015) return -1; // 無音
    const minL = Math.floor(sr / 400), maxL = Math.floor(sr / 80);
    let best = -1, bestC = 0;
    for (let lag = minL; lag <= maxL; lag++) {
      let c = 0; for (let i = 0; i < buf.length - lag; i++) c += buf[i] * buf[i + lag];
      if (c > bestC) { bestC = c; best = lag; }
    }
    return best > 0 ? sr / best : -1;
  }

  // Hz → 半音 → 話者レンジで1〜5に正規化
  function normalizeUser(hz) {
    if (hz.length < 3) return [];
    const st = hz.map((f) => 12 * Math.log2(f / 100));
    const sorted = [...st].sort((a, b) => a - b);
    const lo = sorted[Math.floor(sorted.length * 0.05)], hi = sorted[Math.floor(sorted.length * 0.95)];
    const range = Math.max(hi - lo, 4);
    return st.map((s) => Math.min(5, Math.max(1, 1 + ((s - lo) / range) * 4)));
  }

  async function startRec() {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { alert("マイクの使用を許可してください"); return; }
    state.recording = true; state.pitch = []; transcript = "";
    $("btn-rec").classList.add("on"); $("btn-rec").textContent = "■";
    ctx = new AudioContext(); analyser = ctx.createAnalyser(); analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    const loop = () => {
      analyser.getFloatTimeDomainData(buf);
      const f = autoCorrelate(buf, ctx.sampleRate);
      if (f > 0) { state.pitch.push(f); drawGraph(); }
      raf = requestAnimationFrame(loop);
    };
    loop();
    if (SR) {
      recog = new SR(); recog.lang = "zh-HK"; recog.interimResults = false; recog.maxAlternatives = 3;
      recog.onresult = (e) => { transcript = [...e.results[0]].map((a) => a.transcript).join("|"); };
      recog.onend = () => state.recording && stopRec();
      recog.start();
    }
    setTimeout(() => state.recording && stopRec(), 5000);
  }

  function stopRec() {
    state.recording = false;
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((t) => t.stop()); ctx?.close();
    try { recog?.stop(); } catch {}
    $("btn-rec").classList.remove("on"); $("btn-rec").textContent = "🎤";
    setTimeout(score, SR ? 400 : 0); // 認識結果の到着を少し待つ
  }

  /* ---------- Scoring ---------- */
  function pearson(a, b) {
    const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da && db ? num / Math.sqrt(da * db) : 0;
  }
  const resample = (arr, n) => Array.from({ length: n }, (_, i) => arr[Math.round((i / (n - 1)) * (arr.length - 1))]);

  function score() {
    const p = cur();
    const user = normalizeUser(state.pitch);
    if (user.length < 5) { showResult(0, "声が聞き取れませんでした", "もう少し大きな声でどうぞ", ""); return; }
    const exp = expectedCurve(p);
    const toneScore = Math.round(Math.max(0, pearson(resample(user, exp.length), exp)) * 100);

    let textScore = null;
    if (SR) {
      const target = [...p.hanzi.replace(/[？?！!、。a-z]/gi, "")];
      const heard = transcript.split("|").map((t) => [...target].filter((ch) => t.includes(ch)).length / (target.length || 1));
      textScore = Math.round(Math.max(0, ...heard) * 100);
    }
    const total = textScore === null ? toneScore : Math.round(textScore * 0.6 + toneScore * 0.4);
    const verdict = total >= 80 ? "🎉 ばっちり！ネイティブに通じる" : total >= 55 ? "👍 いい感じ！声調をもう一押し" : "💪 お手本をもう一度聞いてみよう";
    const advice = toneScore < 60 ? "声調カーブがズレています。高低差を大げさに。" : "";
    showResult(total, verdict,
      SR ? `認識: ${transcript.split("|")[0] || "（なし）"}` : "※音声認識非対応ブラウザ：声調のみで採点",
      `文字 ${textScore ?? "-"} / 声調 ${toneScore}　${advice}`);
    if (total > (state.best[p.id] || 0)) { state.best[p.id] = total; localStorage.setItem("kg-best", JSON.stringify(state.best)); }
  }

  function showResult(s, v, heard, sub) {
    $("result").hidden = false; $("score").textContent = s; $("verdict").textContent = v;
    $("heard").textContent = heard; $("sub").textContent = sub;
    $("ring").style.stroke = s >= 80 ? "#3ddc97" : s >= 55 ? "#ffd43b" : "#ff6b6b";
    requestAnimationFrame(() => ($("ring").style.strokeDasharray = `${s},100`));
  }

  /* ---------- Tone dialog ---------- */
  function renderToneGrid() {
    $("tone-grid").innerHTML = "";
    Object.entries(TONES).forEach(([n, t]) => {
      const d = document.createElement("div"); d.className = "tone-cell";
      const c = document.createElement("canvas"); c.width = 120; c.height = 60; c.style.width = "100%";
      const g = c.getContext("2d"), y = (v) => 55 - (v - 1) * 12.5;
      g.strokeStyle = t.color; g.lineWidth = 5; g.lineCap = "round";
      g.beginPath(); g.moveTo(15, y(t.contour[0])); g.lineTo(105, y(t.contour[1])); g.stroke();
      d.append(c, Object.assign(document.createElement("div"), { innerHTML: `<b>${n}声</b> ${t.name} (${t.contour.join("")})` }));
      $("tone-grid").appendChild(d);
    });
  }

  /* ---------- Events ---------- */
  const step = (d) => { state.idx = (state.idx + d + list().length) % list().length; render(); };
  $("btn-play").onclick = () => play(1);
  $("btn-slow").onclick = () => play(0.7);
  $("btn-rec").onclick = () => (state.recording ? stopRec() : startRec());
  $("btn-prev").onclick = () => step(-1);
  $("btn-next").onclick = () => step(1);
  $("btn-tones").onclick = () => $("tone-dialog").showModal();
  $("close-dialog").onclick = () => $("tone-dialog").close();
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT") return;
    if (e.key === " ") { e.preventDefault(); play(1); }
    if (e.key === "r") $("btn-rec").click();
    if (e.key === "ArrowRight") step(1);
    if (e.key === "ArrowLeft") step(-1);
  });
  let sx = 0;
  $("card").addEventListener("touchstart", (e) => (sx = e.touches[0].clientX), { passive: true });
  $("card").addEventListener("touchend", (e) => { const dx = e.changedTouches[0].clientX - sx; if (Math.abs(dx) > 60) step(dx < 0 ? 1 : -1); });

  renderTabs(); renderToneGrid(); render();
})();
