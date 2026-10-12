// Copies browser libraries out of node_modules into src/vendor so the app works fully offline.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const nm = (...p) => path.join(root, 'node_modules', ...p);
const out = (...p) => path.join(root, 'src', 'vendor', ...p);

const copies = [
  [nm('@ffmpeg/ffmpeg/dist/umd/ffmpeg.js'), out('ffmpeg/ffmpeg.js')],
  [nm('@ffmpeg/ffmpeg/dist/umd/814.ffmpeg.js'), out('ffmpeg/814.ffmpeg.js')],
  [nm('@ffmpeg/core/dist/umd/ffmpeg-core.js'), out('ffmpeg/ffmpeg-core.js')],
  [nm('@ffmpeg/core/dist/umd/ffmpeg-core.wasm'), out('ffmpeg/ffmpeg-core.wasm')],
  [nm('@ffmpeg/util/dist/umd/index.js'), out('ffmpeg/util.js')],
  [nm('jszip/dist/jszip.min.js'), out('jszip.min.js')],
  [nm('jsmediatags/dist/jsmediatags.min.js'), out('jsmediatags.min.js')],
  [nm('browser-id3-writer/dist/browser-id3-writer.js'), out('browser-id3-writer.js')],
  [nm('wavesurfer.js/dist/wavesurfer.min.js'), out('wavesurfer.min.js')],
  [nm('wavesurfer.js/dist/plugins/regions.min.js'), out('regions.min.js')],
];

for (const [from, to] of copies) {
  if (!fs.existsSync(from)) { console.error('Missing: ' + from); process.exit(1); }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
console.log('Vendored ' + copies.length + ' files into src/vendor');
