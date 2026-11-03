const fs = require('node:fs');
const path = require('node:path');
// Keep the preceding valid JSON as a recovery copy. Write the new state first,
// then atomically rename on the same volume; an interrupted write keeps current.
function rigStore(directory) {
  const current = path.join(directory, 'calibration.json');
  const previous = path.join(directory, 'calibration.previous.json');
  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
  return {
    read: () => ({ current: read(current), previous: read(previous) }),
    save(text) {
      if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024) throw Error('Invalid calibration size');
      const rig = JSON.parse(text);
      if (rig?.version !== 1 || rig.outputs?.length !== 3) throw Error('Invalid calibration');
      fs.mkdirSync(directory, { recursive: true });
      const old = read(current);
      if (old === text) return;
      fs.writeFileSync(current + '.tmp', text);
      // Do not replace the recovery copy with corrupt data after a disk error.
      if (old) { try { const prior=JSON.parse(old); if(prior?.version===1 && prior.outputs?.length===3) fs.writeFileSync(previous, old); } catch {} }
      fs.renameSync(current + '.tmp', current);
    }
  };
}
module.exports = { rigStore };
