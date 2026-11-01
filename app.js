(() => {
  const $ = (id) => document.getElementById(id);
  const state = { cat: CATEGORIES[0].id, idx: 0, recording: false, pitch: [], best: JSON.parse(localStorage.getItem("kg-best") || "{}") };
  // マイ単語（端末内に保存）
  const MINE_KEY = "kg-mine";
  const loadMine = () => { try { return JSON.parse(localStorage.getItem(MINE_KEY) || "[]"); } catch { return []; } };
  const saveMine = (arr) => {
    try { localStorage.setItem(MINE_KEY, JSON.stringify(arr)); return true; }
    catch { notice("保存容量がいっぱいです。録音つきの単語をいくつか削除してください"); return false; }
  };
  let mine = loadMine();
  state.cat = mine.length ? "mine" : "greet";
  // タグ（デフォルト単語にも付けられるよう端末内に上書き保存）
  const TAG_KEY = "kg-tags";
  let userTags = (() => { try { return JSON.parse(localStorage.getItem(TAG_KEY) || "{}"); } catch { return {}; } })();
  const tagsOf = (p) => userTags[p.id] ?? p.tags ?? [];
  const setTags = (id, arr) => { userTags[id] = arr; localStorage.setItem(TAG_KEY, JSON.stringify(userTags)); };
  const list = () => {
    if (state.cat === "mine") return mine;
    if (state.cat.startsWith("tag-")) { const t = state.cat.slice(4); return [...mine, ...PHRASES].filter((p) => tagsOf(p).includes(t)); }
    return PHRASES.filter((p) => p.cat === state.cat);
  };
  const cur = () => list()[state.idx];
  const sylls = (p) => (p.jyut || "").trim().split(/\s+/).filter((s) => /^[a-z]+[1-6]$/i.test(s));
  const tonesOf = (p) => sylls(p).map((s) => +s.slice(-1));

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
    const empty = !p;
    $("empty").hidden = !empty; $("card-body").hidden = empty;
    $("card-actions").hidden = state.cat !== "mine" || empty;
    ["btn-play", "btn-slow", "btn-rec"].forEach((id) => ($(id).disabled = empty));
    if (empty) {
      $("counter").textContent = "";
      $("empty").querySelector("p").innerHTML = state.cat.startsWith("tag-")
        ? "このタグの単語はまだありません。<br>カードのタグボタンで付けられます。"
        : "まだマイ単語がありません。<br>友達に教わった言葉を追加しよう！";
      return;
    }
    const tg = tagsOf(p);
    $("tag-freq").classList.toggle("on", tg.includes("freq"));
    $("tag-slang").classList.toggle("on", tg.includes("slang"));
    $("zh-box").hidden = !p.zh;
    $("zh").textContent = p.zh || ""; $("zh-kana").textContent = p.zhKana || "";
    $("counter").textContent = `${state.idx + 1} / ${list().length}` + (state.best[p.id] ? `　BEST ${state.best[p.id]}` : "");
    $("hanzi").textContent = p.hanzi;
    const ss = sylls(p);
    $("jyut").innerHTML = ss.length ? ss.map((s) => {
      const t = +s.slice(-1);
      return `<span class="syl"><b style="color:${TONES[t].color}">${s.slice(0, -1)}<sup>${t}</sup></b><i style="background:${TONES[t].color}">${TONES[t].name}</i></span>`;
    }).join("") : `<span class="muted">${p.audio ? "🎙 友達のお手本で練習" : "お手本を録音すると採点できます"}</span>`;
    $("jp").textContent = p.jp || "";
    $("scene").textContent = p.scene || "";
    $("tip").textContent = p.tip || "メモなし";
    $("result").hidden = true;
    state.pitch = [];
    if (p.audio) audioUrl[p.id] = p.audio; else probeAudio(p.id);
    drawGraph();
    ensureRef(p).then(() => cur() === p && drawGraph());
  }

  /* ---------- お手本音声から声の高さカーブを抽出 ---------- */
  const refCurve = {};
  async function analyzeAudio(url) {
    const buf = await (await fetch(url)).arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    try {
      const audio = await new Promise((ok, ng) => ac.decodeAudioData(buf, ok, ng));
      const data = audio.getChannelData(0), sr = audio.sampleRate, win = 2048, hop = Math.floor(sr / 50);
      const hz = [];
      for (let i = 0; i + win < data.length; i += hop) {
        const f = autoCorrelate(data.subarray(i, i + win), sr);
        if (f > 0) hz.push(f);
      }
      const n = normalizeUser(hz);
      return n.length >= 5 ? resample(n, 60) : null;
    } finally { ac.close?.(); }
  }
  async function ensureRef(p) {
    if (p.id in refCurve) return refCurve[p.id];
    if (!p.audio) await probeAudio(p.id);
    const url = audioUrl[p.id];
    if (!url) return null;
    try { refCurve[p.id] = await analyzeAudio(url); } catch { refCurve[p.id] = null; }
    return refCurve[p.id];
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

    const p = cur(); if (!p) return;
    const x = (i, len) => 24 + (i / (len - 1)) * (W - 32);
    const ref = refCurve[p.id];
    if (ref) {
      // 友達（お手本）の声の高さ
      g.beginPath(); g.lineWidth = 8; g.lineCap = "round"; g.lineJoin = "round"; g.strokeStyle = "rgba(255,255,255,.45)";
      ref.forEach((v, i) => (i ? g.lineTo(x(i, ref.length), y(v)) : g.moveTo(x(i, ref.length), y(v))));
      g.stroke();
    }
    const tones = ref ? [] : tonesOf(p), exp = tones.length ? expectedCurve(p) : [];
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
  let voice = null, zhVoice = null;
  const pickVoice = () => {
    const vs = speechSynthesis.getVoices();
    voice = vs.find((v) => /zh[-_]HK|yue/i.test(v.lang)) || null;
    zhVoice = vs.find((v) => /zh[-_](CN|Hans)|cmn/i.test(v.lang)) || vs.find((v) => /zh[-_]TW/i.test(v.lang)) || null;
  };
  if ("speechSynthesis" in window) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }

  function playZh() {
    const p = cur(); if (!p?.zh) return;
    if (!("speechSynthesis" in window)) return notice("このブラウザは音声読み上げに対応していません");
    if (!zhVoice) pickVoice();
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    speechSynthesis.resume();
    const u = new SpeechSynthesisUtterance(p.zh.split(/[／/]/)[0]);
    u.lang = "zh-CN"; if (zhVoice) u.voice = zhVoice; u.rate = 0.85;
    $("btn-zh-play").classList.add("on");
    u.onend = u.onerror = () => $("btn-zh-play").classList.remove("on");
    speechSynthesis.speak(u);
  }

  // 録音ファイルの有無を事前に調べてキャッシュ（タップ時に即再生するため）
  const audioUrl = {};
  async function probeAudio(id) {
    if (id in audioUrl) return;
    audioUrl[id] = null;
    for (const ext of ["mp3", "m4a", "wav"]) {
      try { const r = await fetch(`audio/${id}.${ext}`, { method: "HEAD" }); if (r.ok) { audioUrl[id] = `audio/${id}.${ext}`; return; } } catch {}
    }
  }

  function notice(msg) {
    let n = $("notice");
    if (!n) { n = document.createElement("div"); n.id = "notice"; n.className = "notice"; document.body.appendChild(n); }
    n.textContent = msg; n.classList.add("show");
    clearTimeout(n._t); n._t = setTimeout(() => n.classList.remove("show"), 5000);
  }

  function play(rate = 1) {
    const p = cur(); $("btn-play").classList.add("on");
    const done = () => $("btn-play").classList.remove("on");
    if (audioUrl[p.id]) {
      const audio = new Audio(audioUrl[p.id]);
      audio.preservesPitch = true; audio.webkitPreservesPitch = true;
      audio.defaultPlaybackRate = rate; audio.playbackRate = rate; audio.onended = done; audio.onerror = done;
      // iOSは再生開始時に速度がリセットされることがあるので再設定
      audio.onplaying = () => { audio.playbackRate = rate; };
      audio.play().then(() => { audio.playbackRate = rate; }).catch(done);
      return;
    }
    // 読み上げ（タップ直後に同期で呼ぶ必要がある）
    if (!("speechSynthesis" in window)) { done(); notice("このブラウザは音声読み上げに対応していません"); return; }
    if (!voice) pickVoice();
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
    speechSynthesis.resume(); // iOSで一時停止状態に固まるのを解除
    const u = new SpeechSynthesisUtterance(p.hanzi);
    u.lang = "zh-HK"; if (voice) u.voice = voice; u.rate = rate < 1 ? 0.5 : 0.9; u.volume = 1;
    let started = false;
    u.onstart = () => (started = true);
    u.onend = done;
    u.onerror = (e) => { done(); notice(`読み上げエラー: ${e.error}（声: ${voice ? voice.name : "なし"}）`); };
    speechSynthesis.speak(u);
    if (!voice) notice("広東語の読み上げ音声が端末に見つかりません。設定で「中国語（香港）」の声を追加してください");
    setTimeout(() => {
      if (!started) { done(); notice(`音声が始まりませんでした（声: ${voice ? voice.name : "なし"} / 音声数: ${speechSynthesis.getVoices().length}）。マナーモードと音量を確認してください`); }
    }, 2500);
    setTimeout(done, 6000);
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

  let srcNode;
  const recBtn = () => $(state.mode === "zh" ? "btn-zh-rec" : "btn-rec");
  async function startRec(mode = "yue") {
    state.mode = mode;
    // iOS: AudioContextはタップ直後(同期)に作成/再開し、使い回す
    if (!ctx || ctx.state === "closed") ctx = new (window.AudioContext || window.webkitAudioContext)();
    const resumed = ctx.resume();
    // マイクは使い回す（iOSでは停止→再取得すると2回目以降が無音になる）
    if (!stream || !stream.getAudioTracks().some((t) => t.readyState === "live")) {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch { alert("マイクの使用を許可してください"); return; }
      srcNode = null;
    }
    await resumed.catch(() => {});
    state.recording = true; state.pitch = []; transcript = "";
    recBtn().classList.add("on"); recBtn().textContent = "■";
    if (!analyser) { analyser = ctx.createAnalyser(); analyser.fftSize = 2048; }
    if (!srcNode) { srcNode = ctx.createMediaStreamSource(stream); srcNode.connect(analyser); }
    const buf = new Float32Array(analyser.fftSize);
    const loop = () => {
      analyser.getFloatTimeDomainData(buf);
      const f = autoCorrelate(buf, ctx.sampleRate);
      if (f > 0) { state.pitch.push(f); drawGraph(); }
      raf = requestAnimationFrame(loop);
    };
    loop();
    if (SR) {
      const r = recog = new SR(); r.lang = mode === "zh" ? "zh-CN" : "zh-HK"; r.interimResults = false; r.maxAlternatives = 3;
      r.onresult = (e) => { if (recog === r || !state.recording) transcript = [...e.results[0]].map((a) => a.transcript).join("|"); };
      r.onend = () => recog === r && state.recording && stopRec();
      r.start();
    }
    setTimeout(() => state.recording && stopRec(), 5000);
  }

  function stopRec() {
    state.recording = false;
    cancelAnimationFrame(raf);
    try { recog?.stop(); } catch {}
    recog = null;
    $("btn-rec").classList.remove("on"); $("btn-rec").textContent = "🎤";
    $("btn-zh-rec").classList.remove("on"); $("btn-zh-rec").textContent = "🎤";
    setTimeout(state.mode === "zh" ? scoreZh : score, SR ? 400 : 0); // 認識結果の到着を少し待つ
  }

  // 普通話：音声認識の文字一致で採点
  function scoreZh() {
    const p = cur(); if (!p?.zh) return;
    if (!SR) { showResult(0, "採点できません", "このブラウザは音声認識に非対応です", ""); return; }
    const target = [...p.zh.split(/[／/]/)[0].replace(/[？?！!、。，,\s]/g, "")];
    const heard = transcript.split("|").map((t) => target.filter((ch) => t.includes(ch)).length / (target.length || 1));
    const s = Math.round(Math.max(0, ...heard) * 100);
    showResult(s, s >= 80 ? "🎉 普通話もばっちり！" : s >= 50 ? "👍 もう少し！" : "💪 ▶ でお手本を聞いてみよう",
      `認識: ${transcript.split("|")[0] || "（なし）"}`, "普通話モード（文字一致で採点）");
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
    const ref = refCurve[p.id];
    let toneScore = null;
    if (ref) {
      // 友達の声と比較：形の似方(相関) 70% + 高さのズレの小ささ 30%
      const u = resample(user, ref.length);
      const mad = u.reduce((s, v, i) => s + Math.abs(v - ref[i]), 0) / u.length;
      toneScore = Math.round((0.7 * Math.max(0, pearson(u, ref)) + 0.3 * Math.max(0, 1 - mad / 2)) * 100);
    } else if (tonesOf(p).length) {
      const exp = expectedCurve(p);
      toneScore = Math.round(Math.max(0, pearson(resample(user, exp.length), exp)) * 100);
    }

    let textScore = null;
    if (SR) {
      const target = [...p.hanzi.replace(/[？?！!、。a-z]/gi, "")];
      const heard = transcript.split("|").map((t) => [...target].filter((ch) => t.includes(ch)).length / (target.length || 1));
      textScore = Math.round(Math.max(0, ...heard) * 100);
    }
    if (textScore === null && toneScore === null) { showResult(0, "採点できません", "お手本を録音すると、友達の声と比べて採点できます", ""); return; }
    const total = textScore === null ? toneScore : toneScore === null ? textScore : Math.round(textScore * 0.6 + toneScore * 0.4);
    const verdict = total >= 80 ? "🎉 ばっちり！ネイティブに通じる" : total >= 55 ? "👍 いい感じ！声調をもう一押し" : "💪 お手本をもう一度聞いてみよう";
    const advice = toneScore !== null && toneScore < 60 ? "声調カーブがズレています。高低差を大げさに。" : "";
    showResult(total, verdict,
      SR ? `認識: ${transcript.split("|")[0] || "（なし）"}` : "※音声認識非対応ブラウザ：声調のみで採点",
      `文字 ${textScore ?? "-"} / 声調 ${toneScore ?? "-"}　${advice}`);
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
  const step = (d) => { if (!list().length) return; state.idx = (state.idx + d + list().length) % list().length; render(); };
  $("btn-play").onclick = () => play(1);
  $("btn-slow").onclick = () => play(0.7);
  $("btn-rec").onclick = () => (state.recording ? stopRec() : startRec("yue"));
  $("btn-zh-play").onclick = playZh;
  $("btn-zh-rec").onclick = () => (state.recording ? stopRec() : startRec("zh"));
  const toggleTag = (t) => {
    const p = cur(); if (!p) return;
    const tg = tagsOf(p), next = tg.includes(t) ? tg.filter((x) => x !== t) : [...tg, t];
    setTags(p.id, next);
    if (p.cat === "mine") { p.tags = next; saveMine(mine); }
    notice(`${TAGS[t].label} ${next.includes(t) ? "を付けました" : "を外しました"}`);
    if (state.cat.startsWith("tag-")) { state.idx = Math.max(0, Math.min(state.idx, list().length - 1)); render(); }
    else { $("tag-freq").classList.toggle("on", next.includes("freq")); $("tag-slang").classList.toggle("on", next.includes("slang")); }
  };
  $("tag-freq").onclick = () => toggleTag("freq");
  $("tag-slang").onclick = () => toggleTag("slang");
  $("btn-prev").onclick = () => step(-1);
  $("btn-next").onclick = () => step(1);
  $("btn-tones").onclick = () => $("tone-dialog").showModal();
  $("close-dialog").onclick = () => $("tone-dialog").close();

  /* ---------- マイ単語：追加・編集・削除 ---------- */
  let editingId = null, recAudio = null, mrec = null, mstream = null;
  function openForm(p) {
    editingId = p ? p.id : null; recAudio = p ? p.audio || null : null;
    $("f-hanzi").value = p?.hanzi || ""; $("f-jyut").value = p?.jyut || "";
    $("f-jp").value = p?.jp || ""; $("f-scene").value = p?.scene || ""; $("f-tip").value = p?.tip || "";
    $("f-zh").value = p?.zh || ""; $("f-zhkana").value = p?.zhKana || "";
    const tg = p ? tagsOf(p) : [];
    $("f-tag-freq").checked = tg.includes("freq"); $("f-tag-slang").checked = tg.includes("slang");
    $("form-title").textContent = p ? "単語を編集" : "今日の単語を追加";
    updateRecUI(); $("add-dialog").showModal();
  }
  function updateRecUI() {
    $("f-rec-status").textContent = recAudio ? "✅ お手本録音あり" : "録音なし（読み上げ音声を使用）";
    $("f-rec-play").hidden = !recAudio; $("f-rec-del").hidden = !recAudio;
  }
  $("btn-add").onclick = () => openForm(null);
  $("empty-add").onclick = () => openForm(null);
  $("btn-edit").onclick = () => openForm(cur());
  $("btn-del").onclick = () => {
    const p = cur(); if (!p || !confirm(`「${p.hanzi}」を削除しますか？`)) return;
    mine = mine.filter((m) => m.id !== p.id); saveMine(mine); delete audioUrl[p.id];
    state.idx = Math.max(0, Math.min(state.idx, mine.length - 1)); render();
  };
  $("f-cancel").onclick = () => { stopFormRec(); $("add-dialog").close(); };
  // 友達に言ってもらってその場で録音（最長5秒）
  $("f-rec").onclick = async () => {
    if (mrec) return stopFormRec();
    if (!window.MediaRecorder) return notice("このブラウザは録音に対応していません");
    try { mstream = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch { return notice("マイクの使用を許可してください"); }
    const chunks = []; mrec = new MediaRecorder(mstream);
    mrec.ondataavailable = (e) => chunks.push(e.data);
    mrec.onstop = () => {
      const blob = new Blob(chunks, { type: mrec.mimeType || "audio/mp4" });
      const r = new FileReader(); r.onload = () => { recAudio = r.result; updateRecUI(); }; r.readAsDataURL(blob);
      mstream.getTracks().forEach((t) => t.stop()); mrec = null;
      $("f-rec").textContent = "🎙 お手本を録音"; $("f-rec").classList.remove("on");
    };
    mrec.start(); $("f-rec").textContent = "■ 停止"; $("f-rec").classList.add("on");
    setTimeout(() => mrec && stopFormRec(), 5000);
  };
  function stopFormRec() { try { mrec?.stop(); } catch {} }
  $("f-rec-play").onclick = () => recAudio && new Audio(recAudio).play();
  $("f-rec-del").onclick = () => { recAudio = null; updateRecUI(); };
  $("add-form").onsubmit = (e) => {
    e.preventDefault();
    const hanzi = $("f-hanzi").value.trim();
    const jyut = $("f-jyut").value.trim().toLowerCase().replace(/\s+/g, " ");
    if (!hanzi) return;
    if (jyut && jyut.split(" ").some((s) => !/^[a-z]+[1-6]$/.test(s))) {
      return notice("粤拼は「nei5 hou2」のように、音節ごとに声調番号(1〜6)を付けてスペースで区切ってください");
    }
    const tags = [$("f-tag-freq").checked && "freq", $("f-tag-slang").checked && "slang"].filter(Boolean);
    const item = { id: editingId || "mine-" + Date.now(), cat: "mine", hanzi, jyut,
      jp: $("f-jp").value.trim(), scene: $("f-scene").value.trim(), tip: $("f-tip").value.trim(), audio: recAudio,
      zh: $("f-zh").value.trim(), zhKana: $("f-zhkana").value.trim(), tags };
    const next = editingId ? mine.map((m) => (m.id === editingId ? item : m)) : [item, ...mine];
    if (!saveMine(next)) return;
    setTags(item.id, tags);
    mine = next; delete audioUrl[item.id]; delete refCurve[item.id];
    $("add-dialog").close();
    state.cat = "mine"; state.idx = mine.findIndex((m) => m.id === item.id);
    renderTabs(); render(); notice(editingId ? "更新しました" : "追加しました！");
  };

  document.addEventListener("keydown", (e) => {
    if (["INPUT", "TEXTAREA"].includes(e.target.tagName) || $("add-dialog").open) return;
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
