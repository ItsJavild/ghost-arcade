const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rigStore } = require('./rig-store.cjs');
test('desktop calibration survives restart, preserves previous state, and rejects invalid writes', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mapper-rig-'));
  try {
    const store=rigStore(dir), a=JSON.stringify({version:1,outputs:[1,2,3],overlap:100}), b=JSON.stringify({version:1,outputs:[1,2,3],overlap:200});
    assert.deepEqual(store.read(),{current:null,previous:null});store.save(a);store.save(b);store.save(b);
    assert.deepEqual(rigStore(dir).read(),{current:b,previous:a});
    assert.throws(()=>store.save('broken'));assert.equal(store.read().current,b);
    fs.writeFileSync(path.join(dir,'calibration.json'),'broken');assert.equal(store.read().previous,a);
    store.save(b);assert.equal(store.read().previous,a);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
