/** Shared Emulatrix bridge for GMod console and handheld sessions. */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var targetSystem = (params.get('system') || '').toLowerCase();
  var systems = window.EmuSystems;
  var system = systems[targetSystem];
  if (!targetSystem || (system && !params.get('rom'))) {
    if (window.GEMULauncher) window.GEMULauncher(targetSystem);
    return;
  }
  // Reported by emu_web_status so live tests can tell which frontend CEF loaded.
  var BRIDGE_BUILD = '2026-09-14.2';
  var stopped = false;
  var shutdownPromise = null;
  var paused = false;
  var streamCanvas = null;
  var loadedGameTitle = null;
  var volume = 0.8;
  var targetRomName = params.get('rom') || '';
  var targetGameTitle = params.get('game') || (system && system.defaultGame) || 'Game';
  var isScreenMode = params.get('mode') === 'screen' || params.get('minimal') === '1';

  var statusOverlay = document.getElementById('status-overlay');
  var titleGame = document.getElementById('title-game');
  var titleSystem = document.getElementById('title-system');
  var controlsTitle = document.getElementById('controls-title');
  var closeButton = document.getElementById('btn-close');
  var volSlider = document.getElementById('vol-slider');
  if (isScreenMode) document.body.classList.add('mode-screen');
  if (titleGame) titleGame.textContent = targetGameTitle;
  if (titleSystem) titleSystem.textContent = system ? system.name : targetSystem.toUpperCase();
  if (controlsTitle) controlsTitle.textContent = (system ? system.name : targetSystem.toUpperCase()) + ' Controller Mapping';
  if (closeButton) closeButton.textContent = system && system.handheld ? 'Play Handheld' : 'Play on TV';
  var controlRows = document.getElementById('controls-rows');
  if (system && controlRows) {
    var rows = [
      ['D-Pad', 'Arrow keys'], ['b', 'Z'], ['a', 'X'],
      ['y', 'C'], ['x', 'V'], ['l', 'Q'], ['r', 'F'],
      ['start', 'Enter'], ['select', 'Backspace']
    ];
    var aliases = targetSystem === 'genesis' ? {b:'a',a:'b',y:'c',x:'x',l:'y',r:'z'} : {};
    controlRows.innerHTML = rows.filter(function(row) {
      return row[0] === 'D-Pad' || system.buttons[aliases[row[0]] || row[0]] !== undefined;
    }).map(function(row) {
      var label = aliases[row[0]] || row[0];
      if (targetSystem === 'genesis' && label === 'select') label = 'mode';
      return '<tr><td>' + label.toUpperCase() + '</td>' + row.slice(1).map(function(key) {
        return '<td>' + key + '</td>';
      }).join('') + '</tr>';
    }).join('') + '<tr><td colspan="2">In GMod: P pause, -/= volume, M mute, F5/F8 save/load, F11 fullscreen, F1 controls, E leave.</td></tr>';
  }

  function setStatus(text, hideAfterMs) {
    if (!statusOverlay) return;
    statusOverlay.textContent = text;
    statusOverlay.classList.remove('hidden');
    if (hideAfterMs) setTimeout(function () { statusOverlay.classList.add('hidden'); }, hideAfterMs);
  }

  if (!system) {
    setStatus('Unsupported emulator system: ' + targetSystem);
    if (window.gmod && window.gmod.onError) window.gmod.onError('Unsupported system: ' + targetSystem);
    return;
  }

  var heldButtons = {};
  function audioContext() { return window[system.audio]; }
  function gainNode() { return window[system.gain]; }

  function fitGameCanvas() {
    var host = document.getElementById('game-container');
    var wrapper = window[system.wrapper];
    if (!host || !wrapper || !host.clientWidth || !host.clientHeight) return;
    var width = Math.min(host.clientWidth, host.clientHeight * system.aspect);
    wrapper.style.width = width + 'px';
    wrapper.style.height = (width / system.aspect) + 'px';
  }
  window.addEventListener('resize', fitGameCanvas);
  if (typeof ResizeObserver !== 'undefined') {
    var resizeHost = document.getElementById('game-container');
    if (resizeHost) new ResizeObserver(fitGameCanvas).observe(resizeHost);
  }

  function applyAudioGain() { system.setVolume(volume); }
  function setButtons(buttons) {
    buttons = Array.isArray(buttons) ? buttons : [];
    heldButtons = {};
    buttons.forEach(function(button) { heldButtons[button] = true; });
    system.setButtons(buttons);
    if (buttons.length) unlockAudio();
  }

  function encodeState(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    }
    return btoa(binary);
  }

  function decodeState(data) {
    var binary = atob(data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  var pauseButton = document.getElementById('btn-pause');
  // Only the player pauses. Report changes so GMod can show and network them.
  function pauseChanged() {
    console.log('[GEMU] ' + (paused ? 'Paused' : 'Resumed') + ' (bridge ' + BRIDGE_BUILD + ')');
    if (pauseButton) pauseButton.textContent = paused ? 'Resume' : 'Pause';
    if (paused) setStatus('Paused');
    else if (statusOverlay && statusOverlay.textContent === 'Paused') statusOverlay.classList.add('hidden');
    if (window.gmod && window.gmod.onPauseChanged) window.gmod.onPauseChanged(paused);
  }

  // Cores pause themselves when the browser loses focus (closing the window,
  // leaving focused play, alt-tab). Undo that unless the player paused.
  var resuming = false;
  function keepRunning() {
    if (resuming || stopped || paused || !GModEmulator.isReady) return;
    if (!system.isPaused || !system.isPaused()) return;
    resuming = true;
    try { system.resume(); } finally { resuming = false; }
  }

  var GModEmulator = {
    isReady: false,
    streamSource: function () {
      // A paused game still publishes its frozen frame; spectators see PAUSED.
      if (!this.isReady || stopped) return null;
      var wrapper = window[system.wrapper];
      return {canvas: wrapper && wrapper.querySelector('canvas'), audio: window[system.gain]};
    },
    configureHardware: system.configureHardware,
    captureFrame: function (quality) {
      if (!this.isReady || stopped || paused || !window.gmod || !window.gmod.onVideoFrame) return;
      var wrapper = window[system.wrapper];
      var source = wrapper && wrapper.querySelector('canvas');
      if (!source || !source.width || !source.height) return;
      try {
        var streamWidth = 256;
        var streamHeight = Math.max(1, Math.round(streamWidth / system.aspect));
        if (!streamCanvas || streamCanvas.width !== streamWidth || streamCanvas.height !== streamHeight) {
          streamCanvas = document.createElement('canvas');
          streamCanvas.width = streamWidth;
          streamCanvas.height = streamHeight;
        }
        streamCanvas.getContext('2d').drawImage(source, 0, 0, streamWidth, streamHeight);
        var data = streamCanvas.toDataURL('image/jpeg', Math.max(20, Math.min(60, Number(quality) || 35)) / 100);
        window.gmod.onVideoFrame(data.slice(data.indexOf(',') + 1));
      } catch (err) { console.error('[Emulator] Screen capture failed:', err); }
    },
    snapshotForHandoff: function () {
      if (!this.isReady || stopped || !window.gmod || !window.gmod.onStateSnapshot) return;
      try {
        var state = this.saveState();
        if (state) window.gmod.onStateSnapshot(state);
      } catch (err) { console.error('[Emulator] Handoff snapshot failed:', err); }
    },
    applyHandoffState: function (data) {
      if (!this.isReady || stopped || typeof data !== 'string') return false;
      var loaded = this.loadState(data);
      setStatus(loaded ? 'Resumed shared game state' : 'Shared game state was incompatible', 3000);
      return loaded;
    },
    getLoadedGame: function () { return loadedGameTitle; },
    press: function (button) {
      heldButtons[String(button).toLowerCase()] = true;
      system.setButtons(Object.keys(heldButtons)); unlockAudio();
    },
    unpress: function (button) {
      delete heldButtons[String(button).toLowerCase()]; system.setButtons(Object.keys(heldButtons));
    },
    setHardwareButtons: setButtons,
    pause: function () {
      var changed = !paused && !stopped;
      // Halt the core first: an autosave failure must never leave the game running.
      paused = true; setButtons([]); system.pause();
      if (!changed) return;
      pauseChanged();
      if (this.isReady && this.saves) {
        try {
          Promise.resolve(this.saves.save("auto", true)).catch(function (err) { console.error('[Emulator] Pause autosave failed:', err); });
        } catch (err) { console.error('[Emulator] Pause autosave failed:', err); }
      }
    },
    resume: function () {
      if (stopped) return;
      var changed = paused;
      paused = false; system.resume(); unlockAudio();
      if (changed) pauseChanged();
    },
    togglePause: function () { if (paused) this.resume(); else this.pause(); return paused; },
    status: function () {
      var context = audioContext();
      var capture = context && context.__gemuAudioCapture;
      return {build: BRIDGE_BUILD, ready: this.isReady, stopped: stopped, paused: paused,
        coreHalted: !!(system.isPaused && system.isPaused()),
        audioWorklet: typeof AudioWorkletNode === 'function', audioCaptureReady: !!(capture && capture.node)};
    },
    isPaused: function () { return paused; },
    reset: function () {
      var fn = window[system.reset];
      if (fn) fn();
      applyAudioGain();
      if (paused) this.pause();
    },
    setVolume: function (value) {
      value = Number(value);
      if (!isFinite(value)) return;
      volume = Math.max(0, Math.min(1, value));
      applyAudioGain();
      if (volSlider) volSlider.value = Math.round(volume * 100);
    },
    getVolume: function () { return volume; },
    saveState: function () {
      try { var bytes = system.save(); return bytes ? encodeState(bytes) : null; }
      catch (err) { console.error('[Emulator] Save failed:', err); return null; }
    },
    loadState: function (data) {
      try { return system.load(decodeState(data)); }
      catch (err) { console.error('[Emulator] Load failed:', err); return false; }
    },
    quickSave: function () { return this.saves.save(); },
    quickLoad: function () { return this.saves.load(); },
    shutdown: function () {
      if (shutdownPromise) return shutdownPromise;
      stopped = true; paused = true;
      setButtons([]); system.pause();
      shutdownPromise = (this.isReady ? this.saves.save('auto', true) : Promise.resolve(true)).then(function (saved) {
        GModEmulator.isReady = false;
        try { system.shutdown(); } catch (err) {}
        var context = audioContext();
        return Promise.resolve(context ? context.close() : null).catch(function () {}).then(function () { return saved; });
      });
      return shutdownPromise;
    }
  };

  window.GModEmulator = GModEmulator;
  GModEmulator.saves = window.createEmuSaves(GModEmulator, targetSystem, targetRomName, setStatus);
  setInterval(function () {
    if (GModEmulator.isReady && !paused && !stopped) GModEmulator.saves.save('auto', true);
  }, 30000);
  var slotSelect = document.getElementById('save-slot');
  if (slotSelect) slotSelect.onchange = function () { GModEmulator.saves.slot = slotSelect.value; };
  var exportButton = document.getElementById('btn-export');
  if (exportButton) exportButton.onclick = function () { GModEmulator.saves.exportFile(); };
  var importButton = document.getElementById('btn-import');
  var importInput = document.getElementById('save-file');
  if (importButton) importButton.onclick = function () {
    if (window.gmod && window.gmod.importSave) window.gmod.importSave();
    else if (importInput) importInput.click();
  };
  if (importInput) importInput.onchange = function () {
    var file = importInput.files && importInput.files[0];
    if (!file) return;
    if (file.size > 8 * 1024 * 1024 + 4096) { setStatus('Save file is too large', 4000); return; }
    var reader = new FileReader();
    reader.onload = function () { GModEmulator.saves.importFile(reader.result); };
    reader.readAsText(file);
  };
  var powerButton = document.getElementById('btn-power');
  if (powerButton) powerButton.onclick = function () {
    GModEmulator.saves.save('auto', true);
    if (window.gmod && window.gmod.powerOff) window.gmod.powerOff();
    else GModEmulator.shutdown();
  };

  function loadCore() {
    if (window[system.embed]) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.src = system.core;
      script.onload = resolve;
      script.onerror = function () { reject(new Error('Unable to load ' + system.name + ' core')); };
      document.head.appendChild(script);
    });
  }

  function bootRom(buffer) {
    if (stopped) return;
    GModEmulator.saves.setROMIdentity(new Uint8Array(buffer));
    setStatus('Initializing ' + system.name + ' core...');
    var config = {
      container: 'game-container', name: targetRomName, rom: buffer,
      soundEnabled: true, showMobileControls: false,
      player1: window.gmod ? {} : system.player,
      cbError: function (err) {
        GModEmulator.isReady = false;
        setStatus('Failed to start: ' + String(err));
        if (window.gmod && window.gmod.onError) window.gmod.onError(String(err));
      },
      cbStarted: function () {
        if (stopped) return;
        applyAudioGain();
        fitGameCanvas();
        GModEmulator.isReady = true;
        loadedGameTitle = targetGameTitle;
        GModEmulator.saves.load("auto", true).then(function () {
        if (stopped) return;
        if (titleGame) titleGame.textContent = targetGameTitle;
        if (!GModEmulator.saves.lastError) setStatus('Running ' + targetGameTitle, 2500);
        if (window.gmod) {
          if (window.gmod.onReady) window.gmod.onReady();
          if (window.gmod.onGameLoaded) window.gmod.onGameLoaded(targetGameTitle);
        }
        });
      }
    };
    if (system.prepareAudioCapture) system.prepareAudioCapture(function (data, sampleRate) {
      if (window.gmod && window.gmod.onAudioFrame) window.gmod.onAudioFrame(data, sampleRate);
    });
    config.player2 = {};
    window[system.embed](config);
  }

  function fetchAndStart() {
    // All systems use the ROM directory beside this shared hosted frontend.
    var romUrl = 'roms/' + encodeURIComponent(targetSystem) + '/' + encodeURIComponent(targetRomName);
    setStatus('Loading ' + targetGameTitle + '...');
    Promise.all([loadCore(), fetch(romUrl).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status + ' loading ROM: ' + romUrl);
      return res.arrayBuffer();
    })]).then(function (result) {
      if (!stopped) bootRom(result[1]);
    }).catch(function (err) {
      if (stopped) return;
      console.error('[Emulator] Startup failed:', err);
      setStatus('Failed to start: ' + err.message);
      if (window.gmod && window.gmod.onError) window.gmod.onError(String(err));
    });
  }

  var btnFullscreen = document.getElementById('btn-fullscreen');
  if (btnFullscreen) btnFullscreen.onclick = function () {
    if (window.gmod && window.gmod.fullscreen) window.gmod.fullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  };
  if (pauseButton) pauseButton.onclick = function () { GModEmulator.togglePause(); };
  var btnReset = document.getElementById('btn-reset');
  if (btnReset) btnReset.onclick = function () { GModEmulator.reset(); };
  var btnSave = document.getElementById('btn-save');
  if (btnSave) btnSave.onclick = function () { GModEmulator.quickSave(); };
  var btnLoad = document.getElementById('btn-load');
  if (btnLoad) btnLoad.onclick = function () { GModEmulator.quickLoad(); };
  var modal = document.getElementById('modal-controls');
  var btnControls = document.getElementById('btn-controls');
  var btnModalClose = document.getElementById('btn-modal-close');
  if (btnControls && modal) btnControls.onclick = function () {
    if (window.gmod && window.gmod.configureControls) window.gmod.configureControls();
    else modal.classList.add('open');
  };
  if (btnModalClose && modal) btnModalClose.onclick = function () { modal.classList.remove('open'); };
  if (volSlider) volSlider.oninput = function () {
    GModEmulator.setVolume(parseFloat(volSlider.value) / 100);
    if (window.gmod && window.gmod.onVolume) window.gmod.onVolume(volume);
  };

  function unlockAudio() {
    var context = audioContext();
    if (context && context.state === 'suspended') context.resume().catch(function () {});
  }
  window.addEventListener('click', unlockAudio, {passive:true});
  window.addEventListener('keydown', unlockAudio, {passive:true});
  window.addEventListener('blur', function () {
    setButtons([]);
    // Runs after the core's own blur handler has paused it.
    setTimeout(keepRunning, 0);
  });
  // Native CEF focus can trigger a core resume; keep a deliberately paused session paused.
  window.addEventListener('focus', function () {
    setTimeout(function () { if (paused || stopped) GModEmulator.pause(); else keepRunning(); }, 0);
  });
  setInterval(keepRunning, 1000);
  window.addEventListener('load', fetchAndStart);
})();
