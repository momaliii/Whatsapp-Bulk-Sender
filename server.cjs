/**
 * CommonJS wrapper for Hostinger LiteSpeed (lsnode).
 * lsnode uses require() which cannot load ES Modules.
 * The 'esm' package enables require() of ESM (including top-level await).
 */
process.env.LSNODE = '1';
require = require('esm')(module);
module.exports = require('./server/index.js').app;
