// ============================================
// JARVIS OS — Voice Layer (Web Speech API)
// ============================================

class JarvisVoice {
  constructor(opts = {}) {
    this.lang = opts.lang || "vi-VN";
    this.onTranscript = opts.onTranscript || (() => {});
    this.onInterim = opts.onInterim || (() => {});
    this.onStart = opts.onStart || (() => {});
    this.onEnd = opts.onEnd || (() => {});
    this.onError = opts.onError || (() => {});

    this.recognition = null;
    this.synth = window.speechSynthesis;
    this.isListening = false;
    this.ttsEnabled = true;
    this.vietnameseVoice = null;

    // Edge TTS backend (server)
    this.ttsBackend = opts.ttsBackend || "/tts"; // "/tts" hoặc null để dùng browser
    this.ttsVoice = opts.ttsVoice || "vi-VN-HoaiMyNeural"; // HoaiMy (nữ) | NamMinh (nam)
    this.ttsRate = opts.ttsRate || "+5%";
    this.currentAudio = null;
    this.ttsQueue = [];
    this.isPlaying = false;

    // Audio analysis — cho hiệu ứng phát sáng theo âm thanh
    this.audioCtx = null;
    this.outAnalyser = null;   // âm Jarvis đọc (TTS)
    this.inAnalyser = null;    // âm mic (khi nghe)
    this.micStream = null;
    this._freqData = new Uint8Array(64);

    this._initRecognition();
    this._loadVoices();
  }

  _ensureCtx() {
    if (!this.audioCtx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AC();
    }
    if (this.audioCtx.state === "suspended") this.audioCtx.resume();
    return this.audioCtx;
  }

  async _startMicMeter() {
    try {
      const ctx = this._ensureCtx();
      if (!this.micStream) {
        this.micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }
      const src = ctx.createMediaStreamSource(this.micStream);
      const an = ctx.createAnalyser();
      an.fftSize = 128;
      src.connect(an);
      this.inAnalyser = an;
    } catch (e) { /* mic meter optional */ }
  }

  getInputLevel() {
    if (!this.inAnalyser || !this.isListening) return 0;
    this.inAnalyser.getByteFrequencyData(this._freqData);
    let s = 0;
    for (let i = 0; i < this._freqData.length; i++) s += this._freqData[i];
    return Math.min(1, (s / this._freqData.length) / 200);
  }

  getOutputLevel() {
    if (!this.outAnalyser) return 0;
    this.outAnalyser.getByteFrequencyData(this._freqData);
    let s = 0;
    for (let i = 0; i < this._freqData.length; i++) s += this._freqData[i];
    return Math.min(1, (s / this._freqData.length) / 180);
  }

  getLevel() {
    return Math.max(this.getInputLevel(), this.getOutputLevel());
  }

