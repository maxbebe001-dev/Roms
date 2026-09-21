/** Core-specific Emulatrix details. app.js owns the common session and UI. */
(function () {
  'use strict';
  var retro = {b:0,select:2,start:3,up:4,down:5,left:6,right:7,a:8};
  var systems = {
    snes: {name:'SNES', prefix:'SUPERNINTENDO', core:'snes', embed:'embedSuperNintendo', reset:'resetSuperNintendo',
      aspect:4/3, audio:'SUPERNINTENDO_AUDIO_CONTEXT', gain:'SUPERNINTENDO_AUDIO_GAIN', module:'SNES_MODULE', state:'snes',
      input:'SUPERNINTENDO_KEY_INPUT_1', input2:'SUPERNINTENDO_KEY_INPUT_2', mask:true, buttons:{up:1<<11,down:1<<10,left:1<<9,right:1<<8,a:1<<7,b:1<<15,x:1<<6,y:1<<14,l:1<<5,r:1<<4,start:1<<12,select:1<<13},
      maps:['SUPERNINTENDO_KEYMAP1','SUPERNINTENDO_KEYMAP2'], defaultRom:'super_mario_world.smc', defaultGame:'Super Mario World'},
    gba: {name:'GBA', prefix:'GAMEBOYADVANCE', core:'gba', embed:'embedGameBoyAdvance', reset:'resetGameBoyAdvance',
      handheld:true, aspect:3/2, audio:'GAMEBOYADVANCE_AUDIO_CTX', gain:'GAMEBOYADVANCE_GAIN_NODE', module:'GBA_MODULE',
      input:'GAMEBOYADVANCE_KEYS', buttons:Object.assign({l:10,r:11},retro), maps:['GAMEBOYADVANCE_KEY_MAP'],
      defaultRom:'pokemon_firered.gba', defaultGame:'Pokemon FireRed'},
    nes: {name:'NES', prefix:'NINTENDO', core:'nes', embed:'embedNintendo', reset:'resetNintendo',
      aspect:4/3, audio:'NINTENDO_AUDIO_CONTEXT', gain:'NINTENDO_GAIN_NODE', module:'NES_MODULE',
      input:'NINTENDO_KEYSTATE1', input2:'NINTENDO_KEYSTATE2', buttons:retro, maps:['NINTENDO_KEYMAP1','NINTENDO_KEYMAP2'], defaultRom:'super_mario_bros_duck_hunt.nes', defaultGame:'Super Mario Bros. / Duck Hunt'},
    gb: {name:'GB', prefix:'GAMEBOY', core:'gb', embed:'embedGameBoy', reset:'resetGameBoy',
      handheld:true, aspect:10/9, audio:'GAMEBOY_AUDIO_CTX', gain:'GAMEBOY_GAIN_NODE', module:'GB_MODULE',
      input:'GAMEBOY_INPUT_STATE', buttons:retro, maps:['GAMEBOY_KEY_MAP'], defaultRom:'pokemon_blue.gb', defaultGame:'Pokemon Blue'},
    genesis: {name:'Genesis', prefix:'GENESIS', core:'genesis', embed:'embedGenesis', reset:'resetGenesis',
      aspect:4/3, audio:'GENESIS_AUDIO_CONTEXT', gain:'GENESIS_AUDIO_GAIN', module:'GENESIS', state:'genesis',
      input:'GENESIS_INPUT_STATE_1', input2:'GENESIS_INPUT_STATE_2', mask:true, buttons:{up:0,down:0,left:0,right:0,a:0,b:0,c:0,x:0,y:0,z:0,start:0,select:0},
      maps:['GENESIS_KEY_MAP_1','GENESIS_KEY_MAP_2'], defaultRom:'sonic_the_hedgehog.bin', defaultGame:'Sonic the Hedgehog'}
  };
  systems.gbc = Object.assign({}, systems.gb, {name:'GBC', defaultRom:'pokemon_silver.gbc', defaultGame:'Pokemon Silver'});
  Object.keys(systems).forEach(function (id) {
    var s = systems[id];
    s.id = id;
    s.wrapper = s.prefix + '_WRAPPER';
    s.core = 'cores/' + s.core + '/emulatrix.js';
    s.defaultGame = s.defaultGame || 'GEMU Test';
    s.player = {up:'ArrowUp',down:'ArrowDown',left:'ArrowLeft',right:'ArrowRight',a:'KeyX',b:'KeyZ',x:'KeyV',y:'KeyC',l:'KeyQ',r:'KeyF',start:'Enter',select:'Backspace'};
    if (id === 'genesis') s.player = {up:'ArrowUp',down:'ArrowDown',left:'ArrowLeft',right:'ArrowRight',a:'KeyZ',b:'KeyX',c:'KeyC',x:'KeyV',y:'KeyQ',z:'KeyF',start:'Enter',mode:'Backspace'};
    s.configureHardware = function () { s.maps.forEach(function (key) { window[key] = {}; }); };
    s.setButtons = function (buttons) {
      var state = s.mask ? 0 : {};
      buttons.forEach(function (button) {
        var value = s.state === 'genesis' ? window['GENESIS_BTN_' + (button === 'select' ? 'MODE' : button.toUpperCase())] : s.buttons[button];
        if (value === undefined) return;
        if (s.mask) state |= value; else state[value] = true;
      });
      window[s.input] = state;
    };
    s.setPlayer2Buttons = function (buttons) {
      if (!s.input2) return;
      var state = s.mask ? 0 : {};
      buttons = Array.isArray(buttons) ? buttons : [];
      buttons.forEach(function (button) {
        var value = s.state === 'genesis' ? window['GENESIS_BTN_' + (button === 'select' ? 'MODE' : button.toUpperCase())] : s.buttons[button];
        if (value === undefined) return;
        if (s.mask) state |= value; else state[value] = true;
      });
      window[s.input2] = state;
    };
    s.setVolume = function (volume) {
      var context = window[s.audio];
      if (!context || context.state === 'closed') return;
      var gain = window[s.gain];
      if (!gain || gain.context !== context) {
        gain = context.createGain(); gain.connect(context.destination); window[s.gain] = gain;
      }
      if (gain.gain.setValueAtTime) gain.gain.setValueAtTime(volume, context.currentTime); else gain.gain.value = volume;
      window[s.prefix + '_MUTED'] = false;
      window[s.prefix + '_SOUND_ENABLED'] = true;
    };
    s.prepareAudioCapture = function (callback) {
      var AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor || AudioCtor.__gemuWrapped) return;
      function install(context) {
        if (!context || context.__gemuAudioCapture) {
          if (context && context.__gemuAudioCapture) context.__gemuAudioCapture.callback = callback;
          return;
        }
        var capture = {callback: callback, rate: 11025, node: null, taps: []};
        context.__gemuAudioCapture = capture;
        // Game output is tapped into an AudioWorklet once its module loads;
        // connections made earlier are attached when it becomes ready.
        capture.tap = function (connect) {
          if (capture.node) { try { connect(capture.node); } catch (err) {} }
          else capture.taps.push(connect);
        };
        if (!context.audioWorklet || typeof AudioWorkletNode !== 'function') return;
        var createSilentGain = context.createGain.bind(context);
        context.audioWorklet.addModule('capture-worklet.js').then(function () {
          if (context.state === 'closed') return;
          var node = new AudioWorkletNode(context, 'gemu-capture', {
            numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
            processorOptions: {rate: capture.rate, block: 1024}
          });
          // Keep the node pulled by the graph without making the tap audible.
          // The sink comes from the unpatched factory so it never feeds back.
          var sink = createSilentGain();
          sink.gain.value = 0;
          node.connect(sink);
          sink.connect(context.destination);
          node.port.onmessage = function (event) {
            if (capture.callback) capture.callback(window.GEMUAudio.encode(event.data), capture.rate);
          };
          capture.node = node;
          capture.taps.splice(0).forEach(function (connect) { try { connect(node); } catch (err) {} });
        }).catch(function (err) { console.error('[Emulator] Spectator audio capture unavailable:', err); });
        function patchNode(node) {
          if (!node || node.__gemuAudioCapturePatched) return node;
          var connect = node.connect.bind(node);
          node.connect = function (destination) {
            var result = connect(destination);
            if (destination === context.destination && !node.__gemuAudioCaptureTapped) {
              node.__gemuAudioCaptureTapped = true;
              capture.tap(connect);
            }
            return result;
          };
          node.__gemuAudioCapturePatched = true;
          return node;
        }
        var createGain = context.createGain.bind(context);
        context.createGain = function () { return patchNode(createGain()); };
        var createSource = context.createBufferSource && context.createBufferSource.bind(context);
        if (createSource) context.createBufferSource = function () { return patchNode(createSource()); };
        patchNode(window[s.gain]);
      }
      function WrappedAudioContext(options) {
        var context = new AudioCtor(options);
        install(context);
        return context;
      }
      WrappedAudioContext.prototype = AudioCtor.prototype;
      WrappedAudioContext.__gemuWrapped = true;
      WrappedAudioContext.__gemuOriginal = AudioCtor;
      window.AudioContext = WrappedAudioContext;
      if (window.webkitAudioContext) window.webkitAudioContext = WrappedAudioContext;
    };
    s.pause = function () {
      if (id === 'snes') window.SUPERNINTENDO_GAME_RUNNING = false;
      else if (window.dispatchEvent && window.Event) window.dispatchEvent(new Event('blur'));
    };
    s.resume = function () {
      if (id === 'snes' && window.SUPERNINTENDO_GAME_BOOTED) {
        window.SUPERNINTENDO_GAME_RUNNING = true; window.SUPERNINTENDO_LAST_FRAME_TIME = 0;
        if (!window.SUPERNINTENDO_LOOP_ACTIVE && window.requestFrameSuperNintendo) {
          window.SUPERNINTENDO_LOOP_ACTIVE = true; requestAnimationFrame(window.requestFrameSuperNintendo);
        }
      } else if (window.dispatchEvent && window.Event) window.dispatchEvent(new Event('focus'));
    };
    // True when the core halted itself, for example on a browser blur.
    s.isPaused = function () {
      if (id === 'snes') return !!window.SUPERNINTENDO_GAME_BOOTED && !window.SUPERNINTENDO_GAME_RUNNING;
      if (id === 'genesis') return !!window.GENESIS_GAME_PAUSED;
      return !!window[s.prefix + '_PAUSED'];
    };
    s.save = function () {
      var m = window[s.module], size, ptr;
      if (!m) return null;
      if (s.state === 'snes') {
        size=m._getStateSaveSize(); ptr=m._saveState();
        if (!ptr || size<=0) return null;
        var bytes=new Uint8Array(new Uint8Array(m.HEAP8.buffer,ptr,size)); m._my_free(ptr); return bytes;
      }
      if (s.state === 'genesis') {
        if (!window.GENESIS_PICO_STATE_SAVE()) return null;
        ptr=window.GENESIS_PICO_GET_STATE_BUFFER(); size=window.GENESIS_PICO_GET_STATE_SIZE();
        return ptr && size>0 ? new Uint8Array(m.HEAPU8.subarray(ptr,ptr+size)) : null;
      }
      size=m._retro_serialize_size(); if (size<=0) return null;
      ptr=m._malloc(size); if (!ptr) return null;
      try { return m._retro_serialize(ptr,size) ? new Uint8Array(m.HEAPU8.subarray(ptr,ptr+size)) : null; }
      finally {m._free(ptr);}
    };
    s.load = function (bytes) {
      var m=window[s.module],ptr;
      if (!m || !bytes.length) return false;
      if (s.state === 'genesis') {
        ptr=window.GENESIS_PICO_GET_STATE_LOAD_BUFFER(bytes.length); if (!ptr) return false;
        m.HEAPU8.set(bytes,ptr); return !!window.GENESIS_PICO_STATE_LOAD();
      }
      if (s.state === 'snes') {
        if (bytes.length !== m._getStateSaveSize()) return false;
        ptr=m._my_malloc(bytes.length); if (!ptr) return false;
        try {m.HEAP8.set(bytes,ptr);m._loadState(ptr,bytes.length);return true;} finally {m._my_free(ptr);}
      }
      if (bytes.length !== m._retro_serialize_size()) return false;
      ptr=m._malloc(bytes.length); if (!ptr) return false;
      try {m.HEAPU8.set(bytes,ptr);return !!m._retro_unserialize(ptr,bytes.length);} finally {m._free(ptr);}
    };
    s.shutdown = function () {
      s.pause();
      var m=window[s.module];
      if (m && m._retro_unload_game) m._retro_unload_game();
      window[s.prefix + '_RUNNING']=false;
    };
  });
  // Spectator fallback audio is 8-bit mu-law: half the bytes of PCM16.
  window.GEMUAudio = {
    encode: function (samples) {
      var binary = '';
      for (var i = 0; i < samples.length; i++) {
        var s = Math.max(-1, Math.min(1, samples[i] || 0));
        var level = Math.round(Math.log(1 + 255 * Math.abs(s)) / Math.log(256) * 127);
        binary += String.fromCharCode(~((s < 0 ? 0x80 : 0) | level) & 0xff);
      }
      return btoa(binary);
    }
  };
  window.EmuSystems = systems;
})();
