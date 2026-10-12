  /* ── Platform + theme ── */
  document.documentElement.dataset.platform = (window.tagApp && window.tagApp.platform) || 'web';
  const root = document.documentElement;
  const themeToggle = document.getElementById('themeToggle');
  let themeHook = null;
  const css = n => getComputedStyle(root).getPropertyValue(n).trim();
  function systemDark() { return window.matchMedia('(prefers-color-scheme: dark)').matches; }
  function isDark() { try { const t = localStorage.getItem('theme'); if (t) return t === 'dark'; } catch (e) {} return systemDark(); }
  function applyTheme() {
    const d = isDark();
    root.setAttribute('data-theme', d ? 'dark' : 'light');
    themeToggle.title = d ? 'Switch to light mode' : 'Switch to dark mode';
    themeToggle.querySelector('.ico-sun').style.display = d ? '' : 'none';
    themeToggle.querySelector('.ico-moon').style.display = d ? 'none' : '';
    if (themeHook) themeHook();
    if (window.tagApp) window.tagApp.setTheme({ color: css('--toolbar'), symbol: css('--text') });
  }
  themeToggle.addEventListener('click', () => {
    try { localStorage.setItem('theme', isDark() ? 'light' : 'dark'); } catch (e) {}
    applyTheme();
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    let stored = null; try { stored = localStorage.getItem('theme'); } catch (e) {}
    if (!stored) applyTheme();
  });
  applyTheme();

  /* ── State ── */
  let queue = [];
  let activeId = null;
  let ffmpegLoaded = false;

  const queueList = document.getElementById('queueList');
  const coverImg = document.getElementById('coverImg');
  const coverPh = document.getElementById('coverPh');
  const dlBtn = document.getElementById('dlBtn');
  const dlLabel = document.getElementById('dlLabel');
  const zipBtn = document.getElementById('zipBtn');
  const toast = document.getElementById('toast');
  const tplInput = document.getElementById('tplInput');
  const tplPreview = document.getElementById('tplPreview');
  const tplExt = document.getElementById('tplExt');

  const { FFmpeg } = window.FFmpegWASM;
  const ffmpeg = new FFmpeg();

  /* ── Wavesurfer ── */
  const ws = WaveSurfer.create({
    container: '#waveform',
    waveColor: css('--wave'),
    progressColor: css('--accent'),
    height: 36,
    barWidth: 2,
    barGap: 1,
    barRadius: 2,
    cursorWidth: 0,
  });
  const wsRegions = ws.registerPlugin(WaveSurfer.Regions.create());
  themeHook = () => ws.setOptions({ waveColor: css('--wave'), progressColor: css('--accent') });

  ws.on('ready', () => {
    const duration = ws.getDuration();
    const item = queue.find(q => q.id === activeId);
    if(!item) return;
    item.duration = duration;
    wsRegions.clearRegions();
    wsRegions.addRegion({
      start: item.cropStart !== undefined ? item.cropStart : 0,
      end: item.cropEnd !== undefined ? item.cropEnd : duration,
      color: 'rgba(192, 57, 43, 0.12)',
      drag: true, resize: true
    });
  });

  wsRegions.on('region-updated', (region) => {
    const item = queue.find(q => q.id === activeId);
    if(item) { item.cropStart = region.start; item.cropEnd = region.end; }
  });

  const playBtn = document.getElementById('wsPlayBtn');
  playBtn.onclick = () => ws.playPause();
  ws.on('play', () => playBtn.textContent = '⏸');
  ws.on('pause', () => playBtn.textContent = '▶');

  function showToast(msg, ms = 2400) {
    toast.textContent = msg; toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), ms);
  }

  /* ── FFmpeg Engine ── */
  (async function initEngine() {
    try {
      const coreBase = new URL('vendor/ffmpeg/', location.href).href;
      await ffmpeg.load({ coreURL: `${coreBase}ffmpeg-core.js`, wasmURL: `${coreBase}ffmpeg-core.wasm` });
      ffmpegLoaded = true;
      document.getElementById('statusMsg').textContent = 'Engine ready — drop files to begin';
      document.getElementById('statusDot').style.background = '#3da35d';
    } catch (e) {
      document.getElementById('statusMsg').textContent = 'Engine error. Check console.';
      document.getElementById('statusDot').style.background = '#c0392b';
    }
  })();

  /* ── File handling ── */
  /* ── File handling: drop audio anywhere in the window ── */
  const dropOverlay = document.getElementById('dropOverlay');
  let dragDepth = 0;
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  window.addEventListener('dragenter', e => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; dropOverlay.classList.add('show'); });
  window.addEventListener('dragover', e => { if (!hasFiles(e)) return; e.preventDefault(); });
  window.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) dropOverlay.classList.remove('show');
  });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; dropOverlay.classList.remove('show');
    if (e.target.closest && e.target.closest('#coverZone')) return; // cover zone has its own handler
    const audio = Array.from(e.dataTransfer.files).filter(f => /\.(mp3|m4a|aac|flac|wav)$/i.test(f.name) || (f.type || '').startsWith('audio/'));
    if (audio.length) handleFiles(audio); else showToast('No supported audio files in that drop');
  });
  document.getElementById('audioInput').addEventListener('change', e => { if (e.target.files.length) handleFiles(e.target.files); e.target.value = ''; });

  async function handleFiles(files) {
    const fileArray = Array.from(files);
    const hasLossless = fileArray.some(f => f.name.toLowerCase().endsWith('.flac') || f.name.toLowerCase().endsWith('.wav'));
    
    let convertChoice = 'original';
    if (hasLossless) {
      document.getElementById('modalBackdrop').style.display = 'block';
      document.getElementById('convertModal').style.display = 'flex';
      convertChoice = await new Promise(resolve => {
        window.resolveModal = (choice) => {
          document.getElementById('modalBackdrop').style.display = 'none';
          document.getElementById('convertModal').style.display = 'none';
          resolve(choice);
        }
      });
    }

    for (let file of fileArray) {
      const ext = file.name.split('.').pop().toLowerCase();
      const isLossless = (ext === 'flac' || ext === 'wav');
      
      const item = {
        id: Date.now() + Math.random(), file, originalName: file.name, ext,
        targetExt: (isLossless && convertChoice !== 'original') ? convertChoice : ext,
        buffer: null, coverFile: null, coverBuffer: null, newCoverAdded: false,
        duration: 0, cropStart: undefined, cropEnd: undefined,
        tags: { title: '', artist: '', albumartist: '', album: '', year: '', track: '', genre: '', lyrics: '', comment: '', explicit: false }
      };
      queue.push(item);
      renderQueue();
      
      if (item.targetExt === 'mp3' && ext === 'mp3') {
        const r = new FileReader();
        r.onload = e => item.buffer = e.target.result;
        r.readAsArrayBuffer(file);
      }

      jsmediatags.read(file, {
        onSuccess: tag => {
          const t = tag.tags;
          item.tags.title = t.title || ''; item.tags.artist = t.artist || '';
          item.tags.album = t.album || ''; item.tags.year = t.year || '';
          item.tags.track = t.track || ''; item.tags.genre = t.genre || '';
          item.tags.comment = t.comment?.text || t.comment || '';
          item.tags.lyrics = t.USLT?.lyrics || t.lyrics || '';
          const aa = t.TPE2 || t.aART;
          item.tags.albumartist = typeof aa === 'object' ? aa.data : (aa || '');

          if (t.picture) {
            const blob = new Blob([new Uint8Array(t.picture.data)], { type: t.picture.format });
            item.coverFile = new File([blob], 'cover.jpg', { type: t.picture.format });
            item.newCoverAdded = false;
            const fr = new FileReader();
            fr.onload = e => { item.coverBuffer = e.target.result; if(activeId === item.id) loadForm(item.id); };
            fr.readAsArrayBuffer(blob);
          }
          if (activeId === item.id) loadForm(item.id);
        }
      });
    }
    if (!activeId && queue.length > 0) setActive(queue[0].id);
    dlBtn.disabled = false;
    zipBtn.disabled = false;
    scUploadBtn.disabled = false;
    document.getElementById('convertQueueBtn').disabled = false;
  }

  function renderQueue() {
    queueList.innerHTML = '';
    if (queue.length === 0) {
      queueList.innerHTML = '<div class="empty-state"><div class="empty-ico">♫</div><div class="empty-title">No tracks yet</div><div class="empty-sub">Drop audio files anywhere, or press Add</div></div>';
      document.body.classList.remove('has-items');
      document.getElementById('queueCount').textContent = '';
      return;
    }
    document.body.classList.add('has-items');
    document.getElementById('queueCount').textContent = queue.length;
    queue.forEach(item => {
      const div = document.createElement('div');
      div.className = `queue-item ${item.id === activeId ? 'active' : ''}`;
      div.title = 'Right-click to convert or remove';
      const shown = item.tags.title || item.originalName.replace(/\.[^.]+$/, '');
      div.innerHTML = `<span class="fmt">${escapeHtml(item.targetExt)}</span><span class="q-text"><span class="q-name">${escapeHtml(shown)}</span><span class="q-sub">${escapeHtml(item.tags.artist || item.originalName)}</span></span>`;
      div.onclick = () => setActive(item.id);
      div.addEventListener('contextmenu', e => openCtxMenu(e, item.id));
      queueList.appendChild(div);
    });
  }

  function setActive(id) {
    activeId = id; renderQueue(); loadForm(id);
    const item = queue.find(q => q.id === id);
    if (item) {
      document.getElementById('fmtBadge').textContent = item.targetExt.toUpperCase();
      ws.load(URL.createObjectURL(item.file));
      updateTplPreview();
    }
  }

  /* ── Form binding ── */
  const fields = ['title', 'artist', 'albumartist', 'album', 'year', 'track', 'genre', 'lyrics', 'comment'];
  fields.forEach(f => {
    document.getElementById('f-' + f).addEventListener('input', e => {
      const item = queue.find(q => q.id === activeId);
      if (item) { item.tags[f] = e.target.value; updateTplPreview(); if (f === 'title' || f === 'artist') renderQueue(); }
    });
  });
  document.getElementById('f-explicit').addEventListener('change', e => {
    const item = queue.find(q => q.id === activeId);
    if (item) item.tags.explicit = e.target.checked;
  });

  function loadForm(id) {
    const item = queue.find(q => q.id === id);
    if (!item) return;
    fields.forEach(f => document.getElementById('f-' + f).value = item.tags[f]);
    document.getElementById('f-explicit').checked = item.tags.explicit;
    if (item.coverFile) {
      coverImg.src = URL.createObjectURL(item.coverFile); coverImg.classList.add('show'); coverPh.classList.add('hide');
    } else {
      coverImg.src = ''; coverImg.classList.remove('show'); coverPh.classList.remove('hide');
    }
  }

  /* ── Cover & Lyrics ── */
  document.getElementById('coverZone').addEventListener('drop', e => {
    e.preventDefault(); if (!activeId) return;
    const f = e.dataTransfer.files[0]; if (f && f.type.startsWith('image/')) handleNewCover(f);
  });
  document.getElementById('coverInput').addEventListener('change', e => { if (activeId) handleNewCover(e.target.files[0]); });

  function handleNewCover(file) {
    const item = queue.find(q => q.id === activeId);
    item.coverFile = file; item.newCoverAdded = true;
    const r = new FileReader(); r.onload = e => { item.coverBuffer = e.target.result; loadForm(activeId); };
    r.readAsArrayBuffer(file);
  }

  window.applyToAll = function(field) {
    if (!activeId) return;
    const src = queue.find(q => q.id === activeId);
    queue.forEach(item => {
      if (field === 'cover') { item.coverFile = src.coverFile; item.coverBuffer = src.coverBuffer; item.newCoverAdded = src.newCoverAdded; }
      else { item.tags[field] = src.tags[field]; }
    });
    showToast(`Applied ${field} to all tracks`);
  }

  window.fetchLyrics = async function() {
    const item = queue.find(q => q.id === activeId);
    if (!item || !item.tags.artist || !item.tags.title) { showToast('Fill in Artist and Title first'); return; }
    const btn = document.getElementById('fetchLyricsBtn'); btn.textContent = 'Fetching…';
    try {
      const res = await fetch(`https://lrclib.net/api/get?artist_name=${encodeURIComponent(item.tags.artist)}&track_name=${encodeURIComponent(item.tags.title)}`);
      if(res.ok) {
        const data = await res.json(); const lyrics = data.plainLyrics || data.syncedLyrics;
        if(lyrics) { item.tags.lyrics = lyrics; document.getElementById('f-lyrics').value = lyrics; showToast('Lyrics synced!'); }
        else { showToast('No lyrics found'); }
      } else { showToast('Not found in database'); }
    } catch(e) { showToast('Network error'); }
    btn.textContent = '⤓ Auto-fetch';
  }

  /* ── M4A Explicit patcher ── */
  function injectExplicitTag(buffer) {
    const uint8 = new Uint8Array(buffer); const view = new DataView(buffer);
    let offset = 0, moovOffset = -1, moovSize = 0, mdatOffset = -1;
    while (offset < buffer.byteLength) {
      const size = view.getUint32(offset); if (size === 0) break;
      const type = String.fromCharCode(uint8[offset+4], uint8[offset+5], uint8[offset+6], uint8[offset+7]);
      if (type === 'moov') { moovOffset = offset; moovSize = size; }
      if (type === 'mdat') { mdatOffset = offset; }
      offset += size;
    }
    if (moovOffset === -1 || (mdatOffset > moovOffset)) return buffer;
    const findAtom = (start, length, target) => {
      let o = start;
      while (o < start + length) {
        const s = view.getUint32(o); if (s === 0) break;
        if (String.fromCharCode(uint8[o+4], uint8[o+5], uint8[o+6], uint8[o+7]) === target) return { off: o, sz: s };
        o += s;
      } return null;
    };
    const udta = findAtom(moovOffset + 8, moovSize - 8, 'udta'); if (!udta) return buffer;
    const meta = findAtom(udta.off + 8, udta.sz - 8, 'meta'); if (!meta) return buffer;
    const ilst = findAtom(meta.off + 12, meta.sz - 12, 'ilst'); if (!ilst) return buffer;
    const rtngBytes = new Uint8Array([0x00,0x00,0x00,0x19,0x72,0x74,0x6e,0x67,0x00,0x00,0x00,0x11,0x64,0x61,0x74,0x61,0x00,0x00,0x00,0x15,0x00,0x00,0x00,0x00,0x01]);
    const insertPos = ilst.off + ilst.sz;
    const newBuf = new ArrayBuffer(buffer.byteLength + 25);
    const n8 = new Uint8Array(newBuf); const nV = new DataView(newBuf);
    n8.set(new Uint8Array(buffer, 0, insertPos), 0);
    n8.set(rtngBytes, insertPos);
    n8.set(new Uint8Array(buffer, insertPos), insertPos + 25);
    nV.setUint32(moovOffset, moovSize + 25); nV.setUint32(udta.off, udta.sz + 25);
    nV.setUint32(meta.off, meta.sz + 25); nV.setUint32(ilst.off, ilst.sz + 25);
    return newBuf;
  }

  /* ── Filename template ── */
  const DEFAULT_TEMPLATE = '{track} - {artist} - {title}';

  function buildFilename(item, template) {
    const t = item.tags;
    // If no artist/title, fall back to original filename
    if (!t.artist && !t.title) return item.originalName;
    const trk = t.track ? String(t.track).padStart(2, '0') : '';
    let name = (template || DEFAULT_TEMPLATE)
      .replace(/\{track\}/g, trk)
      .replace(/\{title\}/g, t.title || '')
      .replace(/\{artist\}/g, t.artist || '')
      .replace(/\{album\}/g, t.album || '')
      .replace(/\{year\}/g, t.year || '')
      .replace(/\{genre\}/g, t.genre || '');
    // Clean up leading/trailing separators that appear when tokens are empty
    name = name.replace(/^[\s\-–_.]+|[\s\-–_.]+$/g, '').replace(/\s{2,}/g, ' ').trim();
    if (!name) name = item.originalName.replace(/\.[^.]+$/, '');
    return (name + '.' + item.targetExt).replace(/[\\/:*?"<>|]/g, '');
  }

  function updateTplPreview() {
    const item = queue.find(q => q.id === activeId);
    if (!item) { tplPreview.textContent = '— no file selected —'; return; }
    tplExt.textContent = '.' + item.targetExt;
    tplPreview.textContent = buildFilename(item, tplInput.value);
  }

  tplInput.addEventListener('input', updateTplPreview);

  window.insertToken = function(token) {
    const start = tplInput.selectionStart, end = tplInput.selectionEnd;
    tplInput.value = tplInput.value.slice(0, start) + token + tplInput.value.slice(end);
    tplInput.selectionStart = tplInput.selectionEnd = start + token.length;
    tplInput.focus();
    updateTplPreview();
  };

  window.resetTemplate = function() {
    tplInput.value = DEFAULT_TEMPLATE;
    updateTplPreview();
    showToast('Template reset');
  };

  /* ── Core item processor — returns { blob, name } ── */
  async function processItem(item, cropArgs, isCropped) {
    const outName = buildFilename(item, tplInput.value);

    if (item.targetExt === 'mp3') {
      if (item.ext !== 'mp3' || isCropped) {
        const { fetchFile } = window.FFmpegUtil;
        await ffmpeg.writeFile('in.file', await fetchFile(item.file));
        let args = ['-i', 'in.file', ...cropArgs, '-map', '0:a:0'];
        if (item.ext !== 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', '2');
        else args.push('-c:a', 'copy');
        args.push('out.mp3');
        await ffmpeg.exec(args);
        const data = await ffmpeg.readFile('out.mp3');
        item.buffer = data.buffer;
        try { await ffmpeg.deleteFile('in.file'); await ffmpeg.deleteFile('out.mp3'); } catch(e){}
      }
      if (item.buffer) {
        const w = new ID3Writer(item.buffer);
        if (item.tags.title) w.setFrame('TIT2', item.tags.title);
        if (item.tags.artist) w.setFrame('TPE1', [item.tags.artist]);
        if (item.tags.albumartist) w.setFrame('TPE2', item.tags.albumartist);
        if (item.tags.album) w.setFrame('TALB', item.tags.album);
        if (item.tags.year) w.setFrame('TYER', parseInt(item.tags.year));
        if (item.tags.track) w.setFrame('TRCK', item.tags.track);
        if (item.tags.genre) w.setFrame('TCON', [item.tags.genre]);
        if (item.tags.comment) w.setFrame('COMM', { description: '', text: item.tags.comment, language: 'eng' });
        if (item.tags.lyrics) w.setFrame('USLT', { description: '', lyrics: item.tags.lyrics, language: 'eng' });
        if (item.tags.explicit) w.setFrame('TXXX', { description: 'ITUNESADVISORY', value: '1' });
        if (item.coverBuffer) w.setFrame('APIC', { type: 3, data: item.coverBuffer, description: 'Cover', useUnicodeEncoding: false });
        w.addTag();
        return { blob: w.getBlob(), name: outName };
      }
    } else if (item.targetExt === 'm4a' && ffmpegLoaded) {
      try {
        const { fetchFile } = window.FFmpegUtil;
        await ffmpeg.writeFile('in.file', await fetchFile(item.file));
        const args = ['-i', 'in.file'];
        const injectCover = item.coverFile && (item.newCoverAdded || item.ext !== 'm4a');
        if (injectCover) {
          await ffmpeg.writeFile('cover.jpg', await fetchFile(item.coverFile));
          args.push('-i', 'cover.jpg', '-map', '0:a:0', '-map', '1:v:0', '-disposition:v:0', 'attached_pic');
        } else {
          if(item.ext === 'm4a') args.push('-map', '0');
          else args.push('-map', '0:a:0');
        }
        args.push(...cropArgs);
        const forceAlac = document.getElementById('f-bypass').checked;
        if (item.ext !== 'm4a' || forceAlac) {
          if (forceAlac) args.push('-c:a', 'alac');
          else args.push('-c:a', 'aac');
          if (injectCover || item.ext === 'm4a') args.push('-c:v', 'copy');
        } else { args.push('-c', 'copy'); }
        args.push('-f', 'ipod');
        const t = item.tags;
        if (t.title) args.push('-metadata', `title=${t.title}`);
        if (t.artist) args.push('-metadata', `artist=${t.artist}`);
        if (t.albumartist) args.push('-metadata', `album_artist=${t.albumartist}`);
        if (t.album) args.push('-metadata', `album=${t.album}`);
        if (t.year) args.push('-metadata', `date=${t.year}`);
        if (t.track) args.push('-metadata', `track=${t.track}`);
        if (t.genre) args.push('-metadata', `genre=${t.genre}`);
        if (t.comment) args.push('-metadata', `comment=${t.comment}`);
        if (t.lyrics) args.push('-metadata', `lyrics=${t.lyrics}`);
        args.push('out.m4a');
        try { await ffmpeg.exec(args); } catch(e) {}
        let data = await ffmpeg.readFile('out.m4a');
        let finalBuf = data.buffer;
        if (item.tags.explicit) finalBuf = injectExplicitTag(finalBuf);
        return { blob: new Blob([finalBuf], { type: 'audio/mp4' }), name: outName };
      } finally {
        try { await ffmpeg.deleteFile('in.file'); await ffmpeg.deleteFile('out.m4a'); } catch(e){}
        try { if (item.coverFile && (item.newCoverAdded || item.ext !== 'm4a')) await ffmpeg.deleteFile('cover.jpg'); } catch(e){}
      }
    } else {
      if (isCropped && ffmpegLoaded) {
        try {
          const { fetchFile } = window.FFmpegUtil;
          await ffmpeg.writeFile('in.file', await fetchFile(item.file));
          await ffmpeg.exec(['-i', 'in.file', ...cropArgs, '-c', 'copy', 'out.file']);
          const data = await ffmpeg.readFile('out.file');
          try { await ffmpeg.deleteFile('in.file'); await ffmpeg.deleteFile('out.file'); } catch(e){}
          return { blob: new Blob([data.buffer], { type: item.file.type }), name: outName };
        } catch(e) { return { blob: item.file, name: outName }; }
      } else {
        return { blob: item.file, name: outName };
      }
    }
    return null;
  }

  /* ── Download queue (individual files) ── */
  dlBtn.addEventListener('click', async () => {
    if (queue.length === 0) return;
    dlBtn.disabled = true; zipBtn.disabled = true;

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      dlLabel.textContent = `Processing ${i + 1} of ${queue.length}…`;
      setActive(item.id);

      const isCropped = (item.cropStart > 0 || item.cropEnd < (item.duration - 0.1));
      const cropArgs = isCropped ? ['-ss', String(item.cropStart), '-to', String(item.cropEnd)] : [];

      try {
        const result = await processItem(item, cropArgs, isCropped);
        if (result) downloadBlob(result.blob, result.name);
      } catch(e) { console.error('Error:', e); }

      await new Promise(r => setTimeout(r, 600));
    }

    dlLabel.textContent = '✓ All files exported';
    showToast('Batch complete');
    setTimeout(() => { dlBtn.disabled = false; zipBtn.disabled = false; dlLabel.textContent = 'Download all'; }, 3000);
  });

  /* ── Download as ZIP ── */
  zipBtn.addEventListener('click', async () => {
    if (queue.length === 0) return;
    dlBtn.disabled = true; zipBtn.disabled = true;
    zipBtn.textContent = '…';

    const zip = new JSZip();
    const usedNames = {};

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      dlLabel.textContent = `Packing ${i + 1} of ${queue.length}…`;
      setActive(item.id);

      const isCropped = (item.cropStart > 0 || item.cropEnd < (item.duration - 0.1));
      const cropArgs = isCropped ? ['-ss', String(item.cropStart), '-to', String(item.cropEnd)] : [];

      try {
        const result = await processItem(item, cropArgs, isCropped);
        if (result) {
          // Deduplicate filenames inside the zip
          let fname = result.name;
          if (usedNames[fname]) {
            usedNames[fname]++;
            const ext = fname.includes('.') ? '.' + fname.split('.').pop() : '';
            const base = fname.slice(0, fname.length - ext.length);
            fname = `${base} (${usedNames[result.name]})${ext}`;
          } else { usedNames[fname] = 1; }
          zip.file(fname, result.blob);
        }
      } catch(e) { console.error('ZIP Error:', e); }
    }

    dlLabel.textContent = 'Generating ZIP…';
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    downloadBlob(zipBlob, `tagged-${Date.now()}.zip`);

    showToast('ZIP ready!');
    setTimeout(() => {
      dlBtn.disabled = false; zipBtn.disabled = false;
      zipBtn.textContent = '⎗ ZIP'; dlLabel.textContent = 'Download all';
    }, 3000);
  });

  /* ── Convert Queue ── */
  /* ── Convert Queue (format picker popover) ── */
  const convertQueueMenu = document.getElementById('convertQueueMenu');
  const convertQueueBtn  = document.getElementById('convertQueueBtn');

  convertQueueBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (queue.length === 0) return;
    const rect = convertQueueBtn.getBoundingClientRect();
    let x = rect.left, y = rect.top - 4;
    const menuH = 148;
    if (y - menuH < 0) y = rect.bottom + 4;
    else y = y - menuH;
    if (x + 196 > window.innerWidth) x = window.innerWidth - 200;
    convertQueueMenu.style.left = x + 'px';
    convertQueueMenu.style.top  = y + 'px';
    convertQueueMenu.classList.toggle('open');
  });

  document.addEventListener('click', () => convertQueueMenu.classList.remove('open'));

  window.applyQueueFormat = function(fmt) {
    convertQueueMenu.classList.remove('open');
    const prev = queue.map(i => i.targetExt);
    queue.forEach(item => {
      item.targetExt = fmt === 'original' ? item.ext : fmt;
    });
    renderQueue();
    const changed = queue.filter((item, i) => item.targetExt !== prev[i]).length;
    if (activeId) { document.getElementById('fmtBadge').textContent = queue.find(q => q.id === activeId)?.targetExt.toUpperCase() || ''; updateTplPreview(); }
    showToast(fmt === 'original'
      ? `Queue reset to original formats`
      : `${changed} file${changed !== 1 ? 's' : ''} set to ${fmt.toUpperCase()}`);
  };

  function downloadBlob(blobOrFile, name) {
    const url = URL.createObjectURL(blobOrFile);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 8000);
  }

  /* ── Context Menu ── */
  let ctxTargetId = null;
  const ctxMenu = document.getElementById('ctxMenu');

  function openCtxMenu(e, itemId) {
    e.preventDefault(); e.stopPropagation();
    ctxTargetId = itemId;
    const item = queue.find(q => q.id === itemId);
    if (!item) return;
    ['ctx-mp3', 'ctx-m4a', 'ctx-orig'].forEach(id => document.getElementById(id).classList.remove('active-fmt'));
    if (item.targetExt === 'mp3') document.getElementById('ctx-mp3').classList.add('active-fmt');
    else if (item.targetExt === 'm4a') document.getElementById('ctx-m4a').classList.add('active-fmt');
    else document.getElementById('ctx-orig').classList.add('active-fmt');
    document.getElementById('ctx-orig').querySelector('.ctx-fmt').textContent = item.ext.toUpperCase();
    const menuW = 196, menuH = 196;
    let x = e.clientX, y = e.clientY;
    if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8;
    if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;
    ctxMenu.style.left = x + 'px'; ctxMenu.style.top = y + 'px';
    ctxMenu.classList.add('open');
  }

  window.ctxConvert = function(fmt) {
    const item = queue.find(q => q.id === ctxTargetId);
    if (!item) return closeCtxMenu();
    const prev = item.targetExt;
    item.targetExt = (fmt === 'original') ? item.ext : fmt;
    renderQueue();
    if (activeId === ctxTargetId) { document.getElementById('fmtBadge').textContent = item.targetExt.toUpperCase(); updateTplPreview(); }
    if (prev !== item.targetExt) showToast(`${item.originalName} → ${item.targetExt.toUpperCase()}`);
    closeCtxMenu();
  };

  window.ctxRemove = function() {
    const idx = queue.findIndex(q => q.id === ctxTargetId);
    if (idx === -1) return closeCtxMenu();
    queue.splice(idx, 1);
    if (activeId === ctxTargetId) {
      activeId = queue.length > 0 ? queue[Math.min(idx, queue.length - 1)].id : null;
      if (activeId) setActive(activeId);
    }
    renderQueue();
    if (queue.length === 0) { dlBtn.disabled = true; zipBtn.disabled = true; scUploadBtn.disabled = true; document.getElementById('convertQueueBtn').disabled = true; }
    showToast('Removed from queue');
    closeCtxMenu();
  };

  function closeCtxMenu() { ctxMenu.classList.remove('open'); ctxTargetId = null; }
  document.addEventListener('click', closeCtxMenu);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeCtxMenu(); closeCoverCtxMenu(); } });

  /* ── Cover Context Menu ── */
  const coverCtxMenu = document.getElementById('coverCtxMenu');
  function closeCoverCtxMenu() { coverCtxMenu.classList.remove('open'); }

  document.getElementById('coverZone').addEventListener('contextmenu', e => {
    const item = queue.find(q => q.id === activeId);
    if (!item || !item.coverFile) return; // no cover = nothing to remove
    e.preventDefault(); e.stopPropagation();
    const menuW = 180, menuH = 72;
    let x = e.clientX, y = e.clientY;
    if (x + menuW > window.innerWidth) x = window.innerWidth - menuW - 8;
    if (y + menuH > window.innerHeight) y = window.innerHeight - menuH - 8;
    coverCtxMenu.style.left = x + 'px'; coverCtxMenu.style.top = y + 'px';
    coverCtxMenu.classList.add('open');
  });
  document.addEventListener('click', closeCoverCtxMenu);

  window.removeCover = function() {
    const item = queue.find(q => q.id === activeId);
    if (!item) return closeCoverCtxMenu();
    item.coverFile = null; item.coverBuffer = null; item.newCoverAdded = false;
    coverImg.src = ''; coverImg.classList.remove('show'); coverPh.classList.remove('hide');
    showToast('Cover art removed');
    closeCoverCtxMenu();
  };

  /* ══════════════════════════════════════════════════════════════
     Panel modals (settings / search / preview) — share the existing backdrop
     ══════════════════════════════════════════════════════════════ */
  function openPanel(id) {
    document.getElementById('modalBackdrop').style.display = 'block';
    document.getElementById(id).classList.add('open');
  }
  window.closePanel = function(id) {
    document.getElementById(id).classList.remove('open');
    const stillOpen = document.querySelector('.panel-modal.open');
    const convertOpen = document.getElementById('convertModal').style.display === 'flex';
    if (!stillOpen && !convertOpen) document.getElementById('modalBackdrop').style.display = 'none';
  };
  document.getElementById('modalBackdrop').addEventListener('click', () => {
    document.querySelectorAll('.panel-modal.open').forEach(p => closePanel(p.id));
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') document.querySelectorAll('.panel-modal.open').forEach(p => closePanel(p.id));
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  }

  /* ══════════════════════════════════════════════════════════════
     Settings (Last.fm API key / SoundCloud OAuth token) — kept in localStorage only
     ══════════════════════════════════════════════════════════════ */
  function loadSettings() {
    document.getElementById('lastfmKeyInput').value = localStorage.getItem('lastfmKey') || '';
    document.getElementById('soundcloudTokenInput').value = localStorage.getItem('soundcloudToken') || '';
  }
  window.saveSettings = function() {
    localStorage.setItem('lastfmKey', document.getElementById('lastfmKeyInput').value.trim());
    localStorage.setItem('soundcloudToken', document.getElementById('soundcloudTokenInput').value.trim());
    showToast('Settings saved');
    closePanel('settingsModal');
  };
  document.getElementById('settingsBtn').addEventListener('click', () => { loadSettings(); openPanel('settingsModal'); });

  /* ══════════════════════════════════════════════════════════════
     JSONP helper — Apple/iTunes and Last.fm both support ?callback=,
     which sidesteps CORS entirely (unlike a plain fetch to either host)
     ══════════════════════════════════════════════════════════════ */
  let jsonpSeq = 0;
  function jsonp(url) {
    return new Promise((resolve, reject) => {
      const cbName = '__jsonp_cb_' + (jsonpSeq++) + '_' + Date.now();
      const script = document.createElement('script');
      const cleanup = () => { delete window[cbName]; script.remove(); };
      const timer = setTimeout(() => { cleanup(); reject(new Error('JSONP timeout')); }, 9000);
      window[cbName] = data => { clearTimeout(timer); cleanup(); resolve(data); };
      script.onerror = () => { clearTimeout(timer); cleanup(); reject(new Error('JSONP load error')); };
      script.src = url + (url.includes('?') ? '&' : '?') + 'callback=' + cbName;
      document.body.appendChild(script);
    });
  }

  async function searchItunesTracks(term) {
    try {
      const data = await jsonp(`https://itunes.apple.com/search?media=music&entity=song&limit=8&term=${encodeURIComponent(term)}`);
      return (data.results || []).map(r => ({
        source: 'Apple Music', title: r.trackName || '', artist: r.artistName || '',
        album: r.collectionName || '', year: r.releaseDate ? r.releaseDate.slice(0, 4) : '',
        genre: r.primaryGenreName || '', track: r.trackNumber || '',
        artwork: r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '600x600bb') : ''
      }));
    } catch (e) { return []; }
  }

  async function searchLastfmTracks(term) {
    const key = localStorage.getItem('lastfmKey');
    if (!key) return [];
    try {
      const data = await jsonp(`https://ws.audioscrobbler.com/2.0/?method=track.search&track=${encodeURIComponent(term)}&api_key=${key}&format=json`);
      const raw = data?.results?.trackmatches?.track || [];
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr.slice(0, 8).map(t => {
        const img = Array.isArray(t.image) ? (t.image.find(i => i.size === 'extralarge') || t.image[t.image.length - 1]) : null;
        return { source: 'Last.fm', title: t.name || '', artist: t.artist || '', album: '', year: '', genre: '', track: '', artwork: img?.['#text'] || '' };
      });
    } catch (e) { return []; }
  }

  async function searchItunesArt(term) {
    try {
      const data = await jsonp(`https://itunes.apple.com/search?media=music&entity=album&limit=8&term=${encodeURIComponent(term)}`);
      return (data.results || [])
        .map(r => ({ source: 'Apple Music', artwork: r.artworkUrl100 ? r.artworkUrl100.replace('100x100bb', '1200x1200bb') : '' }))
        .filter(r => r.artwork);
    } catch (e) { return []; }
  }

  async function searchLastfmArt(term) {
    const key = localStorage.getItem('lastfmKey');
    if (!key) return [];
    try {
      const data = await jsonp(`https://ws.audioscrobbler.com/2.0/?method=album.search&album=${encodeURIComponent(term)}&api_key=${key}&format=json`);
      const raw = data?.results?.albummatches?.album || [];
      const arr = Array.isArray(raw) ? raw : [raw];
      return arr.map(a => {
        const img = Array.isArray(a.image) ? (a.image.find(i => i.size === 'extralarge') || a.image[a.image.length - 1]) : null;
        return { source: 'Last.fm', artwork: img?.['#text'] || '' };
      }).filter(a => a.artwork);
    } catch (e) { return []; }
  }

  async function urlToCoverFile(url) {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error('fetch failed');
    const blob = await res.blob();
    return new File([blob], 'cover.jpg', { type: blob.type || 'image/jpeg' });
  }

  async function applyCoverFileToItem(item, file) {
    item.coverFile = file; item.newCoverAdded = true;
    await new Promise(resolve => {
      const fr = new FileReader();
      fr.onload = e => { item.coverBuffer = e.target.result; resolve(); };
      fr.readAsArrayBuffer(file);
    });
    if (activeId === item.id) loadForm(activeId);
  }

  /* ── Find track (Apple Music + Last.fm) ── */
  const trackSearchBtn = document.getElementById('trackSearchBtn');
  const searchModal = document.getElementById('searchModal');
  const searchQueryInput = document.getElementById('searchQueryInput');
  const searchGoBtn = document.getElementById('searchGoBtn');
  const searchResults = document.getElementById('searchResults');

  trackSearchBtn.addEventListener('click', () => {
    const item = queue.find(q => q.id === activeId);
    if (!item) { showToast('Select a track in the queue first'); return; }
    const seed = [item.tags.artist, item.tags.title].filter(Boolean).join(' ') || item.originalName.replace(/\.[^.]+$/, '');
    searchQueryInput.value = seed;
    searchResults.innerHTML = '<div class="result-empty">Search Apple Music &amp; Last.fm, then pick a match to fill in the fields.</div>';
    openPanel('searchModal');
    searchQueryInput.focus();
  });
  searchGoBtn.addEventListener('click', runTrackSearch);
  searchQueryInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runTrackSearch(); } });

  async function runTrackSearch() {
    const q = searchQueryInput.value.trim();
    if (!q) return;
    searchGoBtn.disabled = true; searchGoBtn.textContent = '…';
    searchResults.innerHTML = '<div class="result-empty">Searching…</div>';
    const [apple, lastfm] = await Promise.all([searchItunesTracks(q), searchLastfmTracks(q)]);
    const results = [...apple, ...lastfm];
    searchGoBtn.disabled = false; searchGoBtn.textContent = 'Search';
    if (!results.length) {
      const key = localStorage.getItem('lastfmKey');
      searchResults.innerHTML = `<div class="result-empty">No matches found.${key ? '' : ' Add a Last.fm API key in Settings for more results.'}</div>`;
      return;
    }
    searchResults.innerHTML = '';
    results.forEach(r => {
      const b = document.createElement('button');
      b.className = 'result-item';
      b.innerHTML = `${r.artwork ? `<img src="${r.artwork}" alt="">` : `<span style="width:40px;height:40px;border-radius:2px;background:var(--surface2);border:1px solid var(--border);flex-shrink:0;display:inline-block;"></span>`}<span class="r-text"><span class="r-title">${escapeHtml(r.title || '—')}</span><br><span class="r-sub">${escapeHtml(r.artist || '')}${r.album ? ' — ' + escapeHtml(r.album) : ''}</span></span><span class="r-badge">${r.source}</span>`;
      b.onclick = () => applySearchResult(r);
      searchResults.appendChild(b);
    });
  }

  async function applySearchResult(r) {
    const item = queue.find(q => q.id === activeId);
    if (!item) return;
    if (r.title) item.tags.title = r.title;
    if (r.artist) item.tags.artist = r.artist;
    if (r.album) item.tags.album = r.album;
    if (r.year) item.tags.year = r.year;
    if (r.genre) item.tags.genre = r.genre;
    loadForm(item.id); updateTplPreview();
    closePanel('searchModal');
    showToast(`Filled in from ${r.source}`);
    if (r.artwork) {
      try { await applyCoverFileToItem(item, await urlToCoverFile(r.artwork)); }
      catch (e) { showToast('Metadata applied — artwork could not be downloaded automatically'); }
    }
  }

  /* ── Find cover art (Apple Music + Last.fm) ── */
  const coverSearchBtn = document.getElementById('coverSearchBtn');
  const coverQueryInput = document.getElementById('coverQueryInput');
  const coverSearchGoBtn = document.getElementById('coverSearchGoBtn');
  const coverResults = document.getElementById('coverResults');

  coverSearchBtn.addEventListener('click', () => {
    const item = queue.find(q => q.id === activeId);
    if (!item) { showToast('Select a track in the queue first'); return; }
    const seed = [item.tags.artist, item.tags.album || item.tags.title].filter(Boolean).join(' ') || item.originalName.replace(/\.[^.]+$/, '');
    coverQueryInput.value = seed;
    coverResults.innerHTML = '<div class="result-empty" style="grid-column:1/-1;">Search Apple Music &amp; Last.fm for artwork.</div>';
    openPanel('coverSearchModal');
    coverQueryInput.focus();
  });
  coverSearchGoBtn.addEventListener('click', runCoverSearch);
  coverQueryInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); runCoverSearch(); } });

  async function runCoverSearch() {
    const q = coverQueryInput.value.trim();
    if (!q) return;
    coverSearchGoBtn.disabled = true; coverSearchGoBtn.textContent = '…';
    coverResults.innerHTML = '<div class="result-empty" style="grid-column:1/-1;">Searching…</div>';
    const [apple, lastfm] = await Promise.all([searchItunesArt(q), searchLastfmArt(q)]);
    const results = [...apple, ...lastfm];
    coverSearchGoBtn.disabled = false; coverSearchGoBtn.textContent = 'Search';
    if (!results.length) {
      const key = localStorage.getItem('lastfmKey');
      coverResults.innerHTML = `<div class="result-empty" style="grid-column:1/-1;">No artwork found.${key ? '' : ' Add a Last.fm API key in Settings for more results.'}</div>`;
      return;
    }
    coverResults.innerHTML = '';
    results.forEach(r => {
      const b = document.createElement('button');
      b.innerHTML = `<img src="${r.artwork}" alt=""><span class="src-tag">${r.source}</span>`;
      b.onclick = () => applyCoverResult(r);
      coverResults.appendChild(b);
    });
  }

  async function applyCoverResult(r) {
    const item = queue.find(q => q.id === activeId);
    if (!item) return;
    try {
      await applyCoverFileToItem(item, await urlToCoverFile(r.artwork));
      showToast('Cover art applied');
      closePanel('coverSearchModal');
    } catch (e) { showToast('Could not download this artwork — try another result'); }
  }

  /* ══════════════════════════════════════════════════════════════
     Lyrics — multiple sources: LRCLIB + Lyrics.ovh auto-fetch,
     Genius + Musixmatch open as manual search (no key-free full-lyrics
     API exists for either, so we open a prefilled search tab instead)
     ══════════════════════════════════════════════════════════════ */
  document.getElementById('geniusSearchBtn').addEventListener('click', () => {
    const item = queue.find(q => q.id === activeId);
    const q = item ? [item.tags.artist, item.tags.title].filter(Boolean).join(' ') : '';
    if (!q) { showToast('Fill in Artist and Title first'); return; }
    window.open(`https://genius.com/search?q=${encodeURIComponent(q)}`, '_blank', 'noopener');
  });
  document.getElementById('musixmatchSearchBtn').addEventListener('click', () => {
    const item = queue.find(q => q.id === activeId);
    const q = item ? [item.tags.artist, item.tags.title].filter(Boolean).join(' ') : '';
    if (!q) { showToast('Fill in Artist and Title first'); return; }
    window.open(`https://www.musixmatch.com/search?query=${encodeURIComponent(q)}`, '_blank', 'noopener');
  });

  /* ── Preview tags ── */
  document.getElementById('previewTagsBtn').addEventListener('click', () => {
    const item = queue.find(q => q.id === activeId);
    if (!item) { showToast('Select a track in the queue first'); return; }
    const t = item.tags;
    const rows = [
      ['Title', t.title], ['Artist', t.artist], ['Album artist', t.albumartist],
      ['Album', t.album], ['Year', t.year], ['Track #', t.track], ['Genre', t.genre],
      ['Explicit', t.explicit ? 'Yes' : 'No'], ['Comment', t.comment],
      ['Lyrics', t.lyrics ? (t.lyrics.length > 240 ? t.lyrics.slice(0, 240) + '…' : t.lyrics) : '']
    ];
    document.getElementById('previewRows').innerHTML = rows.map(([k, v]) =>
      `<div class="preview-row"><span class="p-k">${k}</span><span class="p-v">${v ? escapeHtml(String(v)) : '<span style="color:var(--text-3);font-style:italic;">empty</span>'}</span></div>`
    ).join('');
    const cImg = document.getElementById('previewCoverImg');
    if (item.coverFile) { cImg.src = URL.createObjectURL(item.coverFile); cImg.style.display = 'block'; }
    else { cImg.src = ''; cImg.style.display = 'none'; }
    document.getElementById('previewFilename').textContent = '→ ' + buildFilename(item, tplInput.value);
    openPanel('previewModal');
  });

  /* ── Filename template presets ── */
  const FILENAME_PRESETS = [
    { label: 'Track – Artist – Title', value: '{track} - {artist} - {title}' },
    { label: 'Artist – Title', value: '{artist} - {title}' },
    { label: 'Title – Artist', value: '{title} - {artist}' },
    { label: 'Title only', value: '{title}' },
    { label: 'Artist – Album – Track – Title', value: '{artist} - {album} - {track} - {title}' },
    { label: 'Year – Artist – Title', value: '{year} - {artist} - {title}' },
    { label: 'Track. Title', value: '{track}. {title}' },
  ];
  const tplPresetSel = document.getElementById('tplPreset');
  FILENAME_PRESETS.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.value; opt.textContent = p.label;
    tplPresetSel.appendChild(opt);
  });
  tplPresetSel.addEventListener('change', () => {
    if (!tplPresetSel.value) return;
    tplInput.value = tplPresetSel.value;
    updateTplPreview();
    tplPresetSel.value = '';
  });

  /* ── Upload to SoundCloud ── */
  const scUploadBtn = document.getElementById('scUploadBtn');
  scUploadBtn.addEventListener('click', async () => {
    const item = queue.find(q => q.id === activeId);
    if (!item) { showToast('Select a track in the queue first'); return; }
    const token = localStorage.getItem('soundcloudToken');
    if (!token) { showToast('Add a SoundCloud OAuth token in Settings first'); loadSettings(); openPanel('settingsModal'); return; }
    const orig = scUploadBtn.textContent;
    scUploadBtn.disabled = true; scUploadBtn.textContent = '☁ Preparing…';
    try {
      const isCropped = (item.cropStart > 0 || item.cropEnd < (item.duration - 0.1));
      const cropArgs = isCropped ? ['-ss', String(item.cropStart), '-to', String(item.cropEnd)] : [];
      const result = await processItem(item, cropArgs, isCropped);
      if (!result) throw new Error('Could not process file');
      scUploadBtn.textContent = '☁ Uploading…';
      const fd = new FormData();
      fd.append('track[title]', item.tags.title || item.originalName.replace(/\.[^.]+$/, ''));
      if (item.tags.genre) fd.append('track[genre]', item.tags.genre);
      if (item.tags.comment) fd.append('track[description]', item.tags.comment);
      fd.append('track[asset_data]', result.blob, result.name);
      const res = await fetch('https://api.soundcloud.com/tracks', {
        method: 'POST', headers: { 'Authorization': `OAuth ${token}` }, body: fd
      });
      if (!res.ok) throw new Error(`SoundCloud responded with ${res.status}`);
      showToast('Uploaded to SoundCloud!');
    } catch (e) {
      console.error('SoundCloud upload error:', e);
      showToast('Upload failed — check your token in Settings (see console for details)');
    } finally {
      scUploadBtn.disabled = false; scUploadBtn.textContent = orig;
    }
  });

  /* ══════════════════════════════════════════════════════════════
     Desktop extras: native menu actions, keyboard, context menu
     ══════════════════════════════════════════════════════════════ */
  document.getElementById('addBtn').addEventListener('click', () => document.getElementById('audioInput').click());
  document.getElementById('emptyAddBtn').addEventListener('click', () => document.getElementById('audioInput').click());

  if (window.tagApp) {
    window.tagApp.onMenu(action => {
      if (action === 'add') document.getElementById('audioInput').click();
      else if (action === 'export') dlBtn.click();
      else if (action === 'zip') zipBtn.click();
      else if (action === 'settings') document.getElementById('settingsBtn').click();
      else if (action === 'find') trackSearchBtn.click();
      else if (action === 'preview') document.getElementById('previewTagsBtn').click();
      else if (action === 'cover') coverSearchBtn.click();
    });
  }

  document.addEventListener('keydown', e => {
    const tag = (e.target.tagName || '').toLowerCase();
    const typing = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.panel-modal.open')) return;
    if (e.code === 'Space') { e.preventDefault(); ws.playPause(); }
    else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && queue.length) {
      e.preventDefault();
      const i = queue.findIndex(q => q.id === activeId);
      const n = e.key === 'ArrowDown' ? Math.min(queue.length - 1, i + 1) : Math.max(0, i - 1);
      if (queue[n]) setActive(queue[n].id);
    }
  });

  // App-like behaviour: no browser context menu except in text fields and the queue
  document.addEventListener('contextmenu', e => {
    if (!e.target.closest('input, textarea')) e.preventDefault();
  });
