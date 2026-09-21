/* Native GMod data storage, with browser-local fallback for standalone testing. */
(function () {
  'use strict';
  var pending = {}, sequence = 0;
  window.EmuSaveIO = {
    complete: function (id, ok, value) {
      var request = pending[id];
      if (!request) return;
      clearTimeout(request.timer); delete pending[id];
      if (ok) request.resolve(value); else request.reject(new Error(value || 'Save storage failed'));
    }
  };
  function native(method, slot, value) {
    return new Promise(function (resolve, reject) {
      var id = ++sequence;
      pending[id] = {resolve:resolve,reject:reject,timer:setTimeout(function () {
        delete pending[id]; reject(new Error('GMod save storage did not respond'));
      }, 4000)};
      window.gmod[method](id, String(slot), value || '');
    });
  }
  window.createEmuSaveStorage = function (prefix) {
    var required=!!(window.location && new URLSearchParams(window.location.search).get('storage')==='gmod');
    function bridge(method) {
      return new Promise(function(resolve,reject) {
        var attempts=0;
        function wait() {
          if(window.gmod && window.gmod[method]) return resolve(true);
          if(!required) return resolve(false);
          if(++attempts>=80) return reject(new Error('Native save bridge is unavailable; reload the updated addon'));
          setTimeout(wait,50);
        }
        wait();
      });
    }
    return {
      read: function (slot) {
        return bridge('readSaveSlot').then(function(useNative) {
          if(useNative) return native('readSaveSlot',slot).then(JSON.parse);
          return {current:localStorage.getItem(prefix+slot), previous:localStorage.getItem(prefix+slot+'_previous')};
        });
      },
      write: function (slot, data) {
        return bridge('writeSaveSlot').then(function(useNative) {
          if(useNative) return native('writeSaveSlot',slot,data);
          var key=prefix+slot, old=localStorage.getItem(key);
          // setItem is atomic: a quota failure must leave the old primary intact.
          localStorage.setItem(key,data);
          if (old) {
            try { localStorage.setItem(key+'_previous',old); }
            catch (err) { return {warning:'Saved, but browser storage is too full for a backup. Export a copy.'}; }
          }
          return {};
        });
      }
    };
  };
})();
