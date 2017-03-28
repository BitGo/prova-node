const rpc = require('json-rpc2');
const Promise = require('bluebird');
const co = Promise.coroutine;
const Q = require('q');

class ProvaNode {

  constructor(host, port, username, password) {
    this.host = host;
    this.port = port;
    this.client = rpc.Client.$create(port, host, username, password);
  }

  callRPC(cmd, args) {
    args = args || [];
    return Q.nbind(this.client.call, this.client)(cmd, args, { https: true, rejectUnauthorized: false });
  }
}

const methods = [
  'addnode',
  'createrawtransaction',
  'debuglevel',
  'decoderawtransaction',
  'decodescript',
  'generate',
  'getaddednodeinfo',
  'getaddresstxids',
  'getadmininfo',
  'getbestblock',
  'getbestblockhash',
  'getblock',
  'getblockcount',
  'getblockhash',
  'getblockheader',
  'getblocktemplate',
  'getconnectioncount',
  'getcurrentnet',
  'getdifficulty',
  'getgenerate',
  'gethashespersec',
  'getinfo',
  'getmempoolinfo',
  'getmininginfo',
  'getnettotals',
  'getnetworkhashps',
  'getpeerinfo',
  'getrawmempool',
  'getrawtransaction',
  'gettxout',
  'getwork',
  'help',
  'node',
  'ping',
  'searchrawtransactions',
  'sendrawtransaction',
  'setgenerate',
  'setvalidatekeys',
  'stop',
  'submitblock',
  'validateaddress',
  'verifychain',
  'verifymessage'
];

methods.forEach(function(method) {
  ProvaNode.prototype[method] = function() {
    return this.callRPC(method, Array.prototype.slice.call(arguments));
  };
});

ProvaNode.prototype.getThreadTip = co(function *(threadId) {
  const adminInfo = yield this.getadmininfo();
  var parts = adminInfo.threadtips[threadId].outpoint.split(':');
  return {
    txid: parts[0],
    vout: Number(parts[1])
  };
});

module.exports = ProvaNode;
