const fs = require('node:fs');
if (process.platform !== 'win32' || process.arch !== 'x64') throw Error('Package on Windows x64.');
if (!fs.existsSync('native/build/Release/ndi_receiver.node')) throw Error('NDI bridge missing. Install the standard NDI SDK and run npm run native:build first.');
require('../native/build/Release/ndi_receiver.node').initialize();
console.log('NDI bridge and runtime initialized.');
