/* Save records are local to this player. CRC checks detect corruption, not tampering. */
(function () {
  'use strict';
  var LIMIT=8*1024*1024, BUILD='gemu-state-20260905';
  var crcTable=[];
  for (var n=0;n<256;n++) { var c=n; for(var k=0;k<8;k++) c=c&1?0xedb88320^(c>>>1):c>>>1; crcTable[n]=c; }
  function crc(value) {
    var c=0xffffffff;
    for(var i=0;i<value.length;i++) c=crcTable[(c^value.charCodeAt(i))&255]^(c>>>8);
    return String((c^0xffffffff)>>>0);
  }
  window.EmuSaveCRC=crc;
  window.createEmuSaves=function(emulator,system,rom,status) {
    var prefix='gemu_save_v1_'+system+'_'+rom+'_';
    var storage=window.createEmuSaveStorage(prefix), queue=Promise.resolve(), identity='', blockedAuto=false;
    function slotKey(slot) {
      slot=String(slot);
      if(['1','2','3','auto'].indexOf(slot)<0) throw new Error('Invalid save slot');
      return slot;
    }
    function validate(record) {
      if(!record || (record.version!==1 && record.version!==2) || record.system!==system || record.rom!==rom ||
         typeof record.state!=='string' || !record.state.length || record.state.length>LIMIT ||
         record.state.length%4!==0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(record.state) ||
         btoa(atob(record.state))!==record.state) throw new Error('Invalid save or wrong game');
      if(record.version===2 && (record.checksum!==crc(record.state) || record.build!==BUILD ||
          record.romIdentity!==identity)) throw new Error('Save is damaged or belongs to a different ROM/core build');
      return record;
    }
    function parse(data) {
      if(typeof data!=='string' || data.length>LIMIT+4096) throw new Error('Invalid save file size');
      return validate(JSON.parse(data));
    }
    function capture() {
      if(!emulator.isReady) throw new Error('Game is not ready');
      var state=emulator.saveState();
      if(typeof state!=='string') throw new Error('Core did not provide a save state');
      return validate({version:2,system:system,rom:rom,romIdentity:identity,build:BUILD,
        time:new Date().toISOString(),state:state,checksum:crc(state)});
    }
    function serial(fn) { var result=queue.then(fn); queue=result.catch(function(){}); return result; }
    function failure(prefix,err) { status(prefix+err.message,6000); return false; }
    var api={
      slot:'1', lastError:null,
      setROMIdentity:function(bytes) {
        var c=0xffffffff;
        for(var i=0;i<bytes.length;i++) c=crcTable[(c^bytes[i])&255]^(c>>>8);
        identity=bytes.length+':'+String((c^0xffffffff)>>>0);
      },
      save:function(slot,quiet) {
        slot=slot || this.slot;
        return serial(function() {
          slot=slotKey(slot);
          if(slot==='auto' && blockedAuto) throw new Error('Autosave recovery failed; damaged saves are preserved. Save to a manual slot or import a valid save first.');
          var record=capture();
          return storage.write(slot,JSON.stringify(record)).then(function(result) {
            api.lastError=null;
            if(slot!=='auto') blockedAuto=false;
            if(result && result.warning) status(result.warning,6000);
            else if(!quiet) status('Saved slot '+slot,2000);
            return true;
          });
        }).catch(function(err) { api.lastError=err.message; return failure('Save failed: ',err); });
      },
      load:function(slot,quiet) {
        slot=slot || this.slot;
        return serial(function() {
          slot=slotKey(slot);
          if(!emulator.isReady) throw new Error('Game is not ready');
          return storage.read(slot).then(function(stored) {
            var candidates=[stored.current,stored.previous], legacy=false;
            if(!stored.current && !stored.previous) {
              // Migrate the previous browser-local format without deleting it.
              try {
                candidates=[localStorage.getItem(prefix+slot),localStorage.getItem(prefix+slot+'_previous')];
                if(!candidates[0] && slot==='1') {
                  var old=localStorage.getItem(system+'_quick_save_'+rom);
                  if(old) candidates[0]=JSON.stringify({version:1,system:system,rom:rom,state:old});
                }
                legacy=!!candidates[0];
              } catch(err) {}
            }
            var present=false, errors=[];
            for(var i=0;i<candidates.length;i++) {
              if(!candidates[i]) continue;
              present=true;
              try {
                var record=parse(candidates[i]);
                // Restore current state if a rejected core load mutated anything.
                var before=emulator.saveState();
                if(!emulator.loadState(record.state)) {
                  if(before) emulator.loadState(before);
                  throw new Error('Core rejected save');
                }
                blockedAuto=false; api.lastError=null;
                if(i>0) status('Recovered previous save; primary file was unusable',5000);
                else if(!quiet) status('Save loaded',2000);
                if(legacy) return storage.write(slot,JSON.stringify(capture())).then(function(){return true;});
                return true;
              } catch(err) { errors.push(err.message); }
            }
            if(present) throw new Error(errors.join('; '));
            if(!quiet) status('No save in this slot',2000);
            return false;
          });
        }).catch(function(err) {
          if(slot==='auto') blockedAuto=true;
          api.lastError=err.message; return failure('Load failed: ',err);
        });
      },
      exportFile:function() {
        return serial(function() {
          // Export is deliberately independent of storage quota and slot writes.
          var data=JSON.stringify(capture());
          if(window.gmod && window.gmod.exportSave) window.gmod.exportSave(data);
          else {
            var link=document.createElement('a'), url=URL.createObjectURL(new Blob([data],{type:'application/json'}));
            link.href=url; link.download=system+'_'+rom+'_slot_'+api.slot+'.json'; link.click();
            setTimeout(function(){URL.revokeObjectURL(url);},1000);
          }
          return true;
        }).catch(function(err){return failure('Export failed: ',err);});
      },
      importFile:function(data) {
        return serial(function() {
          var record=parse(data), before=emulator.saveState();
          if(!emulator.loadState(record.state)) {
            if(before) emulator.loadState(before);
            throw new Error('Core rejected save');
          }
          var imported=JSON.stringify(capture());
          return storage.write(slotKey(api.slot),imported).then(function(result) {
            blockedAuto=false; api.lastError=null;
            status(result && result.warning || 'Imported and saved',4000); return true;
          },function(err) {
            if(before) emulator.loadState(before);
            throw err;
          });
        }).catch(function(err){api.lastError=err.message;return failure('Import failed: ',err);});
      },
      flush:function(){return queue;}
    };
    return api;
  };
})();
