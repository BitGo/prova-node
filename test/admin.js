const ProvaNode = require('../src/node');
const Promise = require('bluebird');
const co = Promise.coroutine;
const prova = require('prova');
const provaAdmin = require('prova-admin');
const should = require('should');
const crypto = require('crypto');

var rootKeys = ["eaf02ca348c524e6392655ba4d29603cd1a7347d9d65cfe93ce1ebffdca22694", "2b8c52b77b327c755b9b375500d3f4b2da9b0a1ff65f6891d311fe94295bc26a"].map(function(hex) {
  return prova.ECPair.fromPrivateKeyBuffer(new Buffer(hex, 'hex'), prova.networks.rmgTest);
});

let node;

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

describe('Admin Transactions', () => {

  before(function() {
    node = new ProvaNode('localhost', 18334, 'user', 'pass');
  });

  describe('Root Thread', () => {

    it('should fail without thread output', co(function *() {
      const badTx = yield makeAdminTx(node, 0, rootKeys, function(builder) {
        builder.tx.outs.shift(); // remove first output
      });
      try {
        yield node.sendrawtransaction(badTx.build().toHex());
        throw new Error('should not reach');
      } catch (e) {
        e.message.should.equal('Transaction has no outputs');
      }
    }));

    it('should fail without any operations', co(function *() {
      const tx = yield makeAdminTx(node, 0, rootKeys);
      try {
        yield node.sendrawtransaction(tx.build().toHex());
        throw new Error('should not reach');
      } catch (e) {
        e.message.should.equal('TX rejected: admin transaction with no admin operations.');
      }
    }));

  });
});