  _initRecognition() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      console.warn("Trình duyệt không hỗ trợ SpeechRecognition. Dùng Chrome hoặc Edge.");
      return;
    }

    this.recognition = new SR();
    this.recognition.lang = this.lang;
    this.recognition.continuous = true;       // nghe liên tục, không dừng giữa câu
    this.recognition.interimResults = true;
    this.recognition.maxAlternatives = 1;

    this.accumulatedTranscript = "";
    this.userStopped = false;                 // user chủ động dừng?
    this.silenceMs = 1500;                    // im lặng bao lâu thì tự gửi
    this._silenceTimer = null;

    this.recognition.onstart = () => {
      this.isListening = true;
      this.userStopped = false;
      this.accumulatedTranscript = "";
      this.onStart();
    };

    this.recognition.onresult = (event) => {
      let interim = "", final = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) final += transcript;
        else interim += transcript;
      }
      if (final) this.accumulatedTranscript += final + " ";
      // Show user toàn bộ tích lũy + đoạn đang nghe
      const display = (this.accumulatedTranscript + interim).trim();
      if (display) {
        this.onInterim(display);
        // Reset đồng hồ im lặng — nói tiếp thì hoãn, im đủ lâu thì tự gửi
        clearTimeout(this._silenceTimer);
        this._silenceTimer = setTimeout(() => this.stopListening(), this.silenceMs);
      }
    };

    this.recognition.onerror = (event) => {
      // 'no-speech' không phải lỗi thật — auto-restart
      if (event.error === "no-speech" || event.error === "aborted") {
        return;
      }
      this.isListening = false;
      this.onError(event.error);
    };

    this.recognition.onend = () => {
      // Nếu user chưa chủ động dừng → tự restart (giữ session sống khi user dừng nghĩ)
      if (!this.userStopped) {
        try {
          this.recognition.start();
          return;
        } catch (e) {
          // start fail (đã đang chạy) — ignore
        }
      }
      this.isListening = false;
      // Gửi toàn bộ text đã tích luỹ khi user dừng
      const finalText = this.accumulatedTranscript.trim();
      if (finalText) this.onTranscript(finalText);
      this.onEnd();
    };
  }

  _loadVoices() {
    const load = () => {
      const voices = this.synth.getVoices();
      // Tìm giọng Vietnamese tốt nhất theo thứ tự ưu tiên
      this.vietnameseVoice =
        voices.find(v => v.lang === "vi-VN" && v.name.includes("Google")) ||
        voices.find(v => v.lang === "vi-VN") ||
        voices.find(v => v.lang.startsWith("vi")) ||
        null;
    };
    load();
    if (this.synth.onvoiceschanged !== undefined) {
      this.synth.onvoiceschanged = load;
    }
  }

  startListening() {
    if (!this.recognition) {
      this.onError("not-supported");
      return;
    }
    if (this.isListening) return;
    // Stop TTS đang đọc nếu user bấm nói
    this.synth.cancel();
    this.stopSpeaking();
    this._startMicMeter();  // bật đo âm mic cho hiệu ứng phát sáng
    try {
      this.recognition.start();
    } catch (e) {
      this.onError("start-failed: " + e.message);
    }
  }

  stopListening() {
    clearTimeout(this._silenceTimer);
    if (this.recognition && this.isListening) {
      this.userStopped = true;     // đánh dấu user chủ động dừng → không auto-restart
      this.recognition.stop();
    }
  }

  toggleListening() {
    if (this.isListening) this.stopListening();
    else this.startListening();
  }

  speak(text) {
    if (!this.ttsEnabled) return;
    const clean = text
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/\*(.+?)\*/g, "$1")
      .replace(/`(.+?)`/g, "$1")
      .replace(/^#+\s+/gm, "")
      .replace(/^[-•]\s+/gm, "")
      .replace(/\[(.+?)\]\(.+?\)/g, "$1");

    if (this.ttsBackend) {
      // Edge TTS backend — giọng Vietnamese chuẩn
      this._speakBackend(clean);
    } else {
      // Fallback browser Web Speech
      this._speakBrowser(clean);
    }
  }

  async _speakBackend(text) {
    this.stopSpeaking();
    const chunks = this._splitIntoChunks(text, 400);
    this.ttsQueue = chunks.map(c => ({ text: c, played: false }));
    this._playNextInQueue();
  }

  async _playNextInQueue() {
    if (this.ttsQueue.length === 0) { this.isPlaying = false; return; }
    const item = this.ttsQueue.shift();
    const url = `${this.ttsBackend}?text=${encodeURIComponent(item.text)}&voice=${encodeURIComponent(this.ttsVoice)}&rate=${encodeURIComponent(this.ttsRate)}`;
    try {
      this.currentAudio = new Audio(url);
      // Chỉ route qua Web Audio analyser KHI context đang chạy.
      // Nếu suspend, route sẽ nuốt tiếng → bỏ qua, phát thẳng (luôn có tiếng Việt).
      try {
        const ctx = this._ensureCtx();
        if (ctx && ctx.state === "running") {
          this.currentAudio.crossOrigin = "anonymous";
          const srcNode = ctx.createMediaElementSource(this.currentAudio);
          const an = ctx.createAnalyser();
          an.fftSize = 128;
          srcNode.connect(an);
          an.connect(ctx.destination);
          this.outAnalyser = an;
        }
      } catch (e) { /* analyser optional — vẫn phát thẳng */ }
      this.isPlaying = true;
      this.currentAudio.onended = () => this._playNextInQueue();
      this.currentAudio.onerror = (e) => {
        console.warn("TTS backend failed, fallback browser", e);
        this._speakBrowser(item.text);
        this.ttsQueue = [];
      };
      await this.currentAudio.play();
    } catch (e) {
      console.warn("TTS play error:", e);
      this._speakBrowser(item.text);
    }
  }

  _speakBrowser(text) {
    const chunks = this._splitIntoChunks(text, 200);
    this.synth.cancel();
    chunks.forEach(chunk => {
      const utter = new SpeechSynthesisUtterance(chunk);
      utter.lang = this.lang;
      if (this.vietnameseVoice) utter.voice = this.vietnameseVoice;
      utter.rate = 1.05;
      this.synth.speak(utter);
    });
  }

  stopSpeaking() {
    this.synth.cancel();
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this.ttsQueue = [];
    this.isPlaying = false;
  }

  setVoice(voiceName) {
    this.ttsVoice = voiceName;
  }

  setRate(rate) {
    this.ttsRate = rate;
  }

  toggleTTS() {
    this.ttsEnabled = !this.ttsEnabled;
    if (!this.ttsEnabled) this.stopSpeaking();
    return this.ttsEnabled;
  }

  _splitIntoChunks(text, maxLen) {
    const sentences = text.match(/[^.!?]+[.!?]+|\s*[^.!?]+$/g) || [text];
    const chunks = [];
    let current = "";
    for (const s of sentences) {
      if ((current + s).length > maxLen && current) {
        chunks.push(current.trim());
        current = s;
      } else {
        current += s;
      }
    }
    if (current.trim()) chunks.push(current.trim());
    return chunks.filter(c => c.length > 0);
  }

  isSpeaking() {
    return this.isPlaying || (this.synth && this.synth.speaking);
  }

  isSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  }
}

window.JarvisVoice = JarvisVoice;
