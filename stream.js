/* Optional WebRTC transport. No camera, microphone, ROM or save uploads. */
(function () {
  'use strict';
  var room = null, key = '', generation = 0, config = null, busy = false;
  var tracks = [], audioTap = null, video = null, audio = null, lastTime = -1, lastFrame = 0, publisherPaused = false;
  // Measured received audio level (0-1) for emu_rtc_status; -1 until known.
  var audioTrack = null, audioLevel = -1, levelCheckedAt = 0;
  var viewer = document.body.hasAttribute('data-gemu-viewer');
  var sdkPromise;
  function report(ok, detail) {
    if (window.gemuRTC && window.gemuRTC.status) window.gemuRTC.status(!!ok, String(detail || '').slice(0, 160));
  }
  function sdk() {
    if (!sdkPromise) sdkPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = 'livekit-client.umd.min.js';
      script.onload = function () {
        // GMod prints every CEF console line; keep the SDK to warnings and errors.
        if (window.LivekitClient && window.LivekitClient.setLogLevel) window.LivekitClient.setLogLevel('warn');
        resolve(window.LivekitClient);
      };
      script.onerror = function () { sdkPromise = null; reject(new Error('SDK unavailable')); };
      document.head.appendChild(script);
    });
    return sdkPromise;
  }
  function stop() {
    generation++; key = ''; busy = false;
    var previous = room; room = null;
    if (previous) previous.disconnect();
    tracks.forEach(function (t) { t.stop(); }); tracks = [];
    if (audioTap) { try { audioTap.source.disconnect(audioTap.destination); } catch (e) {} audioTap = null; }
    if (video) { video.srcObject = null; video.remove(); video = null; }
    if (audio) { audio.srcObject = null; audio.remove(); audio = null; }
    lastTime = -1; lastFrame = 0; audioTrack = null; audioLevel = -1;
    report(false, 'stopped');
  }
  async function connect(c) {
    if (busy || (room && key === c.room && room.state !== 'disconnected')) return;
    stop(); key = c.room; busy = true;
    var epoch = generation;
    try {
      if (!window.RTCPeerConnection || !HTMLCanvasElement.prototype.captureStream) throw new Error('CEF media APIs unavailable');
      var LK = await sdk();
      if (epoch !== generation) return;
      var current = new LK.Room({adaptiveStream: false, dynacast: false});
      room = current;
      current.on(LK.RoomEvent.Disconnected, function () { if (room === current) report(false, 'disconnected'); });
      if (viewer) {
        current.on(LK.RoomEvent.TrackSubscribed, function (track) {
          if (room !== current) return;
          if (track.kind === 'video') {
            if (video) video.remove();
            video = track.attach(); video.muted = true; video.autoplay = true; video.playsInline = true;
            document.body.appendChild(video);
            video.play().catch(function () { report(false, 'video autoplay blocked'); });
          } else if (track.kind === 'audio') {
            if (audio) audio.remove();
            audio = track.attach(); audio.volume = window.GEMUStream.volume; audioTrack = track;
            document.body.appendChild(audio);
            audio.play().catch(function () { report(false, 'audio autoplay blocked'); });
          }
        });
        current.on(LK.RoomEvent.TrackUnsubscribed, function (track) {
          track.detach().forEach(function (element) { element.remove(); });
          lastFrame = 0; report(false, 'track removed');
        });
      }
      await current.connect(c.url, c.token, {autoSubscribe: viewer});
      if (epoch !== generation) { current.disconnect(); return; }
      if (!viewer) {
        // Membership is enabled by the broker after joining, not by the token.
        var deadline = Date.now() + 10000;
        while (!current.localParticipant.permissions?.canPublish && Date.now() < deadline) {
          await new Promise(function (resolve) { setTimeout(resolve, 150); });
          if (epoch !== generation) return;
        }
        if (!current.localParticipant.permissions?.canPublish) throw new Error('publish permission not granted');
        var source = window.GModEmulator && window.GModEmulator.streamSource();
        if (!source || !source.canvas || !source.audio) throw new Error('game capture unavailable');
        var media = source.canvas.captureStream(30);
        tracks = media.getVideoTracks();
        var destination = source.audio.context.createMediaStreamDestination();
        source.audio.connect(destination);
        audioTap = {source: source.audio, destination: destination};
        tracks = tracks.concat(destination.stream.getAudioTracks());
        for (var i = 0; i < tracks.length; i++) {
          await current.localParticipant.publishTrack(tracks[i], {
            source: tracks[i].kind === 'video' ? LK.Track.Source.ScreenShare : LK.Track.Source.ScreenShareAudio,
            videoCodec: 'vp8', simulcast: false,
            videoEncoding: {maxBitrate: 1000000, maxFramerate: 30}, audioBitrate: 64000, dtx: false
          });
          if (epoch !== generation) return;
        }
        report(true, 'publishing');
      }
    } catch (err) {
      if (epoch === generation) { stop(); report(false, 'connection failed'); }
    } finally { if (epoch === generation) busy = false; }
  }
  window.GEMUStream = {
    volume: 0,
    configure: function (c) {
      config = c;
      if (!c) { stop(); return; }
      config.until = Date.now() + 12000;
      // Informational session ID only; credentials never enter browser URLs.
      if (window.history && history.replaceState) history.replaceState(null, '', location.pathname + location.search + '#session=' + encodeURIComponent(c.room));
      connect(c);
    },
    setPaused: function (v) { publisherPaused = !!v; },
    setVolume: function (v) { this.volume = Math.max(0, Math.min(1, Number(v) || 0)); if (audio) audio.volume = this.volume; },
    stop: function () { config = null; stop(); }
  };
  setInterval(function () {
    if (!config) return;
    if (Date.now() > config.until) { window.GEMUStream.stop(); return; }
    if (!viewer && window.GModEmulator && !window.GModEmulator.streamSource()) { window.GEMUStream.stop(); return; }
    if (viewer) {
      if (video && video.readyState >= 2 && video.currentTime !== lastTime) { lastTime = video.currentTime; lastFrame = Date.now(); }
      var receiver = audioTrack && audioTrack.receiver;
      if (receiver && receiver.getStats && Date.now() - levelCheckedAt > 1000) {
        levelCheckedAt = Date.now();
        receiver.getStats().then(function (stats) {
          stats.forEach(function (entry) {
            if (entry.type === 'inbound-rtp' && entry.kind === 'audio' && typeof entry.audioLevel === 'number') audioLevel = entry.audioLevel;
          });
        }).catch(function () {});
      }
      // A paused publisher sends no new frames; a connected track is still healthy.
      report(!!(video && (publisherPaused || Date.now() - lastFrame < 1500) && audio && !audio.paused),
        'receiving' + (audioLevel >= 0 ? ', audio level ' + audioLevel.toFixed(3) : ', audio level unknown'));
    } else if (room && room.state === 'connected' && tracks.length === 2) report(true, 'publishing');
  }, 500);
  window.addEventListener('beforeunload', stop);
})();
