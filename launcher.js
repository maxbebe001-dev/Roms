/* The bare deployment URL is a library, never an implicit emulator session. */
window.GEMULauncher = async function (selected) {
  document.title = 'GEMU — Game library';
  document.getElementById('app').hidden = true;
  var main = document.createElement('main');
  main.className = 'gemu-library';
  main.innerHTML = '<h1>GEMU</h1><p>Choose a system and game to play in this browser.</p>' +
    '<p class="library-note">In Garry’s Mod, press Use on a console or handheld. Nearby spectators join that device’s gameplay automatically.</p>' +
    '<nav aria-label="Systems"></nav><div class="library-games">Loading library…</div>';
  document.body.appendChild(main);
  var nav = main.querySelector('nav'), games = main.querySelector('.library-games');
  ['all','nes','snes','gba','gb','gbc','genesis'].forEach(function (id) {
    var link = document.createElement('a');
    link.textContent = id === 'all' ? 'All systems' : window.EmuSystems[id].name;
    link.href = id === 'all' ? './' : '?system=' + id;
    if (id === (selected || 'all')) link.setAttribute('aria-current', 'page');
    nav.appendChild(link);
  });
  try {
    var response = await fetch('roms.json', {cache: 'no-store'});
    if (!response.ok) throw new Error('library unavailable');
    var catalog = await response.json();
    games.textContent = '';
    catalog.roms.filter(function (row) { return (!selected || row.system === selected) && window.EmuSystems[row.system]; }).forEach(function (row) {
      var link = document.createElement('a'), name = row.title || row.filename.replace(/\.[^.]+$/, '').replace(/_/g, ' ');
      link.className = 'library-game';
      link.href = '?' + new URLSearchParams({system: row.system, rom: row.filename, game: name});
      var title = document.createElement('strong'), system = document.createElement('span');
      title.textContent = name; system.textContent = window.EmuSystems[row.system].name;
      link.appendChild(title); link.appendChild(system); games.appendChild(link);
    });
    if (!games.children.length) games.textContent = 'No games configured for this system.';
  } catch (e) { games.textContent = 'The game library is unavailable. Check this deployment’s roms.json.'; }
};
