var ProvaNode = require('./node');
const Promise = require('bluebird');
const co = Promise.coroutine;
const prova = require('prova');
const provaAdmin = require('prova-admin');
const should = require('should');

var KEYS = ["eaf02ca348c524e6392655ba4d29603cd1a7347d9d65cfe93ce1ebffdca22694", "2b8c52b77b327c755b9b375500d3f4b2da9b0a1ff65f6891d311fe94295bc26a"];
var rootKeys = ["eaf02ca348c524e6392655ba4d29603cd1a7347d9d65cfe93ce1ebffdca22694", "2b8c52b77b327c755b9b375500d3f4b2da9b0a1ff65f6891d311fe94295bc26a"].map(function(hex) {
  return prova.ECPair.fromPrivateKeyBuffer(new Buffer(hex, 'hex'), prova.networks.rmgTest);
});

const adminThreadScript = function(threadId) {
  return new Buffer('0' + threadId + 'bb', 'hex');
};

const makeAdminTx = co(function *(node, threadId, signingKeys, munge) {
  const threadTip = yield node.getThreadTip(threadId);
  var builder = new prova.TransactionBuilder(prova.networks.rmgTest);
  builder.addInput(threadTip.txid, threadTip.vout);
  const script = adminThreadScript(threadId);
  builder.addOutput(script, 0);

  if (munge) {
    munge(builder);
  }

  signingKeys.forEach(function(key) {
    builder.sign(0, key, script, 0);
  });

  return builder;
});

const rootThreadTest = co(function *(node) {
  node = node || new ProvaNode('localhost', 18334, 'user', 'pass');

  const badTx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
    builder.tx.outs.shift(); // remove first output
  });
  try {
    yield node.sendrawtransaction(badTx.build().toHex());
    throw new Error('should not reach');
  } catch (e) {
    e.message.should.equal('Transaction has no outputs');
  }
});

module.exports = {
  rootThreadTest: rootThreadTest
};




// pubkeys.forEach(function(pubkey) {
//   const operation = prova.ADMIN.OPERATIONS.ADD_KEY;
//   const keyType = prova.ADMIN.KEY_TYPES.ROOT.PROVISIONING_KEY;
//   const publicKey = prova.ECPair.fromPublicKeyBuffer(new Buffer(pubkey, 'hex'));
//   builder.addKeyUpdateOutput(operation, keyType, publicKey);
// });
