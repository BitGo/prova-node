var ProvaNode = require('./node');
const Promise = require('bluebird');
const co = Promise.coroutine;
const prova = require('prova');
const provaAdmin = require('prova-admin');

const rootThreadTest = co(function *(node) {
  node = node || new ProvaNode('localhost', 18334, 'user', 'pass');



});

module.exports = {
  rootThreadTest: rootThreadTest
};



