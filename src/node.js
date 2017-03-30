const rpc = require('json-rpc2');
const Promise = require('bluebird');
const co = Promise.coroutine;
const Q = require('q');
const spawn = require('child_process').spawn;
const execAsync = Promise.promisify(require('child_process').exec);
const cuid = require('cuid');
const fs = require('fs');
const util = require('util');
const prova = require('prova');

class ProvaNode {

  constructor({host, rpcport, username, password}) {
    this.host = host;
    this.rpcport = rpcport;
    this.username = username;
    this.password = password;
    this.client = rpc.Client.$create(rpcport, host, username, password);
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

ProvaNode.prototype.getCoinbaseTx = co(function *(blocksAgo) {
  const info = yield this.getinfo();
  const height = info.blocks;
  const blockhash = yield this.getblockhash(height - blocksAgo);
  const block = yield this.getblock(blockhash, true);
  const txid = block.tx[0];
  const tx = yield this.getrawtransaction(txid, 1);
  return tx;
});

class ProvaTestNode extends ProvaNode {

  constructor({ port }) {
    super({
      host: '127.0.0.1',
      rpcport: port + 10000,
      username: 'test',
      password: 'test'
    });
    this.port = port;

    this.addressKey = prova.ECPair.makeRandom(prova.networks.rmgTest);
    this.miningAddress = new prova.Address(this.addressKey.getPublicKeyBuffer(), 1, 2, prova.networks.rmgTest);

    this.validateKeys = [
      '4015289a228658047520f0d0abe7ad49abc77f6be0be63b36b94b83c2d1fd977',
      '9ade85268e57b7c97af9f84e0d5d96138eae2b1d7ae96c5ab849f58551ab9147',
      'a959753ab5aeb59d7184ba37f6b219492bcb137bb992418590a40fd4ef9facdd',
      'c345ff4a207ed945ac3040a933f386676e9c034f261ad4306f8b34d828eecde6'
    ];
    this.datadir = '/tmp/prova-' + cuid();
  }

}

ProvaTestNode.prototype.start = co(function *() {
  fs.mkdirSync(this.datadir);
  const args = [
    '--regtest',
    '--txindex',
    util.format('--miningaddr=%s', this.miningAddress.toString()),
    util.format('--listen=%s:%s', this.host, this.port),
    util.format('--rpcuser=%s', this.username),
    util.format('--rpcpass=%s', this.password),
    util.format('--rpclisten=%s:%s', this.host, this.rpcport),
    util.format('--datadir=%s', this.datadir)
  ];
  this.proc = spawn('prova', args);

  this.proc.stderr.on('data', (data) => {
    // console.log(`stderr: ${data}`);
  });

  this.proc.stdout.on('data', (data) => {
    // console.log(`stdout: ${data}`);
  });

  this.proc.on('close', (code) => {
    this.done = true;
    // console.log(`child prova process on port ${this.port} exited with code ${code}`);
  });

  // Wait for RPC server to start
  while (true) {
    yield Promise.delay(100);
    try {
      yield this.getinfo();
      break;
    } catch (e) {
    }
  }
  yield this.setvalidatekeys(this.validateKeys);
});

ProvaTestNode.prototype.waitTillDone = co(function *(shouldCleanup) {
  while (!this.done) {
    yield Promise.delay(100);
  }
  if (shouldCleanup) {
    yield execAsync('rm -rf ' + this.datadir);
  }
});

module.exports =
{
  ProvaNode: ProvaNode,
  ProvaTestNode: ProvaTestNode
};
